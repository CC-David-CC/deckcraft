/** Package the explicit Cargo/wasm-bindgen browser output for WebOS's existing CSP. */
import {copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const inlineBootstrap = '<script type="module">import init from "./deckcraft.js"; await init();</script>';
const roots = new Set(['index.html', 'deckcraft.js', 'deckcraft_bg.wasm', 'deckcraft.ico', 'ATTRIBUTION.md', 'NOTICE', 'LICENSE-MIT', 'LICENSE-APACHE']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function direct(value) {
  for (let current = path.resolve(value); ; current = path.dirname(current)) {
    try {if ((await lstat(current)).isSymbolicLink()) throw Error('Direct artifact paths required.');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (current === path.dirname(current)) return;
  }
}

export async function packageBrowser(inputArgument, outputArgument) {
  if (!inputArgument || !outputArgument) throw Error('Built input and new output directories required.');
  const input = path.resolve(inputArgument), output = path.resolve(outputArgument);
  await direct(input); await direct(output);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (input === output || input.startsWith(output + path.sep) || output.startsWith(input + path.sep) || output === repo || output.startsWith(repo + path.sep)) throw Error('Use a new independent output directory outside source.');
  if (await realpath(input) !== input) throw Error('Direct artifact input required.');
  const records = []; let size = 0;
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, {withFileTypes: true})) {
      const relative = prefix + entry.name, file = path.join(folder, entry.name);
      if (entry.isDirectory() && (relative === 'snippets' || relative.startsWith('snippets/'))) {await walk(file, relative + '/'); continue;}
      if (!entry.isFile() || !(roots.has(relative) || /^snippets\/(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.js$/.test(relative))) throw Error('Unexpected browser artifact: ' + relative);
      const info = await lstat(file);
      if (!info.isFile()) throw Error('Direct regular browser payload required.');
      if (size + info.size > 256 * 1024 * 1024 || records.length >= 256) throw Error('Browser artifact exceeds packaging bounds.');
      const bytes = await readFile(file); size += bytes.length;
      if (bytes.length !== info.size) throw Error('Browser artifact changed during capture.');
      records.push({path: relative, bytes: bytes.length, sha256: digest(bytes)});
    }
  }
  await walk(input);
  if ([...roots].some(name => !records.some(record => record.path === name))) throw Error('Incomplete browser artifact or missing notices.');
  const html = await readFile(path.join(input, 'index.html'), 'utf8');
  if (html.split(inlineBootstrap).length !== 2 || (html.match(/<script\b/gi) || []).length !== 1) throw Error('Expected explicit standalone bootstrap; inspect changed HTML before packaging.');
  // Exclusive creation refuses collisions. No cleanup or silent partial-output reuse.
  await mkdir(output, {mode: 0o700});
  for (const record of records) {
    const from = path.join(input, record.path), to = path.join(output, record.path);
    await mkdir(path.dirname(to), {recursive: true, mode: 0o700});
    await copyFile(from, to, constants.COPYFILE_EXCL);
    if (digest(await readFile(to)) !== record.sha256) throw Error('Artifact changed while copying: ' + record.path);
  }
  await writeFile(path.join(output, 'index.html'), html.replace(inlineBootstrap, '<script type="module" src="./webos-bootstrap.mjs"></script>'), {mode: 0o600});
  const bootstrap = await readFile(new URL('./bootstrap.mjs', import.meta.url));
  await writeFile(path.join(output, 'webos-bootstrap.mjs'), bootstrap, {flag: 'wx', mode: 0o600});
  const files = await Promise.all([...records.map(record => record.path), 'webos-bootstrap.mjs'].sort().map(async name => {const bytes = await readFile(path.join(output, name)); return {path: name, bytes: bytes.length, sha256: digest(bytes)};}));
  return {schema: 'webos-deckcraft-csp-package/1', transformation: 'External bootstrap; CSP unchanged; Cargo/wasm-bindgen output, not Trunk equivalence or deployment qualification.', inputs: records.sort((a, b) => a.path.localeCompare(b.path)), files};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = await packageBrowser(process.argv[2], process.argv[3]);
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
