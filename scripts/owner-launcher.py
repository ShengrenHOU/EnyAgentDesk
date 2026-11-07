"""Local owner entry; private configuration and credentials stay outside this repo."""
import argparse
from contextlib import contextmanager
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser


def validate_config(config):
    if type(config['port']) is not int or not 1 <= config['port'] <= 65535:
        raise ValueError('Invalid local port')
    for key in ['runtime', 'node', 'python', 'broker']:
        if not Path(config[key]).is_absolute() or not Path(config[key]).exists():
            raise ValueError('Supply existing absolute runtime and executable paths')
    root = Path(config['runtime']).resolve()
    if config.get('stateDir') and not Path(config['stateDir']).is_absolute():
        raise ValueError('stateDir must be an absolute path')
    for key, default in {'profile': 'superagent', 'home': 'windows-home', 'logName': 'windows-server.log',
                         'receiptName': 'windows-launcher.json', 'stopMarker': 'owner-manually-stopped'}.items():
        value = config.get(key, default)
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value):
            raise ValueError(f'{key} must be a single local identifier')
        if key != 'profile' and (root / value).resolve().parent != root:
            raise ValueError(f'{key} must stay inside the runtime directory')
        config[key] = value
    if (root / (config['receiptName'] + '.tmp')).resolve().parent != root:
        raise ValueError('The receipt temporary file must stay inside the runtime directory')
    return config


def ready(result):
    if result is None or result['health']['runtime']['state'] != 'ready':
        return False
    setup = result['setup']
    if setup.get('problem') or setup.get('feishuProblem'):
        return False
    feishu = (setup.get('accounts') or {}).get('feishu')
    return not feishu or result['health'].get('feishu', {}).get('state') == 'ready'


def state(config):
    request = urllib.request.Request(f"http://127.0.0.1:{config['port']}/orchestrator/api/state",
                                     headers={'x-orchestrator-request': '1'})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=3) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError('The port is occupied but the management endpoint refused the request') from error
    except urllib.error.URLError as error:
        if isinstance(error.reason, ConnectionRefusedError):
            return None
        raise RuntimeError('Could not determine whether the local listener is running') from error
    accounts = result['setup']['accounts']
    if config.get('stateDir'):
        actual = result['setup'].get('machine', {}).get('stateDir')
        if not actual or Path(actual).resolve() != Path(config['stateDir']).resolve():
            raise RuntimeError('The listener belongs to another state directory')
    elif accounts is not None and accounts['repository'] != config['repository']:
        raise RuntimeError('The listener belongs to another repository')
    return result


