"""Exercise the actual controlled memory patch without network or a live profile."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / 'integrations/dsh-memory'


class MemoryAdapterTest(unittest.TestCase):
    def test_root_eligibility_and_config_surfaces(self):
        archive = ADAPTER / 'upstream-0.5.7.tgz'
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),
                         '8e82bcbb6af0aab9d953b0de38faa529dc33e5f43c0589cedc81105e53e9ac6a')
        with tempfile.TemporaryDirectory(prefix='native-memory-adapter-') as temporary:
            folder = Path(temporary)
            with tarfile.open(archive) as stream:
                for member in stream.getmembers():
                    if not member.isfile():
                        continue
                    parts = Path(member.name).parts
                    self.assertEqual(parts[0], 'package')
                    self.assertNotIn('..', parts)
                    target = folder.joinpath(*parts[1:])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(stream.extractfile(member).read())
            subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', str(ADAPTER / 'main-role.patch')], cwd=folder, check=True, capture_output=True)
            subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', str(ADAPTER / 'main-role.patch')], cwd=folder, check=True, capture_output=True)
            contract = json.loads((ADAPTER / 'manifest.json').read_text())
            for file, digest in contract['patched'].items():
                self.assertEqual(hashlib.sha256((folder / file).read_bytes()).hexdigest(), digest, file)
            code = r"""
import assert from 'node:assert/strict';
import { canSummarizeSession as eligible, memoryEventWindow as window } from './lib/automation.js';
const main = ['coordinator'];
assert.equal(eligible(undefined, main), false);
assert.equal(eligible({}, main), true);
assert.equal(eligible({parentSession:'old',agentPreset:'coordinator'}), false);
assert.equal(eligible({parentSession:'old',agentPreset:'coordinator'}, main), true);
assert.equal(eligible({parentSession:'old',agentPreset:'worker'}, main), false);
assert.equal(eligible({origin:'subagent',agentPreset:'coordinator'}, main), false);
assert.equal(eligible({origin:'subagent',parentSession:'old',agentPreset:'coordinator'}, main), false);
const events=[{seq:1,type:'turn/start'},{seq:2,type:'user/message',data:'old'},{seq:3,type:'turn/end'},
  {seq:4,type:'turn/start'},{seq:5,type:'user/message',data:'new'}];
assert.deepEqual(window(events,0).map(e=>e.seq),[4,5]);
assert.deepEqual(window(events,2).map(e=>e.seq),[3,4,5]);
assert.deepEqual(window([...events,{seq:6,type:'user/message',data:{source:{kind:'runtime-context'}}}],0).map(e=>e.seq),[4,5]);
const { readFileSync } = await import('node:fs');
const source = readFileSync('./lib/index.js', 'utf8');
const at = source.indexOf('render: (_args, value) => textOutput([', source.indexOf("name: 'memory_stats'"));
const end = source.indexOf("].join('\\n'))", at) + "].join('\\n'))".length;
const render = new Function('textOutput', 'return (' + source.slice(at + 'render: '.length, end) + ')')(text => text);
assert.match(render({}, {autoSummaryEligible:true,scopes:[]}), /autoSummaryEligible: true/);
console.log('seven eligibility assertions passed');
"""
            run = subprocess.run(['node', '--input-type=module', '-e', code], cwd=folder, check=True, capture_output=True, text=True)
            self.assertIn('seven eligibility assertions passed', run.stdout)
            host = (folder / 'lib/index.js').read_text(encoding='utf-8')
            self.assertIn('canSummarizeSession(agent.session?.header, resolved.parentedRootPresets)', host)
            self.assertNotIn('function isRootSession(', host)
            self.assertIn('autoSummaryEligible:', host)
            for file in ['lib/index.js', 'lib/types/index.d.ts', 'lib/client.js', 'README.md', 'README.zh.md']:
                self.assertIn('parentedRootPresets', (folder / file).read_text(encoding='utf-8'))
            self.assertEqual(json.loads((folder / 'package.json').read_text())['version'], '0.5.7')


if __name__ == '__main__':
    unittest.main()
