import test from 'node:test';
import assert from 'node:assert/strict';
import {lstat, mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {packageBrowser} from './package-browser.mjs';

async function fixture(omit = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deckcraft-package-')), input = path.join(root, 'input'); await mkdir(input);
  for (const name of ['deckcraft.js', 'deckcraft_bg.wasm', 'deckcraft.ico', 'ATTRIBUTION.md', 'NOTICE', 'LICENSE-MIT', 'LICENSE-APACHE']) if (name !== omit) await writeFile(path.join(input, name), 'Synthetic packaging fixture: ' + name);
  await writeFile(path.join(input, 'index.html'), '<html><script type="module">import init from "./deckcraft.js"; await init();</script></html>');
  return {root, input, output: path.join(root, 'output')};
}

test('external bootstrap preserves runtime payload and notices, with digests for all files', async () => {
  const {input, output} = await fixture(), receipt = await packageBrowser(input, output);
  assert.equal(receipt.files.length, 9);
  for (const name of ['deckcraft.js', 'deckcraft_bg.wasm', 'NOTICE', 'LICENSE-MIT', 'LICENSE-APACHE']) assert.deepEqual(await readFile(path.join(output, name)), await readFile(path.join(input, name)));
  assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /src="\.\/webos-bootstrap.mjs"/);
  assert.match(await readFile(path.join(output, 'webos-bootstrap.mjs'), 'utf8'), /await init\(\)/);
  assert(receipt.files.every(record => /^[a-f0-9]{64}$/.test(record.sha256)));
});

test('destination collisions are refused without modifying existing bytes', async () => {
  const {input, output} = await fixture(); await mkdir(output); const marker = path.join(output, 'keep'); await writeFile(marker, 'existing');
  await assert.rejects(packageBrowser(input, output), error => error.code === 'EEXIST');
  assert.equal(await readFile(marker, 'utf8'), 'existing');
});

test('symlinked input and symlinked payloads are rejected before output exists', async () => {
  const {root, input, output} = await fixture(); const alias = path.join(root, 'alias'); await symlink(input, alias);
  await assert.rejects(packageBrowser(alias, output), /Direct/);
  await symlink(path.join(input, 'NOTICE'), path.join(input, 'extra.js'));
  await assert.rejects(packageBrowser(input, output), /Unexpected/);
  await assert.rejects(lstat(output), error => error.code === 'ENOENT');
});

test('missing required notices block packaging before output exists', async () => {
  const {input, output} = await fixture('NOTICE');
  await assert.rejects(packageBrowser(input, output), /missing notices/);
  await assert.rejects(lstat(output), error => error.code === 'ENOENT');
});

test('changed bootstrap is rejected rather than relaxing CSP or guessing generated imports', async () => {
  const {input, output} = await fixture(); await writeFile(path.join(input, 'index.html'), '<html><script>differentBootstrap()</script></html>');
  await assert.rejects(packageBrowser(input, output), /inspect changed HTML/);
});
