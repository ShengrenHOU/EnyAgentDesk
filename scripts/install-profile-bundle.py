"""Upgrade a stopped/staging profile with its existing pnpm store; never start a service."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile


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
                                capture_output=True, text=True, encoding='utf-8', check=True)
        if Path(actual.stdout.strip()).resolve() != stored:
            raise ValueError('The selected pnpm does not resolve the installed store; no install was attempted')
        receipt['storeDir'] = str(stored)
        receipt['stage'] = 'install'
        subprocess.run([*command, 'add', 'file:' + bundle.resolve().as_posix(), '--store-dir', str(store_base),
                        '--ignore-scripts', '--config.confirmModulesPurge=false'], cwd=profile,
                       capture_output=True, text=True, encoding='utf-8', check=True)
        receipt['stage'] = 'verify_manifest'
        resolved = json.loads(package.read_text(encoding='utf-8'))
        if resolved.get('name') != target['name'] or resolved.get('version') != target['version']:
            raise ValueError('The profile still resolves another bundle; installation is not confirmed')
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
