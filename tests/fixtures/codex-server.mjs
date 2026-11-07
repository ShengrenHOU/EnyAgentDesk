import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
for await (const line of input) {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } })
  else if (message.method === 'environment') send({ id: message.id, result: {
    parentThread: process.env.CODEX_THREAD_ID !== undefined, parentPipe: process.env.CODEX_APP_TOOLS_PIPE_PATH !== undefined,
    home: process.env.CODEX_HOME,
  } })
  else if (message.method === 'echo') {
    send({ method: 'fixture/event', params: { value: 1 } })
    send({ id: message.id, result: message.params })
  } else if (message.method === 'tool') {
    send({ id: 'tool-1', method: 'item/tool/call', params: { name: 'test' } })
    send({ id: message.id, result: true })
  } else if (message.id === 'tool-1') send({ method: 'fixture/toolResult', params: message.result })
  else if (message.method === 'invalid') process.stdout.write('not json\n')
  else if (message.method === 'exit') process.exit(7)
  else if (message.method === 'hold') { /* Deliberately leave the request unresolved. */ }
}
