import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'grafana/assistant-pr-assets';
const filenames = ['chat', 'investigation', 'alert', 'incident']
  .flatMap(kind => ['light', 'dark'].map(mode => `open-${kind}-${mode}.svg`)).sort();

export function gitBlob(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function sameFiles(local, remote) {
  return local.length === remote.length && local.every(file => remote.some(entry =>
    entry.path === file.path && entry.type === 'blob' && entry.mode === '100644' && entry.sha === file.sha));
}

export async function loadAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile()) || entries.map(entry => entry.name).sort().join('\n') !== filenames.join('\n')) {
    throw new Error('Asset directory must contain exactly the expected SVG files');
  }
  return Promise.all(filenames.map(async name => {
    const bytes = await readFile(path.join(directory, name));
    const svg = bytes.toString('utf8');
    if (!svg.includes('<svg') || /<(?:image|foreignObject|text|script)\b|(?:href|src)\s*=\s*["'](?!#)/i.test(svg)) {
      throw new Error(`Not a self-contained vector SVG: ${name}`);
    }
    return { path: name, sha: gitBlob(bytes), contents: bytes.toString('base64') };
  }));
}

export function githubClient(token, fetchRequest = fetch) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  return async (endpoint, body) => {
    const response = await fetchRequest(`https://api.github.com/${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok || result.errors?.length) {
      const error = new Error(`GitHub ${endpoint}: ${response.status} ${JSON.stringify(result.errors || result.message)}`);
      error.graphqlErrors = result.errors;
      throw error;
    }
    return result;
  };
}

async function snapshot(api) {
  const { data } = await api('graphql', {
    query: `query { repository(owner: "grafana", name: "assistant-pr-assets") {
      id ref(qualifiedName: "refs/heads/assets") { target { oid ... on Commit { tree { oid } } } }
      defaultBranchRef { target { oid } }
    } }`,
  });
  const repo = data.repository;
  if (!repo) throw new Error(`Cannot access ${repository}`);
  if (!repo.ref) return { repositoryID: repo.id, initialHead: repo.defaultBranchRef?.target.oid };
  const result = await api(`repos/${repository}/git/trees/${repo.ref.target.tree.oid}?recursive=1`);
  if (result.truncated) throw new Error('Asset tree was truncated');
  return { head: repo.ref.target.oid, files: result.tree.filter(entry => entry.type !== 'tree') };
}

export async function publish({ api, files, check = false, sourceCommit = '' }) {
  if (sourceCommit && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid SOURCE_COMMIT');
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await snapshot(api);
    if (state.head && sameFiles(files, state.files)) {
      return { published: false, revision: state.head };
    }
    if (check) return { published: false, changed: true };
    try {
      if (!state.head) {
        if (!state.initialHead) throw new Error('Commit generator source to main before publishing assets');
        // Start from an existing signed commit. The next atomic commit removes
        // source files from this branch; main and its history remain untouched.
        await api('graphql', {
          query: `mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name } } }`,
          variables: { input: { repositoryId: state.repositoryID, name: 'refs/heads/assets', oid: state.initialHead } },
        });
        continue;
      }
      const result = await api('graphql', {
        query: `mutation($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) { commit { oid } }
        }`,
        variables: { input: {
          branch: { repositoryNameWithOwner: repository, branchName: 'assets' },
          expectedHeadOid: state.head,
          message: { headline: 'chore: update publication assets', ...(sourceCommit ? { body: `Source: ${sourceCommit}` } : {}) },
          fileChanges: {
            additions: files.map(file => ({ path: file.path, contents: file.contents })),
            deletions: state.files.filter(entry => !files.some(file => file.path === entry.path)).map(entry => ({ path: entry.path })),
          },
        } },
      });
      return { published: true, revision: result.data.createCommitOnBranch.commit.oid };
    } catch (error) {
      const raced = error.graphqlErrors?.some(item => item.type === 'STALE_DATA' ||
        /reference already exists|expected branch to point to/i.test(item.message || ''));
      if (!raced || attempt === 2) throw error;
    }
  }
  throw new Error('Destination kept changing; retry publication');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: publish.mjs [--check]');
    const result = await publish({
      api: githubClient(process.env.GITHUB_TOKEN),
      files: await loadAssets('/output'),
      check: process.argv.includes('--check'),
      sourceCommit: process.env.SOURCE_COMMIT || '',
    });
    console.log(result.revision ? `https://github.com/${repository}/commit/${result.revision}` : 'Assets changed; ready to publish');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
