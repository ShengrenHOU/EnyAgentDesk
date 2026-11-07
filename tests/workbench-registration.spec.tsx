// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply } from '../src/client/index.tsx'

it('registers beside the native Conversation without redeclaring its owned slots', () => {
  const core = new SlotCore()
  type Children = 'main' | 'sidebar.panellist' | 'sidebar.workspaces.session.row.action' | 'plugins.row.config' | 'conversation.input.dock' | 'conversation.session'
  const disposeRoot = core.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' }, 'plugins.row.config': { kind: 'keyed', scope: 'root' },
    'conversation.input.dock': { kind: 'list', scope: 'session' }, 'conversation.session': { kind: 'single', scope: 'session' },
  } }, (_props: PropsRenderSlots<Children>) => null)
  const disposers: (() => void)[] = []
  const run = (callback: () => unknown) => { const result = callback(); if (typeof result === 'function') disposers.push(result as () => void) }
  const ctx = { effect: run, locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: { register: core.register.bind(core), inject: (_name: string, callback: () => unknown) => run(callback) },
    layout: { selectPanel: vi.fn() },
  } as unknown as Parameters<typeof apply>[0] & Context
  try { expect(() => apply(ctx)).not.toThrow() }
  finally { for (const dispose of disposers.reverse()) dispose(); disposeRoot() }
})
