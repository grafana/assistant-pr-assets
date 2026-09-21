import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitBlob, githubClient, loadAssets, loadLicense, publish, sameFiles } from './publish.mjs';

const files = [{ path: 'open-chat-light.svg', sha: gitBlob(Buffer.from('<svg/>')), contents: Buffer.from('<svg/>').toString('base64') }];
const remote = files.map(file => ({ ...file, mode: '100644', type: 'blob' }));

function github(existing = [], { missingBranch = false, empty = false, race = false } = {}) {
  const writes = [];
  const api = async (endpoint, body) => {
    if (endpoint === 'graphql' && body.query.startsWith('query')) {
      return { data: { repository: {
        id: 'repo',
        defaultBranchRef: empty ? null : { target: { oid: 'source' } },
        ref: missingBranch ? null : { target: { oid: 'head', tree: { oid: 'tree' } } },
      } } };
    }
    if (endpoint.endsWith('/git/trees/tree?recursive=1')) return { tree: existing };
    assert.equal(endpoint, 'graphql');
    const input = body.variables.input;
    if (body.query.includes('createRef')) {
      assert.deepEqual(input, { repositoryId: 'repo', name: 'refs/heads/assets', oid: 'source' });
      writes.push(input);
      missingBranch = false;
      return {};
    }
    assert.equal(input.expectedHeadOid, 'head');
    assert.deepEqual(input.branch, { repositoryNameWithOwner: 'grafana/assistant-pr-assets', branchName: 'assets' });
    if (race) {
      race = false;
      existing = remote;
      throw Object.assign(new Error('stale'), { graphqlErrors: [{ type: 'STALE_DATA' }] });
    }
    writes.push(input);
    return { data: { createCommitOnBranch: { commit: { oid: 'new-assets-commit' } } } };
  };
  return { api, writes };
}

test('identical assets return existing commit without writing', async () => {
  const { api, writes } = github(remote);
  assert.deepEqual(await publish({ api, files }), { published: false, revision: 'head' });
  assert.equal(writes.length, 0);
});

test('check never writes or creates branches', async () => {
  const { api, writes } = github([], { missingBranch: true });
  assert.deepEqual(await publish({ api, files, check: true }), { published: false, changed: true });
  assert.equal(writes.length, 0);
});

test('first publication creates assets branch and atomically replaces source with SVGs', async () => {
  const { api, writes } = github([
    { path: 'README.md', type: 'blob' },
    { path: '.github', type: 'tree' },
    { path: '.github/workflows/publish.yml', type: 'blob' },
  ], { missingBranch: true });
  assert.deepEqual(await publish({ api, files }), { published: true, revision: 'new-assets-commit' });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].fileChanges, {
    additions: files.map(file => ({ path: file.path, contents: file.contents })),
    deletions: [{ path: 'README.md' }, { path: '.github/workflows/publish.yml' }],
  });
});

test('empty source repository fails without bootstrapping an unsigned commit', async () => {
  const { api, writes } = github([], { missingBranch: true, empty: true });
  await assert.rejects(publish({ api, files }), /Commit generator source to main/);
  assert.equal(writes.length, 0);
});

test('new asset set is one signed API commit, obsolete files are removed', async () => {
  const { api, writes } = github([{ ...remote[0], path: 'old.svg' }]);
  assert.equal((await publish({ api, files })).published, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].fileChanges.deletions, [{ path: 'old.svg' }]);
});

test('concurrent identical publication becomes a no-op', async () => {
  const { api, writes } = github([], { race: true });
  assert.equal((await publish({ api, files })).published, false);
  assert.equal(writes.length, 0);
});

test('permission failures are not retried', async () => {
  let requests = 0;
  const api = async () => { requests++; throw new Error('403'); };
  await assert.rejects(publish({ api, files }), /403/);
  assert.equal(requests, 1);
});

test('token is required and sent only in authorization header', async () => {
  assert.throws(() => githubClient(''), /GITHUB_TOKEN/);
  const api = githubClient('test-token', async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.body, '{"query":"query {}"}');
    return { ok: true, json: async () => ({ data: {} }) };
  });
  await api('graphql', { query: 'query {}' });
});

test('Git blob hashing and exact file-set comparison', () => {
  assert.equal(gitBlob(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(sameFiles(files, [{ ...remote[0], mode: '120000' }]), false);
  assert.equal(sameFiles(files, []), false);
  assert.equal(sameFiles(files, [...remote, { ...remote[0], path: 'extra.svg' }]), false);
});

test('license is published as a root file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'publication-license-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'LICENSE');
  await writeFile(filename, 'Apache License\n');
  assert.deepEqual(await loadLicense(filename), {
    path: 'LICENSE',
    sha: gitBlob(Buffer.from('Apache License\n')),
    contents: Buffer.from('Apache License\n').toString('base64'),
  });
});

test('only the complete self-contained SVG allowlist is accepted', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'publication-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const kind of ['chat', 'investigation', 'alert', 'incident']) {
    for (const mode of ['light', 'dark']) {
      await writeFile(path.join(directory, `open-${kind}-${mode}.svg`), '<svg><path d="M0 0"/></svg>');
    }
  }
  assert.equal((await loadAssets(directory)).length, 8);
  await writeFile(path.join(directory, 'extra.txt'), 'not an asset');
  await assert.rejects(loadAssets(directory), /exactly/);
  await rm(path.join(directory, 'extra.txt'));
  await writeFile(path.join(directory, 'open-chat-light.svg'), '<svg><image href="https://example.com/x"/></svg>');
  await assert.rejects(loadAssets(directory), /self-contained/);
});
