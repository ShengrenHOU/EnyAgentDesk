/** Exercise the actual pinned SDK dispatcher without credentials or a network connection. */
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { consumeLarkBridge } from '../src/sources/lark-events.ts'

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
