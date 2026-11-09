"""Exercise the one-command installer and self-check with disposable fixtures.

No account, registry or running DSH instance is required: the tests replace
`dsh`, `pnpm` and `git` on PATH and serve the loopback API from memory.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote
import unittest

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')
WINDOWS = sys.platform == 'win32'


def write(path: Path, text: str, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8', newline='\n')
    if executable and not WINDOWS:
        path.chmod(0o755)


def fake_command(bin_dir: Path, name: str, script: Path) -> None:
    if WINDOWS:
        write(bin_dir / f'{name}.cmd', f'@echo off\r\nnode "{script}" %*\r\n')
    else:
        write(bin_dir / name, f'#!/bin/sh\nexec node "{script}" "$@"\n', executable=True)


def patch_text(config) -> str:
    """The managed patch shape the self-check expects, without the private home."""
    return (
        '# Managed by the EnyAgentDesk installer.\n'
        '- id: webserver\n'
        '  config:\n'
        '    host: 127.0.0.1\n'
        f"    port: {config['port']}\n"
        '- id: dsh-superagent\n'
        '  config:\n'
        f"    stateDir: '{config['stateDir']}'\n"
        '- id: dsh-superagent-workbench\n'
        '  disabled: false\n'
        '- id: dsh-superagent-feishu\n'
        '  disabled: false\n'
    )


skip_without_node = unittest.skipUnless(NODE, 'node is required')


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='enyagentdesk-install-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.dsh_home = self.root / 'dsh-home'
        self.state = self.root / 'state'
        self.work = self.root / 'work'
        self.gh = self.root / 'gh-agent'
        self.lark = self.root / 'lark-bot'
        write(self.gh, '#!/bin/sh\necho alice\n', executable=True)
        write(self.lark, '#!/bin/sh\nexit 0\n', executable=True)
        if WINDOWS:
            write(self.gh.with_suffix('.cmd'), '@echo alice\r\n')
            write(self.lark.with_suffix('.cmd'), '@exit /b 0\r\n')
            self.gh = self.gh.with_suffix('.cmd')
            self.lark = self.lark.with_suffix('.cmd')
        self.fake_dsh()
        self.fake_pnpm()
        self.fake_git()
        self.server = None

    def fake_dsh(self):
        script = self.root / 'fake-dsh.mjs'
        write(script, '''
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('0.2.1-rc.3'); process.exit(0) }
const home = process.env.DSH_HOME
if (!home) { console.error('DSH_HOME is missing'); process.exit(1) }
if (args[0] === 'plugin') { process.exit(0) }
if (args.includes('--from-default-profile')) {
  const dir = join(home, 'profiles', args[0])
  if (existsSync(join(dir, 'package.json'))) process.exit(1)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile-test', private: true, dependencies: {} }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\\n')
  console.log('[]')
  process.exit(0)
}
process.exit(0)
''')
        fake_command(self.bin, 'dsh', script)

    def fake_pnpm(self):
        script = self.root / 'fake-pnpm.mjs'
        write(script, '''
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('11.28.10'); process.exit(0) }
process.exit(0)
''')
        fake_command(self.bin, 'pnpm', script)

    def fake_git(self):
        script = self.root / 'fake-git.mjs'
        write(script, '''
if (process.argv.includes('--version')) { console.log('git version 2.55.0'); process.exit(0) }
process.exit(0)
''')
        fake_command(self.bin, 'git', script)

    def config(self, **overrides):
        value = {
            'profile': 'testdesk',
            'dshHome': str(self.dsh_home),
            'port': 3199,
            'stateDir': str(self.state),
            'git': {'name': 'Test Agent', 'email': 'agent@example.com'},
            'github': {'repository': 'acme/widgets', 'cli': str(self.gh), 'agent': 'alice', 'allowed': ['alice']},
            'feishu': {
                'cli': str(self.lark),
                'chat': {'id': 'oc_0123456789abcdef', 'name': 'test chat', 'listen': 'mentions'},
                'allowed': [{'id': 'ou_0123456789abcdef', 'name': 'Alice'}],
                'directMessages': True,
            },
            'executor': {'directory': str(self.work), 'maxWorkers': 2, 'blockedCommands': []},
            'apiKeyEnv': 'DEEPSEEK_API_KEY',
        }
        value.update(overrides)
        return value

    def write_config(self, value):
        path = self.root / 'install.json'
        write(path, json.dumps(value))
        return path

    def environment(self):
        env = {**os.environ, 'PATH': f'{self.bin}{os.pathsep}{os.environ.get("PATH", "")}', 'DEEPSEEK_API_KEY': 'test-key'}
        return env

    def run_node(self, script, config, *args, env=None):
        return subprocess.run(
            [NODE, str(ROOT / script), '--config', str(config), *args],
            cwd=ROOT, env=env or self.environment(), capture_output=True, text=True, encoding='utf-8',
        )

    def seed_profile(self, config):
        profile = Path(config['dshHome']) / 'profiles' / config['profile']
        write(profile / 'package.json', json.dumps({'name': f'profile-{config["profile"]}', 'private': True}))
        write(profile / 'cordis.patch.yml', '[]\n')
        Path(config['stateDir']).mkdir(parents=True, exist_ok=True)

    def install(self, config, *args):
        return self.run_node('scripts/install.mjs', config, *args)

    @skip_without_node
    def test_dry_run_prints_one_config_plan(self):
        result = self.install(self.write_config(self.config()), '--dry-run', '--no-model-key')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('GitHub: acme/widgets as agent alice', result.stdout)
        self.assertIn('Feishu: test chat', result.stdout)
        self.assertIn('nothing was written', result.stdout)
        self.assertFalse(self.dsh_home.exists() and any(self.dsh_home.iterdir()))

    @skip_without_node
    def test_requires_both_sources(self):
        value = self.config()
        del value['feishu']
        result = self.install(self.write_config(value), '--dry-run', '--no-model-key')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('feishu is required', result.stderr)

    @skip_without_node
    def test_refuses_a_shared_state_directory(self):
        other = self.dsh_home / 'profiles' / 'personal'
        write(other / 'cordis.patch.yml', f"- id: dsh-superagent\n  config:\n    stateDir: {self.state}\n")
        result = self.install(self.write_config(self.config()), '--dry-run', '--no-model-key')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already used by profile(s) personal', result.stderr)

    @skip_without_node
    def test_allows_a_state_directory_with_a_shared_prefix(self):
        other = self.dsh_home / 'profiles' / 'personal'
        write(other / 'cordis.patch.yml', f"- id: dsh-superagent\n  config:\n    stateDir: {self.state}-other\n")
        result = self.install(self.write_config(self.config()), '--dry-run', '--no-model-key')
        self.assertEqual(result.returncode, 0, result.stderr)

    @skip_without_node
    def test_installs_profile_from_one_config(self):
        path = self.write_config(self.config())
        result = self.install(path, '--no-start', '--skip-build', '--no-model-key')
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = self.dsh_home / 'profiles' / 'testdesk'
        patch = (profile / 'cordis.patch.yml').read_text(encoding='utf-8')
        self.assertIn('Managed by the EnyAgentDesk installer', patch)
        self.assertIn(f'stateDir: \'{self.state}\'', patch)
        self.assertIn('- id: dsh-superagent-feishu', patch)
        self.assertTrue((profile / '.enyagentdesk-install.json').exists())
        self.assertTrue(self.state.is_dir())
        self.assertTrue(self.work.is_dir())

        checked = self.run_node('scripts/self-check.mjs', path, '--offline')
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)

    @skip_without_node
    def test_self_check_reads_the_loopback_api(self):
        value = self.config()
        path = self.write_config(value)
        self.seed_profile(value)
        self.serve(value)
        patch = self.dsh_home / 'profiles' / value['profile'] / 'cordis.patch.yml'
        write(patch, patch_text(value))
        write(self.dsh_home / 'profiles' / value['profile'] / '.enyagentdesk-install.json',
              json.dumps({'profile': value['profile'], 'stateDir': value['stateDir'], 'dshHome': value['dshHome']}))
        result = self.run_node('scripts/self-check.mjs', path, '--json')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload['ok'], payload)
        self.assertTrue(all(row['ok'] for row in payload['results']), payload)

        self.fake['state']['setup']['feishuProblem'] = {'detail': 'bot is not in the chat'}
        result = self.run_node('scripts/self-check.mjs', path)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Feishu setup', result.stdout)

    @skip_without_node
    def test_apply_only_saves_both_sources(self):
        value = self.config()
        value['executor']['model'] = {'provider': 'deepseek', 'model': 'deepseek-flash', 'reasoningEffort': 'high'}
        path = self.write_config(value)
        self.seed_profile(value)
        self.serve(value)
        write(self.dsh_home / 'profiles' / value['profile'] / 'cordis.patch.yml', patch_text(value))
        write(self.dsh_home / 'profiles' / value['profile'] / '.enyagentdesk-install.json',
              json.dumps({'profile': value['profile'], 'stateDir': value['stateDir'], 'dshHome': value['dshHome']}))
        result = self.run_node('scripts/install.mjs', path, '--apply-only')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        blocks = {name: body for name, body in self.fake['puts']}
        self.assertEqual(blocks['source:github']['value']['config']['repository'], 'acme/widgets')
        self.assertEqual(blocks['source:feishu']['value']['config']['chats'][0]['chatId'], 'oc_0123456789abcdef')
        self.assertEqual(blocks['policy']['value']['sources']['github']['allowed'], [{'id': 'alice'}])
        self.assertEqual(blocks['policy']['value']['sources']['feishu']['syncChat'], '')
        self.assertEqual(blocks['executor']['value']['directory'], value['executor']['directory'])
        self.assertEqual(blocks['executor']['value']['model'], value['executor']['model'])
        self.assertEqual(blocks['executor']['value']['prepare'], '')
        self.assertIn('All checks passed', result.stdout)

    @skip_without_node
    def test_apply_only_refuses_a_foreign_instance(self):
        value = self.config()
        path = self.write_config(value)
        self.seed_profile(value)
        self.serve(value)
        write(self.dsh_home / 'profiles' / value['profile'] / 'cordis.patch.yml', patch_text(value))
        write(self.dsh_home / 'profiles' / value['profile'] / '.enyagentdesk-install.json',
              json.dumps({'profile': value['profile'], 'stateDir': value['stateDir'], 'dshHome': value['dshHome']}))
        self.fake['state']['setup']['machine']['stateDir'] = str(self.root / 'other-state')
        result = self.run_node('scripts/install.mjs', path, '--apply-only')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('belongs to another installation', result.stderr)
        self.assertEqual(self.fake['puts'], [])

    def serve(self, config):
        self.fake = {
            'puts': [],
            'state': {'health': {'runtime': {'state': 'ready'}},
                      'setup': {'problem': None, 'feishuProblem': None, 'machine': {'stateDir': config['stateDir']}}},
            'settings': {
                'blocks': {
                    'policy': {'revision': 1, 'value': {'rules': [], 'sources': {
                        'github': {'allowed': [{'id': 'alice'}], 'bots': []},
                        'feishu': {'allowed': [{'id': 'ou_0123456789abcdef', 'name': 'Alice'}], 'syncChat': '', 'admission': {}},
                    }}},
                    'executor': {'revision': 1, 'value': {'model': None, 'maxWorkers': 2, 'directory': config['executor']['directory'],
                                                        'prepare': '', 'blockedCommands': [], 'proxy': ''}},
                },
                'sources': [
                    {'id': 'github', 'kind': 'github', 'value': {'enabled': True, 'config': {'repository': config['github']['repository'], 'cli': config['github']['cli']}}, 'revision': 1},
                    {'id': 'feishu', 'kind': 'feishu', 'value': {'enabled': True, 'config': {'chats': [{'chatId': config['feishu']['chat']['id']}], 'cli': config['feishu']['cli']}}, 'revision': 1},
                ],
            },
            'sources': [{'id': 'github', 'state': 'ready'}, {'id': 'feishu', 'state': 'ready'}],
        }
        fake = self.fake

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                name = self.path.rsplit('/', 1)[-1]
                if name not in fake:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = json.dumps(fake[name]).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_PUT(self):  # noqa: N802
                length = int(self.headers.get('content-length', '0'))
                payload = json.loads(self.rfile.read(length))
                name = unquote(self.path.rsplit('/', 1)[-1])
                fake['puts'].append((name, payload))
                if name.startswith('source:'):
                    kind = name.split(':', 1)[1]
                    source = next(row for row in fake['settings']['sources'] if row['kind'] == kind)
                    source['value'] = payload['value']
                    source['revision'] += 1
                    revision = source['revision']
                else:
                    block = fake['settings']['blocks'][name]
                    block['value'] = payload['value']
                    block['revision'] += 1
                    revision = block['revision']
                body = json.dumps({'saved': True, 'revision': revision, 'policy_changed': False, 'restarting': False}).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server = server
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        config['port'] = server.server_address[1]
        # The normalized config is written again so the check uses the real port.
        write(self.root / 'install.json', json.dumps(config))
        return server.server_address[1]


if __name__ == '__main__':
    unittest.main()
