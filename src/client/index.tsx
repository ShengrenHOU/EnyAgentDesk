/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { App } from './app.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import type { T } from './text.ts'
import { WorkbenchAction } from './workbench.tsx'
import { OwnerDesk } from './owner-desk.tsx'
import { Workbench } from './personal-workbench.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { remember, settingsRoute } from './route.ts'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Button } from './controls.tsx'
import { LoadState } from './widgets.tsx'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const WORKBENCH_ID = 'dsh-personal-workbench' as MainPanelId
const CONVERSATION_ID = 'dsh-main-conversation' as MainPanelId
const ENTRY = 'dsh-superagent'

function EntryIcon({ size, kind, t }: SidebarPanelIconOwnerProps & { kind: 'conversation' | 'workbench'; t: T }) {
  return <><svg data-superagent-entry={kind} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {kind === 'conversation' ? <path d="M4 4h16v12H9l-5 4V4z" /> : <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />}
  </svg><span className="sg-entry-caption">{t(kind === 'conversation' ? 'mainEntryHint' : 'workspaceEntryHint')}</span></>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function MainConversationEntry({ openSession }: { openSession(id: string): Promise<void> }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  const [failure, setFailure] = useState<Error>()
  const open = useCallback(() => state ? openSession(state.masterId).catch(error => setFailure(error instanceof Error ? error : new Error(String(error)))) : Promise.resolve(), [state?.masterId, openSession])
  useEffect(() => { void open() }, [open])
  return <div className="dt-panel"><LoadState loading={!error && !failure} error={error ?? failure} />
    {!!failure && <Button onClick={() => { setFailure(undefined); void open() }}>{t('openMaster')}</Button>}</div>
}

function DailyHome({ t, send, openSession }: { t: T; send(id: string, text: string): Promise<void>; openSession(id: string): Promise<void> }) {
  const { navigate } = usePanel()
  return <Workbench t={t} send={send} openSession={openSession}
    openDomainSettings={() => navigate(settingsRoute('source', { source: 'workbench' }))}
    openGithubSettings={() => navigate(settingsRoute('source', { source: 'github' }))}
    openWorkList={filter => navigate({ page: 'execution', query: { filter } })}
    openManagement={(id, threadKey) => navigate(threadKey ? { page: 'trigger', id: threadKey }
      : id ? { page: 'execution', id } : { page: 'source' })} />
}

function Mounted({ ctx, t, conversation }: { ctx: ClientContext; t: T; conversation?: boolean }) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await ctx.uiWorkspace.unarchiveSession(id as SessionId)
      const opened = await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
      if (!opened) throw new DOMException('Session navigation was superseded', 'AbortError')
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const send = useCallback(async (id: string, text: string) => {
    const conversation = ctx.sessions.scope(id as SessionId)?.get('conversation')
    if (!conversation) throw new Error('Main conversation is unavailable')
    await conversation.send(text)
  }, [ctx])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  if (conversation) return <PanelProvider t={t} openSession={openSession} navigate={() => ctx.layout.selectPanel(WORKBENCH_ID)}>
    <MainConversationEntry openSession={openSession} />
  </PanelProvider>
  return <App t={t} openSession={openSession} deploymentForm={form}
    home={<DailyHome t={t} send={send} openSession={openSession} />} />
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace', 'layout']
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  const showTicket = (id: string) => {
    remember({ route: { page: 'execution', id }, stack: [] }); ctx.layout.selectPanel(PANEL_ID)
  }
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'superagent-owner-desk', order: 5, locale: NS,
    inject: (sessionId: string) => ({ send: (text: string) => {
      const conversation = ctx.sessions.scope(sessionId as SessionId)?.get('conversation')
      if (!conversation) throw new Error('Conversation is unavailable')
      return conversation.send(text)
    } }),
  }, (props: { sessionId: string; t: T; send(text: string): Promise<void> }) => <OwnerDesk {...props} openTicket={showTicket} />))
  ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.row.action', id: 'superagent-workbench', order: 150, locale: NS,
  }, (props: { sessionId: string; t: T }) => <WorkbenchAction sessionId={props.sessionId} t={props.t} openTicket={id => {
    remember({ route: { page: 'execution', id }, stack: [] }); ctx.layout.selectPanel(PANEL_ID)
  }} />))
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
      (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />)
    const disposeHome = ctx.slots.register({ name: 'main', key: WORKBENCH_ID, locale: NS, inject: () => ({}) },
      (props: { t: T }) => <Mounted {...props} ctx={ctx} />)
    const disposeConversation = ctx.slots.register({ name: 'main', key: CONVERSATION_ID, locale: NS, inject: () => ({}) },
      (props: { t: T }) => <Mounted {...props} ctx={ctx} conversation />)
    const enter = () => {
      if (window.location.hash === '#workbench') ctx.layout.selectPanel(WORKBENCH_ID)
      else if (window.location.hash === '#superagent') ctx.layout.selectPanel(PANEL_ID)
      else if (window.location.hash === '#main-conversation') ctx.layout.selectPanel(CONVERSATION_ID)
    }
    window.addEventListener('hashchange', enter)
    enter()
    return () => { window.removeEventListener('hashchange', enter); disposeConversation(); disposeHome(); dispose() }
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: CONVERSATION_ID, order: -100,
    label: () => t('mainConversationEntry'), locale: NS }, (props: SidebarPanelIconOwnerProps) => <EntryIcon {...props} kind="conversation" t={t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: WORKBENCH_ID, order: -90,
    label: () => t('homeTitle'), locale: NS }, (props: SidebarPanelIconOwnerProps) => <EntryIcon {...props} kind="workbench" t={t} />))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
