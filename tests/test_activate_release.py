import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/activate-release.py'
spec = importlib.util.spec_from_file_location('activate_release', SCRIPT)
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)


class ActivationTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.profile = self.root / 'home/profiles/test'
        self.profile.mkdir(parents=True)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.db = self.state / 'orchestrator.sqlite'
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); INSERT INTO kv VALUES('schema','13'); CREATE TABLE ticket(id TEXT PRIMARY KEY); INSERT INTO ticket VALUES('business-ticket');")
        for name, data in {'package.json': '{"private":true}', 'pnpm-lock.yaml': 'lockfileVersion: 9', 'cordis.patch.yml': '- id: preserved'}.items():
            (self.profile / name).write_text(data, encoding='utf-8')
        self.config = self.root / 'launcher.json'
        self.config.write_text(json.dumps({'runtime': str(self.root), 'stateDir': str(self.state), 'home': 'home', 'profile': 'test',
            'port': 3097, 'node': sys.executable, 'python': sys.executable, 'broker': sys.executable}), encoding='utf-8')
        self.original = self.config.read_bytes()
        self.release = self.root / 'release'
        self.release.mkdir()
        self.receipt = self.root / 'receipt.json'
        self.live = {'paused': False, 'load': {'running': 0, 'queued': 3}, 'health': {'runtime': {'state': 'ready'}},
                     'setup': {'accounts': {}}, 'runtime': {'packageVersion': '0.5.38', 'commit': 'b' * 12}}
        self.target = {'version': '0.6.0', 'commit': 'a' * 40, 'sha256': 'f' * 64, 'archive': self.release / 'bundle.tgz',
                       'scripts': {'owner-launcher.py': b'# launcher', 'check-runtime-peers.mjs': b'// peers'}}
        for name, owner, attribute, value in [
            ('release_files', activation, 'release_files', self.target),
            ('state', activation.launcher, 'state', self.live),
            ('preflight', activation.launcher, 'activation_preflight', None),
            ('stop', activation.launcher, 'stop_owned', 123),
            ('store', activation.installer, 'store_directory', self.root / 'store/v11'),
            ('run', activation, 'run', None),
        ]:
            stub = patch.object(owner, attribute, return_value=value)
            setattr(self, name, stub.start())
            self.addCleanup(stub.stop)
        self.set_pause = patch.object(activation, 'paused', side_effect=lambda config, value: self.live.update(paused=value))
        self.pause = self.set_pause.start()
        self.addCleanup(self.set_pause.stop)
        self.install_patch = patch.object(activation.installer, 'install', side_effect=self.install)
        self.installer = self.install_patch.start()
        self.addCleanup(self.install_patch.stop)

    def install(self, *args):
        self.assertEqual(json.loads(self.receipt.read_text())['status'], 'running')
        self.live['runtime'] = {'packageVersion': '0.6.0', 'commit': 'a' * 12}
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO ticket VALUES('new-evidence-during-cutover')")

    def activate(self, **kwargs):
        return activation.activate(self.config, self.release, self.root / 'pnpm.mjs', self.receipt, wait_seconds=0, **kwargs)

    def test_drains_without_deleting_backlog_and_restores_original_dispatch_state(self):
        candidate = self.root / 'candidate.yml'
        candidate.write_text('- id: migrated', encoding='utf-8')
        result = self.activate(candidate_patch=candidate)
        self.assertEqual(result['status'], 'activated')
        self.assertEqual(self.pause.call_args_list[0].args[1], True)
        self.assertEqual(self.pause.call_args_list[-1].args[1], False)
        self.assertEqual(self.live['load']['queued'], 3)
        self.assertEqual(result['afterTickets'], 2)
        self.assertEqual((self.profile / 'cordis.patch.yml').read_text(), '- id: migrated')
        self.assertTrue((self.receipt.with_suffix('.backup') / 'orchestrator.sqlite').exists())

    def test_busy_workers_do_not_get_killed_or_installed_and_pause_is_restored(self):
        self.live['load']['running'] = 1
        with self.assertRaisesRegex(RuntimeError, 'did not drain'):
            self.activate()
        self.stop.assert_not_called()
        self.installer.assert_not_called()
        self.assertFalse(self.live['paused'])
        self.assertEqual(json.loads(self.receipt.read_text())['stage'], 'drain')

    def test_preserves_an_already_paused_instance(self):
        self.live['paused'] = True
        self.activate()
        self.assertTrue(self.live['paused'])

    def test_records_source_backlog_and_provider_failure_without_rolling_back_a_healthy_build(self):
        self.live['health']['worker'] = {'state': 'ready'}
        def install(*args):
            self.install(*args)
            del self.live['health']['worker']
            self.live['health'].update(history={'state': 'starting'}, activity={'state': 'error', 'detail': 'private provider payload'})
        self.installer.side_effect = install
        result = self.activate()
        self.assertEqual(result['status'], 'activated')
        self.assertEqual(result['observed']['health']['history'], 'starting')
        self.assertEqual(result['observed']['health']['activity'], 'error')
        self.assertNotIn('private provider payload', self.receipt.read_text())

    def test_accepts_verified_owned_runtime_even_if_start_command_returns_nonzero(self):
        def run(command, **kwargs):
            if kwargs.get('operation') == 'launcher start':
                raise RuntimeError('launcher start failed (CalledProcessError exit=1)')
        self.run.side_effect = run
        result = self.activate()
        self.assertEqual(result['status'], 'activated')
        self.assertIn('exit=1', result['launcherWarning'])
        self.assertFalse(self.live['paused'])

    def test_rollback_start_error_still_checks_the_running_previous_build_and_resumes(self):
        real_verify = activation.verify
        def verify(config, version, *args):
            if version == '0.6.0':
                raise RuntimeError('Candidate failed verification')
            return real_verify(config, version, *args)
        def run(command, **kwargs):
            if kwargs.get('operation') == 'rollback install':
                self.live['runtime'] = {'packageVersion': '0.5.38', 'commit': 'b' * 12}
            if kwargs.get('operation') == 'rollback launcher start':
                raise RuntimeError('rollback launcher start failed (CalledProcessError exit=1)')
        self.run.side_effect = run
        with patch.object(activation, 'verify', side_effect=verify), self.assertRaises(RuntimeError):
            self.activate()
        result = json.loads(self.receipt.read_text())
        self.assertEqual(result['rollback'], 'restored')
        self.assertIn('exit=1', result['rollbackLauncherWarning'])
        self.assertFalse(self.live['paused'])

    def test_child_diagnostics_keep_operation_and_exit_code_without_output(self):
        failure = subprocess.CalledProcessError(7, ['private-command'], output='private-token', stderr='private-body')
        with patch.object(activation.subprocess, 'run', side_effect=failure), self.assertRaises(RuntimeError) as caught:
            activation.module(SCRIPT, 'diagnostic_reader').run(['unused'], operation='rollback install')
        self.assertIn('rollback install failed (CalledProcessError exit=7)', str(caught.exception))
        self.assertNotIn('private', str(caught.exception))

    def test_incomplete_rollback_keeps_its_failure_but_resumes_a_verified_previous_runtime(self):
        real_verify = activation.verify
        def verify(config, version, *args):
            if version == '0.6.0':
                raise RuntimeError('Candidate failed verification')
            return real_verify(config, version, *args)
        def run(command, **kwargs):
            if kwargs.get('operation') == 'rollback install':
                self.live['runtime'] = {'packageVersion': '0.5.38', 'commit': 'b' * 12}
                raise RuntimeError('rollback install failed (CalledProcessError exit=1)')
        self.run.side_effect = run
        with patch.object(activation, 'verify', side_effect=verify), self.assertRaises(RuntimeError):
            self.activate()
        result = json.loads(self.receipt.read_text())
        self.assertEqual(result['rollback'], 'failed')
        self.assertTrue(result['previousRuntimeAvailable'])
        self.assertFalse(self.live['paused'])

    def test_version_mismatch_keeps_a_safe_final_health_observation(self):
        self.live['health']['activity'] = {'state': 'error', 'detail': 'private-payload'}
        with self.assertRaises(RuntimeError) as caught:
            activation.verify({}, '0.6.0', 'a' * 40, 0)
        self.assertIn('last observation', str(caught.exception))
        self.assertIn('"activity": "error"', str(caught.exception))
        self.assertNotIn('private-payload', str(caught.exception))

    def test_verification_waits_for_cold_routes_but_never_accepts_a_foreign_listener(self):
        cold = RuntimeError('Management route not registered yet')
        cold.__cause__ = urllib.error.HTTPError('http://127.0.0.1/', 404, 'Not Found', {}, None)
        self.state.side_effect = [cold, self.live]
        with patch.object(activation.time, 'sleep'):
            self.assertIs(activation.verify({}, '0.5.38', 'b' * 40, 30), self.live)
        self.state.side_effect = RuntimeError('The listener belongs to another state directory')
        with patch.object(activation.time, 'sleep') as sleep, self.assertRaisesRegex(RuntimeError, 'another state directory'):
            activation.verify({}, '0.5.38', 'b' * 40, 30)
        sleep.assert_not_called()

    def test_concurrent_activation_cannot_enter_drain(self):
        with activation.launcher.launch_guard(self.root, 'owner-activation.lock'):
            with self.assertRaises(OSError):
                self.activate()
        self.pause.assert_not_called()
        self.installer.assert_not_called()

    def test_configuration_edit_during_drain_is_not_overwritten(self):
        self.preflight.side_effect = lambda config: (self.profile / 'cordis.patch.yml').write_text('- id: concurrent-change')
        with self.assertRaisesRegex(RuntimeError, 'Configuration changed'):
            self.activate()
        self.stop.assert_not_called()
        self.assertEqual((self.profile / 'cordis.patch.yml').read_text(), '- id: concurrent-change')
        self.assertFalse(self.live['paused'])

    def test_failed_verification_restores_code_and_configuration_but_keeps_new_records(self):
        def verify(config, version, *args):
            if version == '0.6.0':
                raise RuntimeError('Candidate failed verification')
            return self.live
        with patch.object(activation, 'verify', side_effect=verify), self.assertRaisesRegex(RuntimeError, 'Candidate failed'):
            self.activate()
        self.assertEqual(json.loads(self.receipt.read_text())['rollback'], 'restored')
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(activation.database(self.db)['tickets'], {'business-ticket', 'new-evidence-during-cutover'})
        self.assertFalse(self.live['paused'])
        self.assertIn('--frozen-lockfile', self.run.call_args_list[-2].args[0])

    def test_schema_change_refuses_snapshot_rollback_and_preserves_paused_state(self):
        def verify(*args):
            with closing(sqlite3.connect(self.db)) as db, db:
                db.execute("UPDATE kv SET value='14' WHERE key='schema'")
            raise RuntimeError('Candidate failed verification')
        with patch.object(activation, 'verify', side_effect=verify), self.assertRaises(RuntimeError):
            self.activate()
        result = json.loads(self.receipt.read_text())
        self.assertEqual(result['rollback'], 'failed')
        self.assertIn('Schema changed', result['rollbackError'])
        self.assertEqual(activation.database(self.db)['schema'], '14')
        self.assertTrue(self.live['paused'])

    def test_schema_rollback_reestablishes_stop_intent_when_candidate_already_exited(self):
        exited = False
        def verify(*args):
            nonlocal exited
            with closing(sqlite3.connect(self.db)) as db, db:
                db.execute("UPDATE kv SET value='14' WHERE key='schema'")
            exited = True
            raise RuntimeError('Candidate exited')
        self.state.side_effect = lambda config: None if exited else self.live
        with patch.object(activation, 'verify', side_effect=verify), self.assertRaises(RuntimeError):
            self.activate()
        self.assertEqual(self.stop.call_count, 2)
        self.assertIn('Schema changed', json.loads(self.receipt.read_text())['rollbackError'])

    def test_failed_preflight_never_stops_existing_instance(self):
        self.preflight.side_effect = RuntimeError('Identity unavailable')
        with self.assertRaisesRegex(RuntimeError, 'Identity unavailable'):
            self.activate()
        self.stop.assert_not_called()
        self.installer.assert_not_called()
        self.assertFalse(self.live['paused'])

    def test_does_not_overwrite_an_existing_receipt(self):
        self.receipt.write_text('old evidence')
        with self.assertRaises(ValueError):
            self.activate()
        self.assertEqual(self.receipt.read_text(), 'old evidence')

    def test_verifies_archive_and_exact_helper_content_before_any_runtime_mutation(self):
        # Exercise the actual artifact reader independently of the activation fixture.
        reader = module_reader()
        bundle = self.release / 'dsh-superagent-0.6.0.tgz'
        payload = self.root / 'package'
        (payload / 'scripts').mkdir(parents=True)
        (payload / 'package.json').write_text('{"name":"dsh-superagent","version":"0.6.0"}')
        for name in ['owner-launcher.py', 'owner-supervisor.ps1', 'install-profile-bundle.py', 'activate-release.py', 'check-runtime-peers.mjs']:
            (payload / 'scripts' / name).write_bytes(SCRIPT.with_name(name).read_bytes())
        with tarfile.open(bundle, 'w:gz') as stream:
            stream.add(payload, arcname='package')
        (self.release / 'release.json').write_text(json.dumps({'version': '0.6.0', 'publicCommit': 'a' * 40, 'sha256': activation.digest(bundle)}))
        self.assertEqual(reader(self.release)['commit'], 'a' * 40)
        with bundle.open('ab') as output:
            output.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
            reader(self.release)


def module_reader():
    return activation.module(SCRIPT, 'artifact_reader').release_files


if __name__ == '__main__':
    unittest.main()
