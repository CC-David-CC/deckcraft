#!/usr/bin/env python3
"""Build DeckCraft's complete browser graph offline from reviewed pinned inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parent.parent
FONT_PIN = (ROOT / 'webos/craft-fonts.rev').read_text().strip()
TOOLCHAIN = 'nightly-2026-11-16'
BINDGEN = '0.2.129'


def git(root, *args):
    return subprocess.check_output(['git', '--no-optional-locks', '-C', str(root), *args], text=True).strip()


def external(value):
    path = Path(value).absolute()
    if '..' in path.parts or any(p.is_symlink() for p in (path, *path.parents)) or path.is_relative_to(ROOT) or ROOT.is_relative_to(path):
        raise ValueError('Direct external paths required')
    if any((p / '.git').exists() or (p / 'HEAD').is_file() and (p / 'objects').is_dir() for p in (path, *path.parents)):
        raise ValueError('Outputs and caches must be outside repositories')
    return path


def fonts_input(path):
    if git(path, 'rev-parse', 'HEAD') != FONT_PIN or git(path, 'status', '--porcelain'):
        raise ValueError('A clean source-pinned fonts checkout is required')
    return {'commit': FONT_PIN, 'source': 'https://github.com/storytold/craft-fonts'}


def provider(environment, root, url):
    root = Path(root).absolute()
    if root.is_symlink() or git(root, 'rev-parse', '--is-bare-repository') != 'true' or (root / 'objects/info/alternates').exists():
        raise ValueError('Self-contained dependency providers required')
    sources = {p.get('source', '') for p in tomllib.loads((ROOT / 'Cargo.lock').read_text())['package']}
    for source in sources:
        if source.startswith('git+' + url + '?'):
            git(root, 'cat-file', '-e', source.rsplit('#', 1)[1] + '^{commit}')
    count = int(environment.get('GIT_CONFIG_COUNT', '0'))
    environment['GIT_CONFIG_KEY_' + str(count)] = 'url.' + root.as_uri() + '.insteadOf'
    environment['GIT_CONFIG_VALUE_' + str(count)] = url
    environment['GIT_CONFIG_COUNT'] = str(count + 1)


def dependency_notices(output, craft_origin, egui_origin):
    entries = []
    providers = [('craft-libs', craft_origin, 'https://github.com/storytold/craft-libs', 'licenses/'),
                 ('egui', egui_origin, 'https://github.com/storytold/egui.git', 'crates/epaint_default_fonts/fonts/')]
    packages = tomllib.loads((ROOT / 'Cargo.lock').read_text())['package']
    for name, origin, url, prefix in providers:
        commits = {entry['source'].rsplit('#', 1)[1] for entry in packages if entry.get('source', '').startswith('git+' + url + '?')}
        for commit in sorted(commits):
            paths = git(origin, 'ls-tree', '-r', '--name-only', commit, prefix).splitlines()
            for path in paths:
                # Egui includes TTF payloads next to their licence texts. Only
                # licence/readme texts enter notices, never additional fonts.
                if not path.lower().endswith(('.txt', '.md')) and 'LICENSE' not in Path(path).name:
                    continue
                data = subprocess.check_output(['git', '--no-optional-locks', '-C', str(origin), 'cat-file', 'blob', commit + ':' + path])
                destination = output / 'notices' / name / commit / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                entries.append({'source': url, 'commit': commit, 'path': path, 'sha256': hashlib.sha256(data).hexdigest()})
    if not any(entry['path'].endswith('/UFL.txt') for entry in entries):
        raise ValueError('Bundled egui font licence texts are required')
    return entries


def finalize(output, fonts, tools, commit, craft_origin, egui_origin):
    notices = output / 'notices'
    notices.mkdir()
    for name in ['LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'ATTRIBUTION.md']:
        shutil.copy2(ROOT / name, notices / name)
    brand_terms = notices / 'docs/brand/LICENSE-brand.txt'
    brand_terms.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'docs/brand/LICENSE-brand.txt', brand_terms)
    # Ship font/dependency licence texts, never restricted ArtCraft brand artwork.
    for directory in [ROOT / 'licenses', fonts]:
        for path in directory.rglob('*'):
            if path.is_symlink():
                continue
            if path.is_file() and (directory.name == 'licenses' or path.suffix.lower() in ('.txt', '.md') and any(x in path.name.lower() for x in ('license', 'licence', 'ofl'))):
                destination = notices / directory.name / path.relative_to(directory)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
    dependency_licences = dependency_notices(output, craft_origin, egui_origin)
    files = []
    for path in sorted(output.rglob('*')):
        if path.is_symlink():
            raise ValueError('Browser graph must be self-contained')
        if path.is_file():
            data = path.read_bytes()
            files.append({'path': path.relative_to(output).as_posix(), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    if sum(entry['path'].endswith('.wasm') for entry in files) != 1:
        raise ValueError('Expected exactly one native application WASM')
    receipt = {'schema': 'webos-component-build/1', 'component': 'deckcraft', 'sourceCommit': commit,
               'profile': 'development', 'tools': tools, 'buildInputs': {'fonts': fonts_input(fonts)},
               'cargoLockSHA256': hashlib.sha256((ROOT / 'Cargo.lock').read_bytes()).hexdigest(), 'files': files,
               'dependencyNotices': dependency_licences,
               'totalBytes': sum(f['bytes'] for f in files), 'qualification': 'Native browser graph only; account and presenter acceptance separate'}
    (output / 'component-build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['output', 'target-dir', 'fonts', 'craft-libs-origin', 'egui-origin', 'winit-origin']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--jobs', type=int, choices=range(1, 17), default=8)
    args = parser.parse_args()
    output, target = external(args.output), external(args.target_dir)
    if output.exists() or output.is_relative_to(target) or target.is_relative_to(output):
        parser.error('Use a new output directory separate from compiler cache')
    if git(ROOT, 'status', '--porcelain'):
        parser.error('Commit reviewed source only after native gates before producing a reproducible artifact')
    if shutil.disk_usage(output.parent).free < 8 * 1024**3:
        parser.error('Keep an 8 GiB free-space reserve')
    fonts_input(args.fonts)
    env = dict(os.environ, RUSTUP_TOOLCHAIN=TOOLCHAIN, CARGO_TARGET_DIR=str(target), CARGO_BUILD_JOBS=str(args.jobs),
               CARGO_PROFILE_DEV_DEBUG='0', CARGO_NET_OFFLINE='true', CRAFT_FONTS_DIR=str(args.fonts), CRAFT_FONTS_REQUIRED='1')
    for key in list(env):
        if key in ('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'RUSTC_BOOTSTRAP') or key.startswith('CARGO_TARGET_') and key.endswith('_RUSTFLAGS'):
            env.pop(key, None)
    env['RUSTC'] = subprocess.check_output(['rustup', 'which', '--toolchain', TOOLCHAIN, 'rustc'], env=env, text=True).strip()
    env['RUSTDOC'] = subprocess.check_output(['rustup', 'which', '--toolchain', TOOLCHAIN, 'rustdoc'], env=env, text=True).strip()
    env['RUSTC_WRAPPER'] = env['RUSTC_WORKSPACE_WRAPPER'] = ''
    tools = {name: subprocess.check_output([name, '--version'], env=env, text=True).strip() for name in ['cargo', 'wasm-bindgen']}
    tools['rustc'] = subprocess.check_output([env['RUSTC'], '--version', '--verbose'], env=env, text=True).strip()
    if tools['wasm-bindgen'] != 'wasm-bindgen ' + BINDGEN:
        parser.error('The lockfile requires wasm-bindgen ' + BINDGEN)
    for root, url in [(args.craft_libs_origin, 'https://github.com/storytold/craft-libs'), (args.egui_origin, 'https://github.com/storytold/egui.git'), (args.winit_origin, 'https://github.com/storytold/winit.git')]:
        provider(env, root, url)
    count = int(env.get('GIT_CONFIG_COUNT', '0'))
    env['GIT_CONFIG_KEY_' + str(count)] = 'protocol.file.allow'
    env['GIT_CONFIG_VALUE_' + str(count)] = 'always'
    env['GIT_CONFIG_COUNT'] = str(count + 1)
    env['CARGO_NET_GIT_FETCH_WITH_CLI'] = 'true'
    commit = git(ROOT, 'rev-parse', 'HEAD')
    os.umask(0o077)
    subprocess.run(['cargo', 'build', '--locked', '--offline', '-p', 'deckcraft-web', '--target', 'wasm32-unknown-unknown'], cwd=ROOT, env=env, check=True)
    output.mkdir(mode=0o700)
    subprocess.run(['wasm-bindgen', '--target', 'web', '--out-name', 'deckcraft', '--out-dir', str(output), str(target / 'wasm32-unknown-unknown/debug/deckcraft-web.wasm')], env=env, check=True)
    # Type declarations are compiler outputs unnecessary for the browser graph.
    for path in output.glob('*.d.ts'):
        path.unlink()
    shutil.copy2(ROOT / 'webos/browser.html', output / 'index.html')
    shutil.copy2(ROOT / 'webos/bootstrap.mjs', output / 'webos-bootstrap.mjs')
    shutil.copy2(ROOT / 'webos/deckcraft.css', output / 'deckcraft.css')
    shutil.copy2(ROOT / 'assets/app-icon/deckcraft.ico', output / 'deckcraft.ico')
    if git(ROOT, 'rev-parse', 'HEAD') != commit or git(ROOT, 'status', '--porcelain'):
        raise RuntimeError('Source changed during build; candidate is unqualified')
    receipt = finalize(output, args.fonts, tools, commit, args.craft_libs_origin, args.egui_origin)
    print(json.dumps({'component': 'deckcraft', 'bytes': receipt['totalBytes'], 'files': len(receipt['files'])}))


if __name__ == '__main__':
    main()
