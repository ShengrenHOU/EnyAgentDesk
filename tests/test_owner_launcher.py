import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/owner-launcher.py'
spec = importlib.util.spec_from_file_location('owner_launcher', SCRIPT)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class OwnerLauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'runtime': str(self.root), 'port': 3083, 'repository': 'owner/lab', 'node': 'node',
                       'broker': 'broker', 'python': sys.executable}
        self.ready = {'setup': {'accounts': {'repository': 'owner/lab'}}, 'health': {'runtime': {'state': 'ready'}}}
        self.credential_probe = patch.object(launcher, 'check_start_credential')
        self.mock_credential_probe = self.credential_probe.start()
        self.addCleanup(self.credential_probe.stop)

    def test_activation_refuses_a_broken_credential_consumer_before_other_probes(self):
        config = launcher.validate_config(self.platform_config())
        self.mock_credential_probe.side_effect = RuntimeError('Credential consumer preflight failed')
        with patch.object(launcher, 'state', return_value=self.ready), patch.object(launcher.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Credential consumer'):
                launcher.activation_preflight(config)
        run.assert_not_called()
        self.assertFalse((self.root / config['stopMarker']).exists())

    def test_start_credential_probe_checks_the_real_consumer_and_sanitizes_failure(self):
        self.credential_probe.stop()
        with patch.object(launcher.subprocess, 'run') as run:
            launcher.check_start_credential(self.config)
        self.assertEqual(run.call_args.args[0][:6], ['broker', 'run', '--map', 'DEEPSEEK_API_KEY=DEEPSEEK_API_KEY', '--', sys.executable])
        self.assertTrue(run.call_args.kwargs['check'])
        self.assertTrue(run.call_args.kwargs['capture_output'])
        failure = subprocess.CalledProcessError(103, ['broker'], stderr=b'SYNTHETIC_PRIVATE_VALUE')
        with patch.object(launcher.subprocess, 'run', side_effect=failure):
            with self.assertRaises(RuntimeError) as caught:
                launcher.check_start_credential(self.config)
        self.assertNotIn('SYNTHETIC_PRIVATE_VALUE', str(caught.exception))

    def test_dependency_consumer_failure_keeps_activation_and_start_from_spawning(self):
        config = launcher.validate_config(self.platform_config(
            preflightCommands=[[sys.executable, '-c', 'raise SystemExit(1)']]))
        failure = subprocess.CalledProcessError(1, ['private-probe'], stderr=b'SYNTHETIC_PRIVATE_VALUE')
        receipt = self.root / config['receiptName']
        receipt.write_text('{"pid":123}', encoding='utf-8')
        with patch.object(launcher, 'state', return_value=self.ready), \
                patch.object(launcher.subprocess, 'run', side_effect=failure), \
                patch.object(launcher.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'Dependency consumer 1') as caught:
                launcher.activation_preflight(config)
            with patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'synthetic-test-key'}), \
                    self.assertRaisesRegex(RuntimeError, 'Dependency consumer 1'):
                launcher.spawn(config)
        spawn.assert_not_called()
        self.assertNotIn('SYNTHETIC_PRIVATE_VALUE', str(caught.exception))
        self.assertEqual(receipt.read_text(), '{"pid":123}')
        self.assertFalse((self.root / config['stopMarker']).exists())

    def test_dependency_checks_use_argument_arrays_and_the_startup_environment(self):
        config = self.platform_config(preflightCommands=[[sys.executable, '-c', 'import mcp']])
        with patch.object(launcher.subprocess, 'run') as run:
            launcher.check_start_dependencies(config)
        self.assertEqual(run.call_args.args[0], config['preflightCommands'][0])
        self.assertEqual(run.call_args.kwargs['env']['DSH_HOME'], str(self.root / 'native-home'))
        self.assertTrue(run.call_args.kwargs['capture_output'])
        self.assertFalse(run.call_args.kwargs.get('shell', False))
        for commands in ['shell command', [[]], [['relative-program']], [[sys.executable, 1]]]:
            with self.subTest(commands=commands), self.assertRaises(ValueError):
                launcher.validate_config(self.platform_config(preflightCommands=commands))

    @unittest.skipUnless(sys.platform == 'win32', 'Windows scheduled-task wrapper')
    def test_supervisor_uses_launcher_stop_semantics_and_reports_failure_without_secrets(self):
        source = SCRIPT.with_name('owner-supervisor.ps1')
        (self.root / source.name).write_bytes(source.read_bytes())
        config = self.root / 'config.json'
        config.write_text(json.dumps(self.config), encoding='utf-8')
        shell = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
        for name, response, code in [
            ('stopped', {'manually_stopped': True, 'running': False}, 0),
            ('degraded', {'manually_stopped': False, 'running': True, 'repository': None}, 0),
            ('missing', {'manually_stopped': False, 'running': False}, 1),
        ]:
            with self.subTest(name=name):
                (self.root / 'owner-launcher.py').write_text(
                    'import sys\nassert "--respect-stop" in sys.argv\nprint(' + repr(json.dumps(response)) + ')\n', encoding='utf-8')
                result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                    str(self.root / source.name), '-Config', str(config)], capture_output=True, timeout=20)
                self.assertEqual(result.returncode, code, result.stderr.decode(errors='replace'))
        receipts = list((self.root / 'watchdog').glob('*.json'))
        self.assertEqual(len(receipts), 1)
        self.assertFalse(receipts[0].read_bytes().startswith(b'\xef\xbb\xbf'))
        self.assertEqual(json.loads(receipts[0].read_text())['result'], 'failed')

    def opener(self, result=None, error=None):
        opener = MagicMock()
        if error:
            opener.open.side_effect = error
        else:
            opener.open.return_value.__enter__.return_value = io.StringIO(json.dumps(result))
        return patch.object(launcher.urllib.request, 'build_opener', return_value=opener)

    @unittest.skipUnless(sys.platform == 'win32', 'Windows scheduled-task wrapper')
    def test_supervisor_follows_validated_listener_even_with_stale_startup_receipt(self):
        source = SCRIPT.with_name('owner-supervisor.ps1')
        (self.root / source.name).write_bytes(source.read_bytes())
        (self.root / 'windows-launcher.json').write_text('{"pid":123}', encoding='utf-8')
        (self.root / 'owner-launcher.py').write_text(
            'print(\'{"running":true,"repository":null,"manually_stopped":false}\')', encoding='utf-8')
        config = self.root / 'config.json'
        config.write_text(json.dumps(self.config), encoding='utf-8')
        wrapper = self.root / 'test.ps1'
        wrapper.write_text('param($Config)\n'
            'function Get-NetTCPConnection { [pscustomobject]@{OwningProcess=456} }\n'
            'function Wait-Process { param($Id) [IO.File]::WriteAllText((Join-Path $PSScriptRoot "waited.txt"), [string]$Id) }\n'
            '& (Join-Path $PSScriptRoot "owner-supervisor.ps1") -Config $Config\n', encoding='utf-8')
        shell = str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
        result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(wrapper),
            '-Config', str(config)], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.assertEqual((self.root / 'waited.txt').read_text(), '456')

    def valid_config(self, **overrides):
        return {**self.config, 'node': sys.executable, 'broker': sys.executable, **overrides}

    def platform_config(self, **overrides):
        return self.valid_config(profile='native-lab', home='native-home', port=3086,
                                 logName='native-lab-server.log', receiptName='native-lab-launcher.json',
                                 stopMarker='platform-manually-stopped', **overrides)

    def test_legacy_configuration_keeps_its_profile_paths(self):
        config = launcher.validate_config(self.valid_config())
        self.assertEqual({key: config[key] for key in ['profile', 'home', 'logName', 'receiptName', 'stopMarker']},
                         {'profile': 'superagent', 'home': 'windows-home', 'logName': 'windows-server.log',
                          'receiptName': 'windows-launcher.json', 'stopMarker': 'owner-manually-stopped'})

    def test_profile_files_and_identifiers_are_confined_to_the_runtime(self):
        for key in ['profile', 'home', 'logName', 'receiptName', 'stopMarker']:
            for value in ['../other', '..', '/absolute', 'C:\\outside', 'a/b', 'a\\b', '--option', '']:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    launcher.validate_config(self.valid_config(**{key: value}))
        for port in [True, 0, 65536, '3086']:
            with self.subTest(port=port), self.assertRaises(ValueError):
                launcher.validate_config(self.valid_config(port=port))
        outside = self.root.parent / 'external-home'
        def resolved(path):
            return outside if path == self.root / 'native-home' else path
        with patch.object(launcher.Path, 'resolve', autospec=True, side_effect=resolved), self.assertRaises(ValueError):
            launcher.validate_config(self.platform_config())

    def test_explicit_profile_uses_its_home_log_receipt_and_scrubs_parent_codex_identity(self):
        config = launcher.validate_config(self.platform_config())
        process = MagicMock(pid=789)
        process.poll.return_value = None
        identity = {key: 'parent-chat' for key in ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID',
                    'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
                    'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_PERMISSION_PROFILE']}
        with patch.dict(launcher.os.environ, {**identity, 'CODEX_HOME': str(self.root / 'codex-home'),
                                             'DEEPSEEK_API_KEY': 'synthetic-test-key'}), \
                patch.object(launcher.subprocess, 'Popen', return_value=process) as start, \
                patch.object(launcher, 'state', return_value=self.ready):
            launcher.spawn(config)
        self.assertEqual(start.call_args.args[0][-2:], ['native-lab', '--no-open'])
        env = start.call_args.kwargs['env']
        self.assertEqual(env['DSH_HOME'], str(self.root / 'native-home'))
        self.assertEqual(env['CODEX_HOME'], str(self.root / 'codex-home'))
        self.assertTrue(all(key not in env for key in identity))
        self.assertTrue((self.root / 'native-lab-server.log').is_file())
        self.assertEqual(json.loads((self.root / 'native-lab-launcher.json').read_text()), {'pid': 789, 'profile': 'native-lab'})
        self.assertFalse((self.root / 'windows-launcher.json').exists())

    def test_personal_only_profile_is_ready_without_feishu_and_empty_repository_is_owned(self):
        personal = {'setup': {'accounts': {'repository': ''}, 'problem': None, 'feishuProblem': None},
                    'health': {'runtime': {'state': 'ready'}}, 'load': {'running': 0}}
        config = self.platform_config(repository='')
        with self.opener(personal):
            self.assertEqual(launcher.state(config), personal)
        self.assertTrue(launcher.ready(personal))
        personal['setup']['accounts']['feishu'] = {'appId': 'configured-bot'}
        self.assertFalse(launcher.ready(personal))
        personal['health']['feishu'] = {'state': 'ready'}
        self.assertTrue(launcher.ready(personal))
        personal['health']['feishu']['state'] = 'starting'
        self.assertFalse(launcher.ready(personal))
        personal['health']['feishu']['state'] = 'ready'
        personal['setup']['feishuProblem'] = {'code': 'missing-scope'}
        self.assertFalse(launcher.ready(personal))

    def test_custom_manual_stop_is_independent_and_marked_by_the_normal_entry(self):
        config = self.platform_config()
        marker = self.root / config['stopMarker']
        old_marker = self.root / 'owner-manually-stopped'
        old_marker.write_text('old profile stopped', encoding='utf-8')
        with patch.object(launcher, 'state', side_effect=[None, None, self.ready]), \
                patch.object(launcher.subprocess, 'run', return_value=MagicMock(stdout=json.dumps(self.ready))) as run:
            launcher.ensure_running(config, self.root / 'platform-config.json', respect_stop=True)
            run.assert_called_once()
        self.assertTrue(old_marker.exists())
        path = self.root / 'platform-config.json'
        path.write_text(json.dumps(config), encoding='utf-8')
        with patch.object(sys, 'argv', ['owner-launcher', '--config', str(path), '--mark-stopped']), patch.object(sys, 'stdout', io.StringIO()):
            launcher.main()
        self.assertTrue(marker.exists())
        with patch.object(launcher, 'state', return_value=None), patch.object(launcher.subprocess, 'run') as run:
            self.assertIsNone(launcher.ensure_running(config, path, respect_stop=True))
            run.assert_not_called()

    def test_status_reports_readiness_for_an_empty_repository_profile(self):
        config = self.platform_config(repository='')
        path = self.root / 'platform-config.json'
        path.write_text(json.dumps(config), encoding='utf-8')
        personal = {'setup': {'accounts': {'repository': ''}}, 'health': {'runtime': {'state': 'ready'}}, 'load': {'running': 0}}
        output = io.StringIO()
        with patch.object(sys, 'argv', ['owner-launcher', '--config', str(path), '--status']), \
                patch.object(launcher, 'state', return_value=personal), patch.object(sys, 'stdout', output):
            launcher.main()
        self.assertEqual(json.loads(output.getvalue()), {'ready': True, 'running': True, 'repository': '', 'load': {'running': 0}, 'manually_stopped': False})

    def test_only_connection_refused_is_treated_as_not_running(self):
        with self.opener(error=urllib.error.URLError(ConnectionRefusedError())):
            self.assertIsNone(launcher.state(self.config))
        for error in [urllib.error.HTTPError('http://127.0.0.1:3083', 401, 'Unauthorized', {}, None),
                      urllib.error.URLError(TimeoutError())]:
            with self.opener(error=error), self.assertRaises(RuntimeError):
                launcher.state(self.config)

    def test_existing_expected_listener_is_reused_and_foreign_listener_refused(self):
        with self.opener(self.ready), patch.object(launcher.subprocess, 'run') as run:
            self.assertEqual(launcher.ensure_running(self.config, self.root / 'config.json'), self.ready)
            run.assert_not_called()
        self.ready['setup']['accounts']['repository'] = 'other/repo'
        with self.opener(self.ready), self.assertRaises(RuntimeError):
            launcher.state(self.config)

    def test_instance_identity_survives_github_degradation(self):
        config = {**self.config, 'stateDir': str(self.root / 'state')}
        result = {'setup': {'accounts': {'repository': ''}, 'machine': {'stateDir': config['stateDir']}},
                  'health': {'runtime': {'state': 'ready'}}}
        with self.opener(result):
            self.assertEqual(launcher.state(config), result)
        result['setup']['machine']['stateDir'] = str(self.root / 'other')
        with self.opener(result), self.assertRaisesRegex(RuntimeError, 'another state directory'):
            launcher.state(config)

    def test_start_is_brokered_only_after_rechecking_under_the_lock(self):
        with patch.object(launcher, 'state', side_effect=[None, self.ready]), patch.object(launcher.subprocess, 'run') as run:
            launcher.ensure_running(self.config, self.root / 'config.json')
            run.assert_not_called()
        with patch.object(launcher, 'state', side_effect=[None, None, self.ready]), \
                patch.object(launcher.subprocess, 'run', return_value=MagicMock(stdout=json.dumps(self.ready))) as run:
            launcher.ensure_running(self.config, self.root / 'config.json')
            self.assertIn('DEEPSEEK_API_KEY=DEEPSEEK_API_KEY', run.call_args.args[0])
            self.assertIn('--spawn', run.call_args.args[0])

    def test_failed_start_does_not_overwrite_the_existing_process_receipt(self):
        receipt = self.root / 'windows-launcher.json'
        receipt.write_text('{"pid":123}', encoding='utf-8')
        process = MagicMock()
        process.poll.return_value = 1
        with patch.dict(launcher.os.environ, {'DEEPSEEK_API_KEY': 'synthetic-test-key'}), \
                patch.object(launcher.subprocess, 'Popen', return_value=process), self.assertRaises(RuntimeError):
            launcher.spawn(self.config)
        self.assertEqual(json.loads(receipt.read_text())['pid'], 123)

    def test_recovery_respects_manual_stop_and_explicit_start_clears_it(self):
        marker = self.root / 'owner-manually-stopped'
        marker.write_text('stop', encoding='utf-8')
        with patch.object(launcher, 'state', return_value=None), patch.object(launcher.subprocess, 'run') as run:
            self.assertIsNone(launcher.ensure_running(self.config, self.root / 'config.json', respect_stop=True))
            run.assert_not_called()
            self.assertTrue(marker.exists())
        with patch.object(launcher, 'state', side_effect=[None, None, self.ready]), \
                patch.object(launcher.subprocess, 'run', return_value=MagicMock(stdout=json.dumps(self.ready))) as run:
            self.assertEqual(launcher.ensure_running(self.config, self.root / 'config.json'), self.ready)
            run.assert_called_once()
            self.assertFalse(marker.exists())

    def test_stop_marker_set_during_probe_prevents_recovery(self):
        marker = self.root / 'owner-manually-stopped'
        def probe(_config):
            marker.write_text('stop', encoding='utf-8')
            return None
        with patch.object(launcher, 'state', side_effect=probe), patch.object(launcher.subprocess, 'run') as run:
            self.assertIsNone(launcher.ensure_running(self.config, self.root / 'config.json', respect_stop=True))
            run.assert_not_called()

    def test_own_startup_can_wait_for_routes_before_publishing_its_handle(self):
        process = MagicMock(pid=456)
        process.poll.return_value = None
        with patch.dict(launcher.os.environ, {'DEEPSEEK_API_KEY': 'synthetic-test-key'}), \
                patch.object(launcher.subprocess, 'Popen', return_value=process), \
                patch.object(launcher, 'state', side_effect=[TimeoutError('slow HTTP'), RuntimeError('routes starting'), self.ready]), \
                patch.object(launcher.time, 'sleep'):
            launcher.spawn(self.config)
        self.assertEqual(json.loads((self.root / 'windows-launcher.json').read_text())['pid'], 456)

    def test_stale_state_lock_retries_once_without_removing_it(self):
        lock = self.root / 'state.lock'
        lock.mkdir()
        first, second = MagicMock(pid=111), MagicMock(pid=222)
        first.poll.return_value = second.poll.return_value = None
        def start(*args, **kwargs):
            if start.calls == 0:
                (self.root / 'windows-server.log').write_bytes(b'dsh-superagent (dsh-superagent): Error: Lock file is already being held\n')
            start.calls += 1
            return [first, second][start.calls - 1]
        start.calls = 0
        with patch.dict(launcher.os.environ, {'DEEPSEEK_API_KEY': 'synthetic-test-key'}), \
                patch.object(launcher.subprocess, 'Popen', side_effect=start), \
                patch.object(launcher, 'state', side_effect=[None, self.ready]), \
                patch.object(launcher.time, 'sleep') as sleep:
            launcher.spawn(self.config)
        first.terminate.assert_called_once()
        second.terminate.assert_not_called()
        sleep.assert_called_once_with(35)
        self.assertTrue(lock.is_dir())
        self.assertEqual(json.loads((self.root / 'windows-launcher.json').read_text())['pid'], 222)

    def test_slow_start_is_not_killed_after_thirty_seconds(self):
        process = MagicMock(pid=333)
        process.poll.return_value = None
        with patch.dict(launcher.os.environ, {'DEEPSEEK_API_KEY': 'synthetic-test-key'}), \
                patch.object(launcher.subprocess, 'Popen', return_value=process), \
                patch.object(launcher, 'state', side_effect=[None] * 31 + [self.ready]), \
                patch.object(launcher.time, 'sleep'):
            launcher.spawn(self.config)
        process.terminate.assert_not_called()
        self.assertEqual(json.loads((self.root / 'windows-launcher.json').read_text())['pid'], 333)

    def test_live_state_lock_stops_after_one_retry(self):
        process = MagicMock(pid=444)
        process.poll.return_value = None
        def start(*args, **kwargs):
            with (self.root / 'windows-server.log').open('ab') as log:
                log.write(b'dsh-superagent (dsh-superagent): Error: Lock file is already being held\n')
            return process
        with patch.dict(launcher.os.environ, {'DEEPSEEK_API_KEY': 'synthetic-test-key'}), \
                patch.object(launcher.subprocess, 'Popen', side_effect=start) as popen, \
                patch.object(launcher, 'state', return_value=None), \
                patch.object(launcher.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'lock is still held'):
            launcher.spawn(self.config)
        self.assertEqual(popen.call_count, 2)
        self.assertEqual(process.terminate.call_count, 2)
        self.assertFalse((self.root / 'windows-launcher.json').exists())

    def test_concurrent_launcher_cannot_acquire_the_same_os_lock(self):
        code = ('import importlib.util,sys; from pathlib import Path\n'
                's=importlib.util.spec_from_file_location("launcher",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\n'
                'with m.launch_guard(Path(sys.argv[2])): print("unexpected lock")\n')
        with launcher.launch_guard(self.root):
            result = subprocess.run([sys.executable, '-c', code, str(SCRIPT), str(self.root)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        with launcher.launch_guard(self.root):
            pass

    def test_activation_refuses_changed_bot_mode_without_touching_the_running_service(self):
        config = launcher.validate_config(self.platform_config())
        current = {**self.ready, 'setup': {'accounts': {'feishu': {'appId': 'cli_test', 'botId': 'ou_test'}}},
                   'health': {**self.ready['health'], 'feishu': {'state': 'ready'}}, 'load': {'running': 0, 'queued': 0}}
        settings = {'sources': [{'kind': 'feishu', 'value': {'enabled': True, 'config': {'cli': 'test-lark'}}}]}
        receipt = self.root / config['receiptName']
        receipt.write_text('{"pid":123}', encoding='utf-8')
        for mode, bot in [('user', 'ready'), ('bot', 'not_configured')]:
            with self.subTest(mode=mode, bot=bot), patch.object(launcher, 'state', return_value=current), \
                    self.opener(settings), patch.object(launcher.subprocess, 'Popen') as spawn, \
                    patch.object(launcher.subprocess, 'run', side_effect=[
                        MagicMock(stdout=json.dumps({'appId': 'cli_test', 'identities': {'bot': {'status': bot}}})),
                        MagicMock(stdout='strict-mode: ' + mode + ' (source: profile)'),
                        MagicMock(stdout=json.dumps({'bot': {'open_id': 'ou_test'}})),
                    ]), self.assertRaisesRegex(RuntimeError, 'Feishu'):
                launcher.activation_preflight(config)
            spawn.assert_not_called()
            self.assertEqual(receipt.read_text(), '{"pid":123}')
            self.assertFalse((self.root / config['stopMarker']).exists())

    def test_activation_checks_the_configured_bot_in_the_startup_environment(self):
        config = launcher.validate_config(self.platform_config())
        current = {**self.ready, 'setup': {'accounts': {'feishu': {'appId': 'cli_test', 'botId': 'ou_test'}}},
                   'health': {**self.ready['health'], 'feishu': {'state': 'ready'}}, 'load': {'running': 0, 'queued': 0}}
        settings = {'sources': [{'kind': 'feishu', 'value': {'enabled': True, 'config': {'cli': 'test-lark'}}}]}
        with patch.object(launcher, 'state', return_value=current), self.opener(settings), \
                patch.dict(os.environ, {'LARKSUITE_CLI_CONFIG_DIR': 'wrong-user-profile'}), \
                patch.object(launcher.subprocess, 'run', side_effect=[
                    MagicMock(stdout=json.dumps({'appId': 'cli_test', 'identities': {'bot': {'status': 'ready'}}})),
                    MagicMock(stdout='strict-mode: bot (source: profile)'),
                    MagicMock(stdout=json.dumps({'bot': {'open_id': 'ou_test'}})),
                ]) as probe:
            launcher.activation_preflight(config)
        self.assertEqual(probe.call_args.args[0], ['test-lark', 'api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'])
        self.assertTrue(all(call.kwargs['env']['LARKSUITE_CLI_CONFIG_DIR'] == str(self.root / 'lark') for call in probe.call_args_list))

    def test_activation_checks_bot_directory_without_changing_user_default(self):
        config = launcher.validate_config(self.platform_config())
        bot_dir = str(self.root / 'bot-profile')
        current = {**self.ready, 'setup': {'accounts': {'feishu': {'appId': 'cli_test', 'botId': 'ou_test'}}},
                   'health': {**self.ready['health'], 'feishu': {'state': 'ready'}}, 'load': {'running': 0, 'queued': 0}}
        settings = {'sources': [{'kind': 'feishu', 'value': {'enabled': True, 'config': {'cli': 'test-lark', 'configDir': bot_dir}}}]}
        with patch.object(launcher, 'state', return_value=current), self.opener(settings), \
                patch.object(launcher.subprocess, 'run', side_effect=[
                    MagicMock(stdout=json.dumps({'appId': 'cli_test', 'identities': {'bot': {'status': 'ready'}}})),
                    MagicMock(stdout='strict-mode: bot'),
                    MagicMock(stdout=json.dumps({'bot': {'open_id': 'ou_test'}})),
                ]) as probe:
            launcher.activation_preflight(config)
        self.assertTrue(all(call.kwargs['env']['LARKSUITE_CLI_CONFIG_DIR'] == bot_dir for call in probe.call_args_list))
        self.assertEqual(launcher.launch_environment(config)['LARKSUITE_CLI_CONFIG_DIR'], str(self.root / 'lark'))

    def test_launcher_can_bootstrap_a_bot_directory_without_changing_user_default(self):
        config = self.platform_config()
        bot_dir = self.root / 'bot-profile'
        bot_dir.mkdir()
        config['feishuBotConfigDir'] = str(bot_dir)
        config = launcher.validate_config(config)
        env = launcher.launch_environment(config)
        self.assertEqual(env['DSH_FEISHU_BOT_CONFIG_DIR'], str(bot_dir))
        self.assertEqual(env['LARKSUITE_CLI_CONFIG_DIR'], str(self.root / 'lark'))

    def test_personal_user_directory_is_the_host_default_and_bot_probe_uses_its_own_directory(self):
        personal = self.root / 'personal-user'
        personal.mkdir()
        bot = self.root / 'bot-only'
        bot.mkdir()
        config = launcher.validate_config(self.platform_config(feishuUserConfigDir=str(personal), feishuBotConfigDir=str(bot)))
        env = launcher.launch_environment(config)
        self.assertEqual(env['LARKSUITE_CLI_CONFIG_DIR'], str(personal))
        self.assertEqual(env['DSH_FEISHU_BOT_CONFIG_DIR'], str(bot))
        with self.assertRaises(ValueError):
            launcher.validate_config(self.platform_config(feishuUserConfigDir='relative'))

    def test_activation_refuses_unready_busy_or_manually_stopped_instances(self):
        config = launcher.validate_config(self.platform_config())
        for current in [None, {**self.ready, 'setup': {'feishuProblem': {'code': 'not_configured'}}},
                        {**self.ready, 'load': {'running': 1, 'queued': 0}}]:
            with patch.object(launcher, 'state', return_value=current), \
                    patch.object(launcher.subprocess, 'run') as probe, self.assertRaises(RuntimeError):
                launcher.activation_preflight(config)
            probe.assert_not_called()
        (self.root / config['stopMarker']).write_text('Operator stop', encoding='utf-8')
        with patch.object(launcher, 'state', return_value=self.ready), self.assertRaises(RuntimeError):
            launcher.activation_preflight(config)

    def test_start_reuses_the_owned_childs_verified_snapshot_instead_of_a_second_cold_http_probe(self):
        with patch.object(launcher, 'state', side_effect=[None, None, TimeoutError('cold follow-up timed out')]) as state, \
                patch.object(launcher.subprocess, 'run', return_value=MagicMock(stdout=json.dumps(self.ready))):
            self.assertEqual(launcher.ensure_running(self.config, self.root / 'config.json'), self.ready)
        self.assertEqual(state.call_count, 2)

    def test_activation_preserves_a_paused_backlog_but_refuses_active_or_unpaused_work(self):
        config = launcher.validate_config(self.platform_config())
        backlog = {**self.ready, 'paused': True, 'load': {'running': 0, 'queued': 3}}
        with patch.object(launcher, 'state', return_value=backlog), patch.object(launcher.subprocess, 'Popen') as spawn:
            launcher.activation_preflight(config)
        spawn.assert_not_called()
        for state in [{**backlog, 'paused': False}, {**backlog, 'load': {'running': 1, 'queued': 3}}]:
            with patch.object(launcher, 'state', return_value=state), self.assertRaises(RuntimeError):
                launcher.activation_preflight(config)

    def test_web_entry_keeps_token_private_and_opens_the_panel(self):
        (self.root / 'windows-server.log').write_text('dsh web: http://127.0.0.1:3083/?token=synthetic\n', encoding='utf-8')
        with patch.object(launcher.webbrowser, 'open', return_value=True) as browser:
            launcher.open_panel(self.config)
        browser.assert_called_once_with('http://127.0.0.1:3083/?token=synthetic#main-conversation', new=0)


if __name__ == '__main__':
    unittest.main()
