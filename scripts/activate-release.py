"""Activate a verified release on one Windows owner-managed profile; keep receipts and business state private."""
import argparse
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import tarfile
import time
import urllib.error
import urllib.request


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


launcher = module(Path(__file__).with_name('owner-launcher.py'), 'activation_owner')
installer = module(Path(__file__).with_name('install-profile-bundle.py'), 'activation_installer')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def release_files(directory):
    release = json.loads((directory / 'release.json').read_text(encoding='utf-8-sig'))
    commit = release.get('publicCommit') or release.get('commit')
    version = release.get('version', '')
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
        raise ValueError('Release requires an immutable commit and package version')
    archive = directory / f'dsh-superagent-{version}.tgz'
    if digest(archive) != release.get('sha256'):
        raise ValueError('Release archive SHA256 mismatch')
    with tarfile.open(archive) as stream:
        def read(name):
            member = stream.getmember('package/' + name)
            if not member.isfile():
                raise ValueError('Release helper must be a regular archive member')
            return stream.extractfile(member).read()
        manifest = json.loads(read('package.json'))
        if manifest.get('name') != 'dsh-superagent' or manifest.get('version') != version:
            raise ValueError('Release package identity mismatch')
        scripts = {name: read('scripts/' + name) for name in
                   ['owner-launcher.py', 'owner-supervisor.ps1', 'install-profile-bundle.py', 'check-runtime-peers.mjs', 'activate-release.py']}
        for name in ['owner-launcher.py', 'install-profile-bundle.py', 'activate-release.py']:
            if Path(__file__).with_name(name).read_bytes() != scripts[name]:
                raise ValueError('Run the activation helpers from this exact release archive')
    return {'version': version, 'commit': commit, 'sha256': release['sha256'], 'archive': archive, 'scripts': scripts}


