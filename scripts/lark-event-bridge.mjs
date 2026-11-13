/** One SDK connection per app. The parent acknowledges only after durable intake. */
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'

export const EVENT_TYPES = ['im.message.receive_v1', 'task.task.update_user_access_v2',
  'mail.user_mailbox.event.message_received_v1', 'calendar.calendar.event.changed_v4',
  'drive.file.edit_v1', 'drive.file.title_updated_v1', 'drive.file.deleted_v1',
  'drive.file.bitable_record_changed_v1', 'drive.file.bitable_field_changed_v1']

export function bridgeDispatcher(deliver) {
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error', 'trace'].map(name => [name, () => {}]))
  const dispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.error })
  return dispatcher.register(Object.fromEntries(EVENT_TYPES.map(type => [type, async data => {
    if (!data.event_id || !data.create_time || data.event_type !== type) throw new Error('Event metadata is incomplete')
    const { token: _token, ...payload } = data
    await deliver({ type: 'event', deliveryId: randomUUID(), eventType: type, eventId: data.event_id, at: data.create_time, payload })
  }])))
}

async function main() {
  const appId = process.argv[2]
  if (!/^cli_[A-Za-z0-9]+$/.test(appId ?? '') || !process.env.FEISHU_APP_SECRET) throw new Error('Bridge credentials unavailable')
  const pending = new Map()
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    try {
      const value = JSON.parse(line)
      const entry = value.type === 'ack' && pending.get(value.deliveryId)
      if (entry) { clearTimeout(entry.timer); pending.delete(value.deliveryId); entry.resolve() }
    } catch { process.stderr.write('Invalid parent acknowledgment\n') }
  })
  const deliver = frame => new Promise((resolve, reject) => {
    const body = JSON.stringify(frame)
    if (Buffer.byteLength(body) > 1_048_576) { reject(new Error('Event exceeds frame budget')); return }
    const timer = setTimeout(() => { pending.delete(frame.deliveryId); reject(new Error('Durable intake was not confirmed')) }, 2500)
    pending.set(frame.deliveryId, { resolve, timer })
    process.stdout.write(body + '\n')
  })
  const status = state => process.stdout.write(JSON.stringify({ type: 'status', state }) + '\n')
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error', 'trace'].map(name => [name, () => {
    if (name === 'error') process.stderr.write('Feishu SDK reported a transport error\n')
  }]))
  const client = new WSClient({ appId, appSecret: process.env.FEISHU_APP_SECRET, logger, loggerLevel: LoggerLevel.error,
    onReady: () => status('ready'), onReconnecting: () => status('reconnecting'), onReconnected: () => status('ready'),
    onError: () => status('error') })
  delete process.env.FEISHU_APP_SECRET
  let stopping = false
  const stop = () => { if (stopping) return; stopping = true; client.close({ force: true }); lines.close(); process.exit(0) }
  process.once('SIGTERM', stop); process.once('SIGINT', stop); lines.once('close', stop)
  await client.start({ eventDispatcher: bridgeDispatcher(deliver) })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Feishu event bridge startup failed\n'); process.exitCode = 1 })
}
