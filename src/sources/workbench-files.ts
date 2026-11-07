/** Verified local deliverables remain inside their task workspace and use the native owner-authenticated carrier. */
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import type { Ticket } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { WorkbenchConfig } from './workbench.ts'

async function fileContent(ticket: Ticket, path: string) {
  if (!ticket.execution?.directory) throw new Error('Task has no execution workspace')
  const root = await realpath(ticket.execution.directory)
  const file = await realpath(resolve(root, path)), name = relative(root, file)
  if (!name || isAbsolute(name) || name === '..' || name.startsWith('../') || name.startsWith('..\\')) throw new Error('Deliverable must remain inside its task workspace')
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Deliverable must be a regular file no larger than 20 MiB')
    const bytes = await handle.readFile()
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Deliverable grew beyond the size limit')
    return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally { await handle.close() }
}
function address(base: string, ticketId: string, path: string, sha256: string) {
  return `${base}/api/superagent-workbench/artifact?${new URLSearchParams({ ticketId, path, sha256 })}`
}
function owns(ticket: Ticket, config: WorkbenchConfig) {
  const delegated = ticket.mandate.actor.source === 'workbench' && ticket.mandate.actor.id === config.ownerId
  const privateDestination = ticket.channels.some(channel => channel.source === 'workbench'
    && channel.address.ownerId === config.ownerId && !!channel.address.sessionId)
  if (!config.ownerId || !delegated && !privateDestination) throw new Error('Deliverable belongs to another task owner')
}

export async function publishWorkbenchFiles(base: string, ticket: Ticket, files: { title: string; path: string }[], config: WorkbenchConfig) {
  owns(ticket, config)
  return Promise.all(files.map(async input => {
    const file = await fileContent(ticket, input.path)
    return { title: input.title, url: address(base, ticket.id, file.name, file.sha256) }
  }))
}

/** File types the owner browser can render safely inline; everything else stays a download. */
const PREVIEW_TYPES: Record<string, string> = {
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
}

export async function readWorkbenchFile(source: SourceContext, base: string, request: Request): Promise<Response> {
  const config = source.config<WorkbenchConfig>('workbench')
  if (!config) throw new Error('Workbench file delivery is disabled')
  const params = new URL(request.url).searchParams
  const ticketId = params.get('ticketId'), path = params.get('path'), sha256 = params.get('sha256')
  if (!ticketId || !path || !sha256) throw new Error('Missing deliverable identity')
  const ticket = source.tickets.get(ticketId)
  if (!ticket) throw new Error('Unknown task')
  owns(ticket, config)
  const url = address(base, ticketId, path, sha256)
  if (!ticket.assignments.some(assignment => assignment.report?.deliverables?.some(item => item.url === url))) throw new Error('File was not published by this task')
  const file = await fileContent(ticket, path)
  if (file.sha256 !== sha256) throw new Error('Published file changed; request a new verified deliverable')
  const preview = PREVIEW_TYPES[extname(file.name).toLowerCase()]
  return new Response(new Uint8Array(file.bytes), { headers: {
    'content-type': preview ?? 'application/octet-stream',
    'content-disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name.replaceAll('\\', '/').split('/').at(-1)!)}`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
  } })
}
