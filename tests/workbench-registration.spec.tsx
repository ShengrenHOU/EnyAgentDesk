// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.tsx'

it('registers with native dependency guards without redeclaring Conversation-owned slots', async () => {
  vi.stubGlobal('EventSource', class extends EventTarget { close() {} })
  const core = new SlotCore()
  type Children = 'main' | 'sidebar.panellist' | 'sidebar.workspaces.session.row.action' | 'plugins.row.config' | 'conversation.input.dock'
    | 'conversation.chat.turnTail' | 'conversation.session'
  const disposeRoot = core.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' }, 'plugins.row.config': { kind: 'keyed', scope: 'root' },
    'conversation.input.dock': { kind: 'list', scope: 'session' }, 'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'conversation.session': { kind: 'single', scope: 'session' },
  } }, (_props: PropsRenderSlots<Children>) => null)
  const disposers: (() => void)[] = []
  const run = (callback: () => unknown) => { const result = callback(); if (typeof result === 'function') disposers.push(result as () => void) }
  const remote = { $on: vi.fn(() => () => {}) }
  const services = { locale: { register: () => () => {}, bind: () => (key: string) => key },
    remote, sessions: {}, uiWorkspace: {},
    slots: { register: core.register.bind(core), inject: (_name: string, callback: () => unknown) => run(callback) },
    layout: { selectPanel: vi.fn() },
  }
  const root = new Context()
  for (const [name, service] of Object.entries(services)) root.reflect.provide(name, service)
  try {
    await root.plugin({ inject, apply })
    expect(remote.$on).toHaveBeenCalledTimes(2)
  } finally {
    await root.fiber.dispose()
    for (const dispose of disposers.reverse()) dispose()
    disposeRoot(); vi.unstubAllGlobals()
  }
})
