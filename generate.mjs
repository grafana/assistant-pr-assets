// Capture the real @grafana/ui secondary Button, not a separate SVG renderer.
// Run in the generator Docker image.
// Runs inside the pinned Docker image; no host Node/browser/converter required.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const source = fileURLToPath(new URL('./', import.meta.url));
const outputRoot = process.env.PUBLICATION_ASSETS_OUTPUT_DIR || '/output';
// SVGs are publication artifacts, never checked into main.
const generated = outputRoot;
const buttons = [
  { name: 'open-chat', label: 'Open Chat', icon: 'GrafanaLogo' },
  { name: 'open-investigation', label: 'Open Investigation', icon: 'GrafanaLogo' },
  { name: 'open-alert', label: 'View Alert', icon: 'Bell' },
  { name: 'open-incident', label: 'View Incident', icon: 'Incident' },
  { name: 'fix-in-grafana', label: 'Fix in Grafana', icon: 'GrafanaLogo' },
];
const require = createRequire(import.meta.url);
const ui = path.dirname(require.resolve('@grafana/ui/package.json'));
const esbuild = await import('esbuild');
const font = await readFile(path.join(path.dirname(require.resolve('inter-ui/package.json')), 'web/Inter-SemiBold.woff2'));
const logo = await readFile(path.join(source, 'grafana_icon.svg'));
const bell = await readFile(path.join(ui, 'dist/public/img/icons/unicons/bell.svg'), 'utf8');
const bellContents = bell.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
const fire = await readFile(path.join(ui, 'dist/public/img/icons/unicons/fire.svg'), 'utf8');
const fireContents = fire.match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
const result = await esbuild.build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Button } from ${JSON.stringify(path.join(ui, 'dist/esm/components/Button/Button.mjs'))};
      import { ThemeContext, createTheme } from '@grafana/data';
      function GrafanaLogo({className}) {
        return React.createElement('img', {className, width: 16, height: 16, alt: '', src: ${JSON.stringify('data:image/svg+xml;base64,' + logo.toString('base64'))}});
      }
      const mode = new URLSearchParams(location.search).get('mode') || 'light';
      function Bell({className}) {
        return React.createElement('svg', {className, width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true,
          dangerouslySetInnerHTML: {__html: ${JSON.stringify(bellContents)}}});
      }
      function Incident({className}) {
        return React.createElement('svg', {className, width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true,
          dangerouslySetInnerHTML: {__html: ${JSON.stringify(fireContents)}}});
      }
      const buttons = ${JSON.stringify(buttons)};
      const icons = { GrafanaLogo, Bell, Incident };
      createRoot(document.getElementById('root')).render(
        // Intentional optical adjustment for the reviewed footer design.
        React.createElement(ThemeContext.Provider, {value: createTheme({colors: {mode}, typography: {fontWeightMedium: 600}})},
          React.createElement('div', {style: {display: 'flex', gap: 16}}, buttons.map(({name, label, icon}) =>
            React.createElement(Button, {key: name, variant: 'secondary', size: 'md', style: {paddingLeft: 11}, icon: React.createElement(icons[icon], {width: 16, height: 16})}, label)))));
    `,
    resolveDir: source,
    loader: 'js',
  },
  alias: { '@grafana/data': require.resolve('@grafana/data') },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const output = '/tmp/publication-capture';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const dimensions = {};
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  page.on('pageerror', error => console.error(error));
  for (const mode of ['light', 'dark']) {
    await page.goto(`about:blank?mode=${mode}`);
    await page.setContent(`<style>@font-face {font-family: Inter; src: url(data:font/woff2;base64,${font.toString('base64')}); font-weight: 600;} body {margin: 20px; background: transparent;}</style><div id="root"></div>`);
    await page.addScriptTag({ content: result.outputFiles[0].text });
    await page.getByRole('button', { name: 'Open Chat', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({content: `@media print {
      body { margin: 0 !important; }
      #root button:not([data-capture]) { display: none !important; }
      #root button[data-capture] { position: fixed; top: 0; left: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }`});
    await page.mouse.move(1000, 700);
    for (const { name: kind, label } of buttons) {
      const button = page.getByRole('button', { name: label, exact: true });
      // Integer capture bounds avoid resampling the text in the Markdown image.
      await button.evaluate(element => { element.style.width = Math.ceil(element.getBoundingClientRect().width) + 'px'; });
      const bounds = await button.boundingBox();
      const state = await button.evaluate(element => ({
        hovered: element.matches(':hover'), focused: element.matches(':focus'),
        disabled: element.disabled, shadow: getComputedStyle(element).boxShadow,
      }));
      if (state.hovered || state.focused || state.disabled || state.shadow !== 'none') {
        throw new Error(`Expected idle secondary button: ${JSON.stringify(state)}`);
      }
      if (dimensions[kind] && dimensions[kind].width !== bounds.width) {
        throw new Error(`Theme dimensions differ for ${kind}`);
      }
      dimensions[kind] = {width: bounds.width, height: bounds.height};
      await page.locator('[data-capture]').evaluateAll(elements => elements.forEach(element => element.removeAttribute('data-capture')));
      await button.evaluate(element => element.setAttribute('data-capture', ''));
      await page.pdf({path: path.join(output, `${kind}-${mode}.pdf`), width: `${bounds.width}px`, height: `${bounds.height}px`, printBackground: true, margin: {top: 0, right: 0, bottom: 0, left: 0}});
    }
  }
} finally {
  await browser.close();
}
// Convert Chromium's vector print capture, not a hand-built button renderer.
// Outline glyphs so GitHub needs neither installed nor externally loaded fonts.
await mkdir(generated, {recursive: true});

for (const { name: kind } of buttons) {
  for (const mode of ['light', 'dark']) {
    const base = path.join(output, `${kind}-${mode}`);
    execFileSync('pdftocairo', ['-svg', `${base}.pdf`, `${base}.svg`]);
    const svg = await readFile(`${base}.svg`, 'utf8');
    if (/<(?:image|foreignObject|text)\b/.test(svg)) {
      throw new Error(`Expected vector paths without raster images or font dependencies: ${base}.svg`);
    }
    await writeFile(path.join(generated, `${kind}-${mode}.svg`), svg);
    console.log('Vector capture:', `${base}.svg`);
  }
}
console.log(`Generated assets: ${generated}`);

