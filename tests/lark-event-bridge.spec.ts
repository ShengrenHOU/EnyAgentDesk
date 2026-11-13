/** Exercise the actual pinned SDK dispatcher without credentials or a network connection. */
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { consumeLarkBridge, larkErrorCode } from '../src/sources/lark-events.ts'

it('keeps native event identity and waits for durable confirmation while omitting verification tokens', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {bridgeDispatcher} from './scripts/lark-event-bridge.mjs';
    let resolve, frame, complete = false;
    const dispatcher = bridgeDispatcher(value => { frame = value; return new Promise(done => { resolve = done }); });
    const run = dispatcher.invoke({schema:'2.0',header:{event_id:'synthetic-event',event_type:'task.task.update_user_access_v2',
      create_time:'1794500000000',app_id:'cli_synthetic',token:'synthetic-private-token'},
      event:{task_guid:'synthetic-task',event_types:['task_create']}},{needCheck:false}).then(() => { complete = true });
    await new Promise(done => setImmediate(done));
    assert.equal(complete,false); assert.equal(frame.eventId,'synthetic-event');
    assert.equal(frame.payload.task_guid,'synthetic-task'); assert.equal(frame.payload.token,undefined);
    resolve(); await run; assert.equal(complete,true);
    await assert.rejects(dispatcher.invoke({schema:'2.0',header:{event_type:'task.task.update_user_access_v2'},
      event:{task_guid:'task'}},{needCheck:false}),/metadata/);
    console.log('native event contract passed');
  `
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 })
  expect(result.trim()).toBe('native event contract passed')
})

it('joins a real event child after durable intake and parent acknowledgment', async () => {
  const controller = new AbortController(), deliveries: string[] = []
  const script = `
    const frame = {type:'event',deliveryId:'00000000-0000-4000-8000-000000000001',eventType:'task.task.update_user_access_v2',eventId:'test-event',at:'1794500000000',payload:{task_guid:'test'}};
    console.log(JSON.stringify(frame));
    process.stdin.on('data', data => { const ack = JSON.parse(data); if(ack.deliveryId === frame.deliveryId) console.log(JSON.stringify({type:'status',state:'ready'})); });
    process.stdin.on('end',()=>process.exit(0));
  `
  await consumeLarkBridge([process.execPath, '-e', script], controller.signal, async event => { deliveries.push(event.eventId) },
    state => { if (state === 'ready') controller.abort() })
  expect(deliveries).toEqual(['test-event'])
})

it('keeps provider and network codes without SDK credentials, URLs or response text', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {safeDiagnostic} from './scripts/lark-event-bridge.mjs';
    const secret='private-token';
    const provider=safeDiagnostic('sdk',new Error('pullConnectConfig failed: code=100004, msg='+secret));
    assert.equal(provider.code,100004);
    const network=safeDiagnostic('sdk',new Error('connect ECONNREFUSED https://host/?ticket='+secret));
    assert.equal(network.systemCode,'ECONNREFUSED');
    assert.equal(safeDiagnostic('sdk','Request failed with status code 502').httpStatus,502);
    assert.equal(safeDiagnostic('sdk','handshake timeout after 15000ms').reason,'timeout');
    assert.equal(JSON.stringify([provider,network]).includes(secret),false);
    assert.equal(JSON.stringify([provider,network]).includes('https:'),false);
    console.log('diagnostics passed');
  `
  expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 }).trim()).toBe('diagnostics passed')
  expect(larkErrorCode(Object.assign(new Error('token=private'), { code: 'ENOSPC' }))).toBe('Error code=ENOSPC')
  expect(larkErrorCode(Object.assign(new Error('private'), { name: 'private', code: 'private' }))).toBe('Error')
})

it.each(['frame', 'persistence'])('identifies the failing %s boundary and withholds confirmation', async stage => {
  const controller = new AbortController(), reports: string[] = [], secret = 'private-event-content'
  const frame = { type: 'event', deliveryId: '00000000-0000-4000-8000-000000000001', eventType: 'task.task.update_user_access_v2',
    eventId: 'native', at: '1794500000000', payload: { text: secret } }
  const script = `
    console.log(${JSON.stringify(stage === 'frame' ? secret : JSON.stringify(frame))});
    process.stdin.on('data',()=>console.log(JSON.stringify({type:'status',state:'error',diagnostic:{stage:'ack',code:987654}})));
    process.stdin.on('end',()=>process.exit(0));
  `
  await consumeLarkBridge([process.execPath, '-e', script], controller.signal,
    async () => { throw Object.assign(new Error(secret), { code: 'ENOSPC' }) },
    (state, detail) => { reports.push(detail); if (state === 'error') controller.abort() })
  expect(reports.some(value => value.includes(`${stage} failed`))).toBe(true)
  expect(reports.join(' ')).toContain(stage === 'frame' ? 'SyntaxError' : 'code=ENOSPC')
  expect(reports.join(' ')).not.toContain(secret)
  expect(reports.join(' ')).not.toContain('987654')
})

it('retains a sanitized spawn failure rather than replacing it with a generic reconnect notice', async () => {
  const controller = new AbortController(), reports: string[] = []
  await consumeLarkBridge(['nonexistent-feishu-event-executable'], controller.signal, async () => {}, (state, detail) => {
    reports.push(detail)
    if (state === 'starting') controller.abort()
  })
  expect(reports.at(-1)).toContain('spawn failed (Error code=ENOENT)')
})
