/** Exercise offline migration through Node with the installed native Cordis dialect. */
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('moves duplicate user bindings once, preserves native expressions and refuses conflicts', () => {
  const code = `
    import assert from 'node:assert/strict';
    import {migrateLarkAccount} from './scripts/migrate-lark-account.mjs';
    const old = [
      {id:'dsh-superagent-activity',config:{expectedOwner:'ou_owner',configDir:'/user',larkCli:'/cli',serverName:'wechat_readonly'}},
      {id:'dsh-superagent-lark-workspace',config:{expectedUserId:'ou_owner',configDir:'/user',larkCli:'/cli',eventCommand:['broker','sdk']}},
      {id:'dsh-superagent-feishu',disabled:false,config:{configDir:'/bot'}},
    ];
    const input = JSON.stringify(old);
    const migrated = migrateLarkAccount(input);
    assert.equal(migrateLarkAccount(migrated),migrated);
    assert.match(migrated,/id: dsh-superagent-lark-account/);
    assert.equal((migrated.match(/expectedUserId:/g)||[]).length,1);
    assert.equal((migrated.match(/configDir: \\/user/g)||[]).length,1);
    assert.match(migrated,/configDir: \\/bot/);
    assert.match(migrated,/serverName: wechat_readonly/);
    old[1].config.expectedUserId='ou_other';
    assert.throws(()=>migrateLarkAccount(JSON.stringify(old)),/Conflicting personal expectedUserId/);
    const expr = '- id: webserver\\n  disabled: !!js process.platform === "linux"\\n- id: dsh-superagent-activity\\n  config:\\n    expectedOwner: ou_owner\\n';
    assert.match(migrateLarkAccount(expr),/!!js/);
    assert.match(migrateLarkAccount(expr),/process.platform/);
    const paths = [{id:'dsh-superagent-activity',config:{configDir:'C:/Users/owner/lark'}},
      {id:'dsh-superagent-lark-workspace',config:{configDir:['C:', 'Users', 'owner', 'lark'].join(String.fromCharCode(92))}}];
    assert.doesNotThrow(()=>migrateLarkAccount(JSON.stringify(paths)));
    assert.equal(migrateLarkAccount('- id: unrelated\\n  disabled: false\\n'),'- id: unrelated\\n  disabled: false\\n');
    console.log('migration passed');
  `
  expect(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 }).trim()).toBe('migration passed')
})