def paused(config, value):
    request = urllib.request.Request(f"http://127.0.0.1:{config['port']}/orchestrator/api/executor/pause",
                                    data=json.dumps({'paused': value}).encode(), method='POST',
                                    headers={'x-orchestrator-request': '1', 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as response:
            json.load(response)
    except (OSError, ValueError):
        current = launcher.state(config)
        if not current or current.get('paused') is not value:
            raise RuntimeError('Could not confirm the dispatch pause state') from None


def observation(current):
    if current is None:
        return {'reachable': False}
    return {'runtime': {key: current.get('runtime', {}).get(key) for key in ['packageVersion', 'commit']},
            'health': {name: value.get('state') for name, value in current['health'].items()},
            'setupProblem': (current['setup'].get('problem') or {}).get('code'),
            'feishuProblem': (current['setup'].get('feishuProblem') or {}).get('code')}


def database(path, backup=None):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as source:
        if backup:
            with closing(sqlite3.connect(backup)) as target:
                source.backup(target)
        schema = source.execute("SELECT value FROM kv WHERE key='schema'").fetchone()[0]
        tickets = {row[0] for row in source.execute('SELECT id FROM ticket')}
    return {'schema': schema, 'tickets': tickets}


def run(command, cwd=None, operation='activation child'):
    try:
        return subprocess.run([str(part) for part in command], cwd=cwd, check=True, capture_output=True,
                              text=True, encoding='utf-8', errors='replace', timeout=300,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError) as error:
        code = f' exit={error.returncode}' if isinstance(error, subprocess.CalledProcessError) else ''
        raise RuntimeError(f'{operation} failed ({type(error).__name__}{code}); no command arguments or output copied') from None


def verify(config, version, commit, wait_seconds):
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            current = launcher.state(config)
        except (TimeoutError, json.JSONDecodeError):
            current = None
        except RuntimeError as error:
            if not isinstance(error.__cause__, urllib.error.HTTPError) or error.__cause__.code not in [404, 502, 503]:
                raise
            current = None
        if current and launcher.ready(current):
            build = current.get('runtime', {})
            actual_commit = build.get('commit', '')
            if build.get('packageVersion') == version and len(actual_commit) >= 12 and commit.startswith(actual_commit):
                return current
        if time.monotonic() >= deadline:
            raise RuntimeError('Expected runtime build/setup not ready; last observation: ' + json.dumps(observation(current)))
        time.sleep(2)


def activate(config_path, release_dir, pnpm_js, receipt_path, candidate_patch=None, wait_seconds=300, preflight_only=False):
    config = launcher.validate_config(json.loads(config_path.read_text(encoding='utf-8-sig')))
    if not config.get('stateDir'):
        raise ValueError('Owner-managed activation requires the explicit stateDir')
    with launcher.launch_guard(Path(config['runtime']), 'owner-activation.lock'):
        return _activate(config, config_path, release_dir, pnpm_js, receipt_path, candidate_patch, wait_seconds, preflight_only)


def _activate(config, config_path, release_dir, pnpm_js, receipt_path, candidate_patch, wait_seconds, preflight_only):
    if receipt_path.exists():
        raise ValueError('Use a new private receipt path')
    root = Path(config['runtime'])
    profile = root / config['home'] / 'profiles' / config['profile']
    state_dir = Path(config['stateDir'])
    db = state_dir / 'orchestrator.sqlite'
    receipt = {'status': 'running', 'stage': 'preflight', 'rollback': 'not_needed'}
    def checkpoint(stage):
        receipt['stage'] = stage
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(receipt_path, receipt)
    saved = None
    stopped = False
    try:
        target = release_files(release_dir)
        patch_bytes = candidate_patch.read_bytes() if candidate_patch else None
        old_config_bytes = config_path.read_bytes()
        old_patch = (profile / 'cordis.patch.yml').read_bytes()
        live = launcher.state(config)
        if not launcher.ready(live) or type(live.get('paused')) is not bool:
            raise RuntimeError('Existing instance must be ready and expose its dispatch state')
        if (root / config['stopMarker']).exists():
            raise RuntimeError('Operator stop marker is present; preserve stop intent')
        before_paused = live['paused']
        old_build = live['runtime']
        store = installer.store_directory(profile)
        receipt.update(target={key: target[key] for key in ['version', 'commit', 'sha256']},
                       beforeVersion=old_build['packageVersion'], beforeCommit=old_build['commit'], beforePaused=before_paused)
        if preflight_only:
            launcher.check_start_credential(config)
            launcher.check_start_dependencies(config)
            receipt['status'] = 'prepared'
            return receipt
        checkpoint('drain')
        paused(config, True)
        deadline = time.monotonic() + wait_seconds
        while True:
            current = launcher.state(config)
            if current and current.get('paused') is True and current.get('load', {}).get('running') == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Workers did not drain; leave the existing service running')
            time.sleep(2)
        launcher.activation_preflight(config)
        if config_path.read_bytes() != old_config_bytes or (profile / 'cordis.patch.yml').read_bytes() != old_patch:
            raise RuntimeError('Configuration changed during drain; prepare again')
        checkpoint('backup')
        backup = receipt_path.with_suffix('.backup')
        backup.mkdir(parents=True, exist_ok=False)
        saved = {name: (profile / name).read_bytes() for name in ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']}
        for name, data in saved.items():
            (backup / name).write_bytes(data)
        (backup / 'launcher.json').write_bytes(old_config_bytes)
        before_db = database(db, backup / 'orchestrator.sqlite')
        receipt.update(backup=str(backup), beforeSchema=before_db['schema'], beforeTickets=len(before_db['tickets']))
        checkpoint('stop')
        with launcher.launch_guard(root):
            receipt['stoppedPid'] = launcher.stop_owned(config)
            stopped = True
            # Sources may have persisted more records while dispatch was paused; capture the stopped state too.
            before_db = database(db, backup / 'orchestrator.sqlite')
            receipt['beforeTickets'] = len(before_db['tickets'])
            checkpoint('install')
            installer.install(profile, target['archive'], pnpm_js, Path(config['node']), backup / 'install.json')
            helpers = release_dir / 'activation-helpers'
            helpers.mkdir(exist_ok=True)
            for name, data in target['scripts'].items():
                dest = helpers / name
                if dest.exists() and dest.read_bytes() != data:
                    raise RuntimeError('Immutable release helper changed')
                if not dest.exists():
                    dest.write_bytes(data)
            run([config['node'], helpers / 'check-runtime-peers.mjs', root / 'windows/node_modules/@deepseek-ai/dsh/package.json', profile], operation='peer check')
            if patch_bytes is not None:
                staged = profile / 'cordis.patch.yml.activation'
                staged.write_bytes(patch_bytes)
                staged.replace(profile / 'cordis.patch.yml')
            config['launcherPath'] = str(helpers / 'owner-launcher.py')
            write_json(config_path, config)
        checkpoint('start')
        try:
            run([config['python'], config['launcherPath'], '--config', config_path, '--start-only'], operation='launcher start')
        except RuntimeError as error:
            # A concurrent supervisor may have started the owned instance; the versioned endpoint is authoritative.
            receipt['launcherWarning'] = str(error)
        checkpoint('verify')
        result = verify(config, target['version'], target['commit'], wait_seconds)
        after_db = database(db)
        if not before_db['tickets'].issubset(after_db['tickets']):
            raise RuntimeError('Previously retained tickets are missing after activation')
        paused(config, before_paused)
        receipt.update(status='activated', stage='complete', runtime=result['runtime'], observed=observation(result), afterTickets=len(after_db['tickets']))
        return receipt
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['error'] = str(error) if isinstance(error, (RuntimeError, ValueError)) else type(error).__name__
        if stopped:
            receipt['rollback'] = 'running'
            receipt['failedStage'] = receipt['stage']
            checkpoint('rollback')
            try:
                with launcher.launch_guard(root):
                    current = launcher.state(config)
                    if current:
                        paused(config, True)
                    launcher.stop_owned(config)
                    if database(db)['schema'] != before_db['schema']:
                        raise RuntimeError('Schema changed; preserve current data for explicit recovery, do not restore an old snapshot')
                    for name, data in saved.items():
                        (profile / name).write_bytes(data)
                    config_path.write_bytes(old_config_bytes)
                    config = launcher.validate_config(json.loads(old_config_bytes))
                    run([config['node'], pnpm_js, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', store.parent,
                         '--config.confirmModulesPurge=false'], cwd=profile, operation='rollback install')
                try:
                    run([config['python'], config.get('launcherPath') or Path(__file__).with_name('owner-launcher.py'), '--config', config_path, '--start-only'], operation='rollback launcher start')
                except RuntimeError as error:
                    receipt['rollbackLauncherWarning'] = str(error)
                restored = verify(config, old_build['packageVersion'], old_build['commit'], wait_seconds)
                paused(config, before_paused)
                receipt['rollback'] = 'restored'
                receipt['observed'] = observation(restored)
            except Exception as rollback:
                receipt['rollback'] = 'failed'
                receipt['rollbackError'] = str(rollback) if isinstance(rollback, RuntimeError) else type(rollback).__name__
                try:
                    if database(db)['schema'] != before_db['schema']:
                        raise RuntimeError('Database schema needs explicit recovery')
                    restored = verify(config, old_build['packageVersion'], old_build['commit'], 0)
                    paused(config, before_paused)
                    receipt.update(previousRuntimeAvailable=True, observed=observation(restored))
                except Exception:
                    receipt['resumeError'] = 'Previous runtime could not be confirmed; preserve stop/pause state for recovery'
        elif 'before_paused' in locals() and not preflight_only:
            try:
                paused(config, before_paused)
            except Exception:
                receipt['resumeError'] = 'Could not restore the original dispatch pause state'
        raise
    finally:
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(receipt_path, receipt)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['config', 'release', 'pnpm-js', 'receipt']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--candidate-patch', type=Path)
    parser.add_argument('--wait-seconds', type=int, default=300)
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args()
    try:
        result = activate(args.config.resolve(), args.release.resolve(), args.pnpm_js.resolve(), args.receipt.resolve(),
                          args.candidate_patch.resolve() if args.candidate_patch else None, args.wait_seconds, args.preflight_only)
        print(json.dumps({'status': result['status'], 'stage': result['stage'], 'rollback': result['rollback']}))
    except Exception:
        parser.exit(1, 'Activation failed; inspect the private receipt before another attempt.\n')