@contextmanager
def launch_guard(root):
    # OS file locks release on process exit, including a crashed launcher.
    with (root / 'owner-launch.lock').open('a+b') as lock:
        lock.seek(0, 2)
        if lock.tell() == 0:
            lock.write(b'0'); lock.flush()
        lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def spawn(config):
    root = Path(config['runtime'])
    if not os.environ.get('DEEPSEEK_API_KEY'):
        raise RuntimeError('Start through the secret broker')
    env = os.environ.copy()
    for key in ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_APP_TOOLS_PIPE_PATH',
                'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_PERMISSION_PROFILE']:
        env.pop(key, None)
    env.update(DSH_HOME=str(root / config.get('home', 'windows-home')), LARKSUITE_CLI_CONFIG_DIR=str(root / 'lark'),
               LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1')
    if config.get('shellDirectory'):
        env['PATH'] = config['shellDirectory'] + os.pathsep + env.get('PATH', '')
    log_path = root / config.get('logName', 'windows-server.log')
    result = None
    for attempt in range(2):
        result = None
        with log_path.open('ab') as log:
            offset = log.tell()
            process = subprocess.Popen([config['node'], str(root / 'windows/node_modules/@deepseek-ai/dsh/lib/bin.js'),
                                        config.get('profile', 'superagent'), '--no-open'], cwd=root, env=env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        locked = False
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError('The runtime exited during startup; inspect its private log')
            try:
                result = state(config)
            except (RuntimeError, json.JSONDecodeError, TimeoutError):
                # This owned process may be serving HTTP before its plugin routes register.
                result = None
            if result is not None and result['health']['runtime']['state'] == 'ready':
                break
            with log_path.open('rb') as log:
                log.seek(offset)
                locked = b'dsh-superagent (dsh-superagent): Error: Lock file is already being held' in log.read()
            if locked:
                break
            time.sleep(1)
        if not locked:
            break
        process.terminate(); process.wait(timeout=5)
        if attempt:
            raise RuntimeError('The runtime state lock is still held; inspect the owning process and private log')
        # An interrupted process can leave a lock fresh for 30 seconds; the lock library reclaims it once stale.
        time.sleep(35)
    if result is None:
        process.terminate(); process.wait(timeout=5)
        raise RuntimeError('The runtime did not expose its management endpoint')
    # Never replace the handle with a process that already failed its port/lock check.
    if process.poll() is not None:
        raise RuntimeError('The runtime exited before its startup receipt')
    receipt = root / (config.get('receiptName', 'windows-launcher.json') + '.tmp')
    receipt.write_text(json.dumps({'pid': process.pid, 'profile': config.get('profile', 'superagent')}), encoding='utf-8')
    receipt.replace(root / config.get('receiptName', 'windows-launcher.json'))


def ensure_running(config, config_path, respect_stop=False):
    marker = Path(config['runtime']) / config.get('stopMarker', 'owner-manually-stopped')
    result = state(config)
    if result is not None and (respect_stop or not marker.exists()):
        return result
    with launch_guard(Path(config['runtime'])):
        if respect_stop and marker.exists():
            return result
        marker.unlink(missing_ok=True)
        result = state(config)
        if result is None:
            subprocess.run([config['broker'], 'run', '--map', 'DEEPSEEK_API_KEY=DEEPSEEK_API_KEY', '--',
                            config['python'], str(Path(__file__).resolve()), '--config', str(config_path), '--spawn'],
                           check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            result = state(config)
        if result is None:
            raise RuntimeError('The runtime did not remain available')
        return result


def open_panel(config):
    log = (Path(config['runtime']) / config.get('logName', 'windows-server.log')).read_text(encoding='utf-8', errors='replace')
    urls = re.findall(r'dsh web:\s+(http://127\.0\.0\.1:' + str(config['port']) + r'/\S+)', log)
    if not urls or not webbrowser.open(urls[-1].split('#', 1)[0] + '#main-conversation', new=0):
        raise RuntimeError('Could not open the native panel')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--start-only', action='store_true')
    parser.add_argument('--spawn', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--respect-stop', action='store_true', help='Preserve an intentional stop during automatic recovery')
    parser.add_argument('--mark-stopped', action='store_true', help='Record operator stop intent before stopping the owned runtime')
    args = parser.parse_args()
    try:
        config = validate_config(json.loads(args.config.read_text(encoding='utf-8')))
        marker = Path(config['runtime']) / config['stopMarker']
        if args.mark_stopped:
            with launch_guard(Path(config['runtime'])):
                marker.write_text('Operator requested stop\n', encoding='utf-8')
            print(json.dumps({'manually_stopped': True}))
            return
        if args.spawn:
            spawn(config)
            return
        result = state(config) if args.status else ensure_running(config, args.config.resolve(), args.respect_stop)
        if args.status or args.start_only:
            print(json.dumps({'ready': ready(result), 'running': result is not None, 'repository': ((result or {}).get('setup', {}).get('accounts') or {}).get('repository'),
                              'load': result['load'] if result else None, 'manually_stopped': marker.exists()}))
        else:
            open_panel(config)
    except Exception:
        if args.status or args.start_only or args.spawn or os.name != 'nt':
            raise
        ctypes.windll.user32.MessageBoxW(None, '启动或连接检查失败。请保留原工单，在Codex中检查代理工作系统；若正在启动，请稍后再打开。', '个人代理工作系统', 16)


if __name__ == '__main__':
    main()
