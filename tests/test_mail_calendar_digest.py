"""Isolated CLI fixtures: never access an account or send a message."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DigestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='digest-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = json.loads((ROOT / 'examples/mail-calendar-digest.json').read_text())
        self.config.update(larkCli='fixture-cli', larkConfigDir=str(self.root / 'user-profile'), expectedUserId='ou_owner')
        self.config_path = self.root / 'private-config.json'
        self.trace = self.root / 'calls.jsonl'
        self.loader = self.root / 'fixture.mjs'
        self.loader.write_text('''
import cp from 'node:child_process'
import {appendFileSync} from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
cp.execFile = (_command,args,options,callback) => {
  appendFileSync(process.env.DIGEST_TEST_LOG, JSON.stringify({args,configDir:options.env.LARKSUITE_CLI_CONFIG_DIR})+'\\n')
  if(args[0]==='mail'&&args[1]==='+messages'&&process.env.DIGEST_TEST_BODY_FAILURE) {
    setImmediate(()=>callback(new Error('fixture body failure'),'',JSON.stringify({error:{type:'api',message:'fixture body unavailable'}})))
    return {pid:0,kill(){}}
  }
  let value
  if(args[0]==='im'&&process.env.DIGEST_TEST_SEND_FAILURE) {
    setImmediate(()=>callback(new Error('fixture delivery failed'),'','fixture delivery failed'))
    return {pid:0,kill(){}}
  }
  if(args[0]==='auth') value={identities:{user:{status:'ready',openId:process.env.DIGEST_TEST_USER??'ou_owner'}}}
  else if(args[0]==='im') value={data:{message_id:'om_fixture'}}
  else if(args[0]==='calendar') value={ok:true,identity:'user',data:[]}
  else if(args[0]==='mail'&&args[1]==='+messages') value={data:{messages:[{message_id:'fixture-message',body_plain_text:'Please confirm [material](https://example.invalid). <img src=x>'}]}}
  else if(args[0]==='mail') value={ok:true,identity:'user',data:process.env.DIGEST_TEST_BAD_MAIL?{}:{messages:[
    {message_id:'fixture-message',date:'2026-11-08T00:30:00Z',from:'Fixture Person <fixture@example.com>',subject:'Fixture',labels:process.env.DIGEST_TEST_READ_MAIL?'':'UNREAD'}
  ],has_more:false,count:1}}
  else throw new Error('Unexpected external operation in digest fixture')
  setImmediate(()=>callback(null,JSON.stringify(value),''))
  return {pid:0,kill(){}}
}
syncBuiltinESMExports()
''', encoding='utf-8')

    def run_digest(self, *, success=True, send=False, env=None):
        self.config_path.write_text(json.dumps(self.config), encoding='utf-8')
        result = subprocess.run(['node', '--import', self.loader.as_uri(), str(ROOT / 'scripts/mail-calendar-digest.mjs'),
                                 '--config', str(self.config_path), '--now', '2026-11-08T08:00:00Z', *(['--send'] if send else [])],
                                env={**os.environ, 'LARKSUITE_CLI_CONFIG_DIR': 'global-bot-profile',
                                     'DIGEST_TEST_LOG': str(self.trace), **(env or {})}, text=True, encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        calls = [json.loads(line) for line in self.trace.read_text(encoding='utf-8').splitlines()] if self.trace.exists() else []
        health = json.loads((self.root / 'state/health.json').read_text())
        return calls, health

    def test_uses_bound_user_for_every_read_and_keeps_data_beside_private_config(self):
        calls, health = self.run_digest()
        self.assertEqual(health['status'], 'ok')
        self.assertEqual(health['sources']['mail']['newCount'], 1)
        self.assertEqual(health['sources']['mail']['unreadCount'], 1)
        self.assertTrue((self.root / 'digests/latest.md').is_file())
        for call in calls:
            self.assertEqual(call['configDir'], self.config['larkConfigDir'])
            self.assertEqual(call['args'][call['args'].index('--as') + 1], 'user')
        self.assertEqual([call['args'][0] for call in calls], ['auth', 'calendar', 'mail', 'mail', 'mail'])

    def test_preserves_current_triage_deduplication_and_reports_partial_body_reads(self):
        self.config['triage'] = {'internalDomains': ['example.com']}
        _calls, health = self.run_digest()
        text = (self.root / 'digests/latest.md').read_text(encoding='utf-8')
        self.assertIn('需要你回复', text)
        self.assertIn('类型：内部来信', text)
        self.assertIn('Please confirm material.', text)
        self.assertNotIn('https://example.invalid', text)
        self.assertNotIn('<img', text)
        self.assertEqual(text.count('Fixture Person ·'), 1)
        self.assertEqual(health['sources']['mail']['bodyCount'], 1)
        _calls, health = self.run_digest(env={'DIGEST_TEST_BODY_FAILURE': '1'})
        self.assertEqual(health['status'], 'partial')
        self.assertEqual(health['sources']['mail']['bodyError'], '[api] fixture body unavailable')

    def test_wrong_user_cannot_read_sources_or_deliver(self):
        calls, health = self.run_digest(success=False, send=True, env={'DIGEST_TEST_USER': 'ou_other'})
        self.assertEqual([call['args'][0] for call in calls], ['auth'])
        self.assertEqual(health['status'], 'error')
        self.assertFalse(health['delivery']['ok'])

    def test_failed_delivery_keeps_read_mail_for_retry_and_success_is_not_sent_twice(self):
        self.run_digest(success=False, send=True, env={'DIGEST_TEST_SEND_FAILURE': '1', 'DIGEST_TEST_READ_MAIL': '1'})
        _calls, health = self.run_digest(send=True, env={'DIGEST_TEST_READ_MAIL': '1'})
        self.assertEqual(health['sources']['mail']['newCount'], 1)
        self.assertIn('Fixture Person', (self.root / 'digests/latest.md').read_text(encoding='utf-8'))
        self.assertTrue(health['delivery']['ok'])
        calls, health = self.run_digest(send=True, env={'DIGEST_TEST_READ_MAIL': '1'})
        self.assertTrue(health['delivery']['skipped'])
        self.assertEqual(len([call for call in calls if call['args'][0] == 'im']), 2)

    def test_missing_user_binding_does_not_fall_back_to_global_bot(self):
        del self.config['larkConfigDir']
        calls, health = self.run_digest(success=False)
        self.assertEqual(calls, [])
        self.assertIn('larkConfigDir', health['error'])

    def test_unknown_mail_shape_is_failure_without_advancing_mail_checkpoint(self):
        directory = self.root / 'state'
        directory.mkdir()
        (directory / 'state.json').write_text(json.dumps({'mail': {'since': '2026-11-07T00:00:00Z', 'seen': []}}))
        _calls, health = self.run_digest(success=False, env={'DIGEST_TEST_BAD_MAIL': '1'})
        state = json.loads((directory / 'state.json').read_text())
        self.assertIn('coverage is unknown', health['sources']['mail']['error'])
        self.assertEqual(state['mail']['since'], '2026-11-07T00:00:00Z')

    def test_corrupt_checkpoint_is_preserved_without_reading_or_delivering(self):
        directory = self.root / 'state'
        directory.mkdir()
        state = directory / 'state.json'
        state.write_text('{broken')
        calls, health = self.run_digest(success=False, send=True)
        self.assertEqual(calls, [])
        self.assertEqual(state.read_text(), '{broken')
        self.assertEqual(health['delivery']['reason'], 'checkpoint_invalid')


if __name__ == '__main__':
    unittest.main()
