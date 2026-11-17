"""Store and receipt regressions; the optional real-pnpm case uses only local fixture archives."""
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('profile_install', ROOT / 'scripts/install-profile-bundle.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProfileInstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='profile-install-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = self.root / 'profile'
        self.package = self.profile / 'node_modules/dsh-superagent/package.json'
        self.package.parent.mkdir(parents=True)
        self.package.write_text(json.dumps({'name': 'dsh-superagent', 'version': '0.5.4'}))
        self.store = self.root / 'recovery-store/v11'
        self.store.mkdir(parents=True)
        self.metadata = self.profile / 'node_modules/.modules.yaml'
        self.metadata.write_text(json.dumps({'storeDir': str(self.store)}))
        self.receipt = self.root / 'receipt.json'
        self.bundle = self.archive('0.5.5')

    def archive(self, version):
        target = self.root / f'dsh-superagent-{version}.tgz'
        data = json.dumps({'name': 'dsh-superagent', 'version': version, 'private': True}).encode()
        with tarfile.open(target, 'w:gz') as stream:
            item = tarfile.TarInfo('package/package.json'); item.size = len(data)
            stream.addfile(item, io.BytesIO(data))
        return target

    def test_uses_existing_store_parent_and_confirms_the_installed_version(self):
        calls = []
        def pnpm(args, **_kwargs):
            calls.append(args)
            if 'add' in args:
                self.package.write_text(json.dumps({'name': 'dsh-superagent', 'version': '0.5.5'}))
            return subprocess.CompletedProcess(args, 0, str(self.store) + '\n', '')
        with patch.object(module.subprocess, 'run', side_effect=pnpm):
            module.install(self.profile, self.bundle, Path('pnpm.mjs'), Path('node'), self.receipt)
        self.assertEqual(Path(calls[1][calls[1].index('--store-dir') + 1]).resolve(), self.store.parent.resolve())
        self.assertIn('--ignore-scripts', calls[1])
        self.assertIn('--config.confirmModulesPurge=false', calls[1])
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt['status'], 'installed')
        self.assertFalse(receipt['runtimeActivated'])

    def test_store_mismatch_fails_before_install_and_still_records_failure(self):
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, str(self.root / 'other'), '')) as run:
            with self.assertRaisesRegex(ValueError, 'no install was attempted'):
                module.install(self.profile, self.bundle, Path('pnpm.mjs'), Path('node'), self.receipt)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(json.loads(self.receipt.read_text())['stage'], 'validate_store')
        self.assertEqual(json.loads(self.package.read_text())['version'], '0.5.4')

    def test_missing_bundle_is_a_structured_failure(self):
        with self.assertRaises(FileNotFoundError):
            module.install(self.profile, self.root / 'missing.tgz', Path('pnpm.mjs'), Path('node'), self.receipt)
        self.assertEqual(json.loads(self.receipt.read_text())['status'], 'failed')

    def test_preserves_an_existing_receipt(self):
        self.receipt.write_text('previous evidence')
        with self.assertRaisesRegex(ValueError, 'new private receipt'):
            module.install(self.profile, self.bundle, Path('pnpm.mjs'), Path('node'), self.receipt)
        self.assertEqual(self.receipt.read_text(), 'previous evidence')

    def test_native_memory_uses_reviewed_pnpm_patch_and_preserves_existing_config(self):
        adapter = ROOT / 'integrations/dsh-memory'
        installed = self.profile / 'node_modules/@dsh-external/dsh-memory'
        installed.mkdir(parents=True)
        with tarfile.open(adapter / 'upstream-0.5.7.tgz') as stream:
            for member in stream.getmembers():
                if not member.isfile():
                    continue
                path = installed.joinpath(*Path(member.name).parts[1:])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(stream.extractfile(member).read())
        cfg = self.profile / 'cordis.patch.yml'
        (self.profile / 'package.json').write_text(json.dumps({'dependencies': {'@dsh-external/dsh-memory': 'file:upstream.tgz'}}))
        cfg.write_text('- id: dsh-memory\n  config:\n    memoryDir: /private/unchanged\n    maxBytes: 12000\n- id: other\n  disabled: true\n')
        with tarfile.open(self.bundle, 'w:gz') as archive:
            for name in ['main-role.patch', 'manifest.json']:
                archive.add(adapter / name, arcname='package/integrations/dsh-memory/' + name)
        calls = []
        def run(args, cwd, **kwargs):
            calls.append(args)
            if 'install' in args:
                real_run(['git', '-c', 'core.autocrlf=false', 'apply', str(self.profile / 'patches/native-memory-main.patch')], cwd=installed, check=True, capture_output=True)
                return subprocess.CompletedProcess(args, 0, '', '')
            return real_run(args, cwd=cwd, **kwargs)
        real_run = subprocess.run
        with patch.object(module.subprocess, 'run', side_effect=run):
            result = module.native_memory(self.profile, self.bundle, ['node', 'pnpm.mjs'], self.store.parent)
        self.assertEqual(result['status'], 'patched')
        self.assertIn('--ignore-scripts', next(args for args in calls if 'install' in args))
        self.assertIn('memoryDir: /private/unchanged', cfg.read_text())
        self.assertIn('maxBytes: 12000', cfg.read_text())
        self.assertEqual(cfg.read_text().count('parentedRootPresets:'), 1)
        with patch.object(module.subprocess, 'run') as run:
            module.native_memory(self.profile, self.bundle, ['node', 'pnpm.mjs'], self.store.parent)
            run.assert_not_called()

    def test_reads_pnpm_yaml_as_well_as_existing_json_metadata(self):
        self.metadata.write_text('storeDir: ' + json.dumps(str(self.store)) + '\n')
        self.assertEqual(module.store_directory(self.profile), self.store.resolve())

    @unittest.skipUnless(os.environ.get('PNPM_TEST_CLI'), 'Optional local-only real pnpm integration')
    def test_real_pnpm_upgrade_keeps_a_nondefault_store(self):
        import shutil
        node = Path(shutil.which('node'))
        cli = Path(os.environ['PNPM_TEST_CLI'])
        # A fresh synthetic profile has no host, accounts, peer dependencies or running service.
        profile = self.root / 'real-profile'
        profile.mkdir()
        (profile / 'package.json').write_text(json.dumps({'name': 'fixture-profile', 'private': True}))
        environment = {**os.environ, 'CI': 'true'}
        subprocess.run([str(node), str(cli), 'add', 'file:' + self.archive('0.5.4').as_posix(), '--ignore-scripts',
                        '--store-dir', str(self.root / 'real-store')], cwd=profile, env=environment,
                       capture_output=True, check=True)
        old_store = module.store_directory(profile)
        default_store = subprocess.run([str(node), str(cli), 'store', 'path'], cwd=profile,
                                       capture_output=True, text=True, encoding='utf-8', check=True)
        self.assertNotEqual(Path(default_store.stdout.strip()).resolve(), old_store)
        result = module.install(profile, self.bundle, cli, node, self.receipt)
        self.assertEqual(result['resolvedVersion'], '0.5.5')
        self.assertEqual(module.store_directory(profile), old_store)


if __name__ == '__main__':
    unittest.main()
