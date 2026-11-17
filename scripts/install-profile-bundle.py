"""Upgrade a stopped/staging profile with its existing pnpm store; never start a service."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import re


def native_memory(profile, bundle, command, store_base):
    """Apply the exact optional integration through pnpm; memory data is never opened."""
    installed = profile / 'node_modules/@dsh-external/dsh-memory/package.json'
    if not installed.exists():
        return {'status': 'absent'}
    version = json.loads(installed.read_text(encoding='utf-8'))['version']
    with tarfile.open(bundle) as archive:
        try:
            patch = archive.extractfile('package/integrations/dsh-memory/main-role.patch').read()
            contract = json.load(archive.extractfile('package/integrations/dsh-memory/manifest.json'))
        except KeyError:
            return {'status': 'not_requested'}
    if version != '0.5.7':
        return {'status': 'unsupported', 'version': version}
    def matches(files):
        return all(hashlib.sha256((installed.parent / file).read_bytes()).hexdigest() == digest for file, digest in files.items())
    if not matches(contract['patched']):
        previous = contract.get('previous')
        if not matches(contract['original']) and not (previous and matches(previous['files'])):
            raise ValueError('Memory package differs from the reviewed upstream and patched files')
        patch_file = profile / 'patches/native-memory-main.patch'
        patch_file.parent.mkdir(exist_ok=True)
        if patch_file.exists() and patch_file.read_bytes() != patch:
            if not previous or hashlib.sha256(patch_file.read_bytes()).hexdigest() != previous['patchSha256']:
                raise ValueError('Preserve the existing native memory patch before upgrading it')
        workspace = profile / 'pnpm-workspace.yaml'
        text = workspace.read_text(encoding='utf-8') if workspace.exists() else ''
        declaration = '  "@dsh-external/dsh-memory@0.5.7": patches/native-memory-main.patch\n'
        if '@dsh-external/dsh-memory@0.5.7' in text and declaration.strip() not in text:
            raise ValueError('An existing memory patch needs review; it was not replaced')
        patch_file.write_bytes(patch)
        if declaration.strip() not in text:
            text = text.replace('patchedDependencies:\n', 'patchedDependencies:\n' + declaration, 1) if 'patchedDependencies:\n' in text else text.rstrip() + '\npatchedDependencies:\n' + declaration
            workspace.write_bytes(text.encode('utf-8'))
        subprocess.run([*command, 'install', '--no-frozen-lockfile', '--ignore-scripts', '--store-dir', str(store_base),
                        '--config.confirmModulesPurge=false'], cwd=profile, check=True, capture_output=True, text=True, timeout=300)
        if not matches(contract['patched']):
            raise ValueError('pnpm did not install the expected memory adapter files')
    # The existing loader override owns the role declaration; retain all other fields and budgets.
    path = profile / 'cordis.patch.yml'
    text = path.read_text(encoding='utf-8')
    blocks = list(re.finditer(r'(?m)^- id: dsh-memory\s*\n', text))
    if len(blocks) != 1:
        raise ValueError('Memory adapter requires one existing dsh-memory profile override')
    start = blocks[0].end()
    following = re.search(r'(?m)^- ', text[start:])
    end = start + following.start() if following else len(text)
    block = text[start:end]
    if not re.search(r'(?m)^    parentedRootPresets:', block):
        if block.count('  config:\n') != 1:
            raise ValueError('Memory adapter requires the existing config mapping')
        block = block.replace('  config:\n', '  config:\n    parentedRootPresets: ["dsh-superagent-router"]\n', 1)
        path.write_bytes((text[:start] + block + text[end:]).encode('utf-8'))
    return {'status': 'patched', 'version': version, 'patchSha256': hashlib.sha256(patch).hexdigest(),
            'preset': 'dsh-superagent-router'}


def store_directory(profile):
    text = (profile / 'node_modules/.modules.yaml').read_text(encoding='utf-8')
    if text.lstrip().startswith('{'):
        value = json.loads(text)['storeDir']
    else:
        line = next((line.partition(':')[2].strip() for line in text.splitlines() if line.startswith('storeDir:')), None)
        if line is None:
            raise ValueError('The profile has no installed storeDir; use the native first-install flow')
        value = json.loads(line) if line.startswith('"') else line[1:-1].replace("''", "'") if line.startswith("'") else line
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise ValueError('The installed storeDir must be an existing absolute directory')
    return path.resolve()


def install(profile, bundle, pnpm_js, node, receipt_path):
    if receipt_path.exists():
        raise ValueError('Use a new private receipt path; preserve the previous evidence')
    receipt = {'status': 'failed', 'stage': 'read_bundle', 'profile': str(profile.resolve()),
               'bundle': str(bundle.resolve()), 'runtimeActivated': False}
    try:
        with tarfile.open(bundle) as stream:
            member = stream.getmember('package/package.json')
            if not member.isfile():
                raise ValueError('The bundle package.json is not a regular file')
            target = json.load(stream.extractfile(member))
        if target.get('name') != 'dsh-superagent' or not isinstance(target.get('version'), str):
            raise ValueError('Expected a reviewed dsh-superagent archive with a version')
        receipt.update(requestedVersion=target['version'], bundleSha256=hashlib.sha256(bundle.read_bytes()).hexdigest())
        package = profile / 'node_modules/dsh-superagent/package.json'
        receipt['beforeVersion'] = json.loads(package.read_text(encoding='utf-8'))['version']
        receipt['stage'] = 'read_store'
        stored = store_directory(profile)
        store_base = stored.parent
        command = [str(node), str(pnpm_js)]
        receipt['stage'] = 'validate_store'
        actual = subprocess.run([*command, 'store', 'path', '--store-dir', str(store_base)], cwd=profile,
                                capture_output=True, text=True, encoding='utf-8', check=True, timeout=30)
        if Path(actual.stdout.strip()).resolve() != stored:
            raise ValueError('The selected pnpm does not resolve the installed store; no install was attempted')
        receipt['storeDir'] = str(stored)
        receipt['stage'] = 'install'
        subprocess.run([*command, 'add', 'file:' + bundle.resolve().as_posix(), '--store-dir', str(store_base),
                        '--ignore-scripts', '--config.confirmModulesPurge=false'], cwd=profile,
                       capture_output=True, text=True, encoding='utf-8', check=True, timeout=300)
        receipt['stage'] = 'verify_manifest'
        resolved = json.loads(package.read_text(encoding='utf-8'))
        if resolved.get('name') != target['name'] or resolved.get('version') != target['version']:
            raise ValueError('The profile still resolves another bundle; installation is not confirmed')
        receipt['stage'] = 'native_memory'
        receipt['memory'] = native_memory(profile, bundle, command, store_base)
        receipt.update(status='installed', resolvedVersion=resolved['version'], stage='complete')
        return receipt
    except Exception as error:
        receipt['error'] = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            receipt['commandOutput'] = ((error.stderr or '') + '\n' + (error.stdout or ''))[-2000:]
        raise
    finally:
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = receipt_path.with_suffix(receipt_path.suffix + '.tmp')
        temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(receipt_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--pnpm-js', required=True, type=Path, help='The reviewed pinned pnpm .mjs/.cjs CLI')
    parser.add_argument('--node', type=Path, default=shutil.which('node'))
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = install(args.profile.resolve(), args.bundle.resolve(), args.pnpm_js.resolve(), args.node, args.receipt.resolve())
        print(json.dumps({'status': result['status'], 'version': result['resolvedVersion'], 'runtimeActivated': False}))
    except Exception as error:
        parser.exit(1, f'Profile install failed; inspect the private receipt. {type(error).__name__}\n')
