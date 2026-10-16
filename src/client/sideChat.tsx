/**
 * Side chat (experimental): a second work thread inside the same workspace,
 * hosted as a right-sidebar tab so the main conversation keeps running.
 *
 * The shell owns the sidebar mechanics (docked pane, split, floating panel), so
 * this module only contributes a tab type and its body:
 *
 * 1. stage one registers the type through `ctx.sidebarRightTabs`;
 * 2. stage two registers the body under `sidebar.right.pane.tab`, keyed by the
 *    definition id;
 * 3. `openSideChat` opens (or reveals) a tab through `ctx.sidebarRight`.
 *
 * @module dsh-prompt-history/client/sideChat
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Context merge (ctx.sidebarRight / ctx.sidebarRightTabs).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { T } from './i18n.ts'
import { NS } from './locales.ts'
import { getPrefs, subscribePrefs } from './prefs.ts'
import { threads, type SideThread, type ThreadSnapshot, type ThreadObservable } from './threads.ts'
import { PromptComposer } from './panelComposer.tsx'
import type { ChatRow } from './nodes.ts'

/** Tab type identity (the body slot and the title seat are keyed by it). */
export const SIDE_CHAT_ID = 'dsh-prompt-history.side-chat'
/** Kind discriminator passed to `openTab`. */
export const SIDE_CHAT_KIND = 'side-chat'

/** Root client context, captured once the sidebar services are available. */
let serviceCtx: ClientContext | null = null

/** One side thread shown in the panel. */
interface Thread {
  readonly id: string
  readonly title: string
}

/** Read the thread snapshot (the list plus each thread's badges). */
function useThreadSnapshot(): ThreadSnapshot {
  return useSyncExternalStore(threads.subscribe.bind(threads), threads.snapshot.bind(threads))
}

/** The sidebar tab chip: the title plus the aggregate badges. */
function SideChatTitle(): JSX.Element {
  useThreadSnapshot()
  const unread = threads.unreadTotal()
  return (
    <span className="dsh-ph-sidechat-title">
      {T('sideChat.title')}
      {unread > 0 && <span className="dsh-ph-sidechat-badge" aria-label={`${T('sideChat.unread')} ${unread}`}>{unread}</span>}
      {unread === 0 && threads.anyRunning() && <span className="dsh-ph-sidechat-running" aria-label={T('sideChat.running')}>⟳</span>}
    </span>
  )
}

/** Stable fallbacks so the body's hooks are unconditional. */
const NO_ROWS: readonly ChatRow[] = []
const EMPTY_ROWS: ThreadObservable<readonly ChatRow[]> = { getSnapshot: () => NO_ROWS, subscribe: () => () => {} }
const EMPTY_RUNNING: ThreadObservable<boolean> = { getSnapshot: () => false, subscribe: () => () => {} }

/** The tab information the sidebar's own hook exposes to a body. */
interface TabInfoLike {
  readonly panel?: { readonly id?: string }
  readonly tab?: {
    readonly id?: string
    readonly actions?: { close?: () => void }
  }
}

/** Standard props the session-scoped sidebar seat passes to a tab body. */
interface SideChatBodyProps {
  /** The conversation the sidebar is showing; threads fork from it by default. */
  readonly sessionId?: string
  /** Framework hook: this tab's record (id, actions) and its containing pane. */
  readonly useTabInfo?: () => TabInfoLike
}

/** One conversation row. */
function Row({ row }: { readonly row: ChatRow }): JSX.Element {
  return (
    <div className={`dsh-ph-sidechat-row dsh-ph-sidechat-row--${row.role}`}>
      <span className="dsh-ph-sidechat-role">{row.role}</span>
      <span className="dsh-ph-sidechat-text">{row.text}</span>
    </div>
  )
}

/** The tab body: thread strip, conversation area and composer. */
function SideChatBody(props: SideChatBodyProps): JSX.Element {
  const snapshot = useThreadSnapshot()
  const list = snapshot.threads
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const active: SideThread | null = list.find((thread) => thread.id === activeId) ?? list[list.length - 1] ?? null
  const rowsObs = active === null ? EMPTY_ROWS : threads.rowsOf(active.sessionId)
  const runObs = active === null ? EMPTY_RUNNING : threads.runningOf(active.sessionId)
  const rows = useSyncExternalStore(rowsObs.subscribe.bind(rowsObs), rowsObs.getSnapshot.bind(rowsObs))
  const running = useSyncExternalStore(runObs.subscribe.bind(runObs), runObs.getSnapshot.bind(runObs))
  const logRef = useRef<HTMLDivElement | null>(null)

  // The thread's own prompts are its history; its transcript is the prediction context.
  const history = useMemo(() => {
    const out: string[] = []
    for (const row of rows) {
      if (row.role !== 'user') continue
      if (out[out.length - 1] !== row.text) out.push(row.text)
    }
    return out
  }, [rows])
  const predictContext = useCallback(
    () => rows.slice(-8).map((row) => `${row.role}: ${row.text}`).join('\n').slice(-6000),
    [rows],
  )

  // The visible thread is read: drop its badge.
  useEffect(() => {
    threads.setViewed(active?.id ?? null)
  }, [active?.id, snapshot])

  // Follow the tail as the turn streams in.
  useEffect(() => {
    const log = logRef.current
    if (log !== null) log.scrollTop = log.scrollHeight
  }, [rows.length, active?.id])

  const sourceId = props.sessionId ?? ''
  const start = (origin: 'fork' | 'blank'): void => {
    const label = origin === 'fork' ? T('sideChat.origin.fork') : T('sideChat.origin.blank')
    void threads.start(origin, sourceId, label).then((thread) => {
      if (thread !== null) setActiveId(thread.id)
    })
  }

  const submit = (): void => {
    if (active === null || draft.trim() === '') return
    const text = draft
    setDraft('')
    void threads.send(active, text)
  }

  // Placement controls come from the shell: read this tab's record lazily and
  // ignore anything the sidebar did not provide.
  let info: TabInfoLike | undefined
  try { info = props.useTabInfo?.() } catch { info = undefined }
  const tabId = info?.tab?.id
  const paneId = info?.panel?.id

  return (
    <div className="dsh-ph-sidechat">
      <div className="dsh-ph-sidechat-head">
        {tabId !== undefined && (
          <button type="button" className="dsh-ph-iconButton" title={T('sideChat.float')} onClick={() => { floatSideChatTab(tabId) }}>
            ⧉
          </button>
        )}
        {paneId !== undefined && (
          <button type="button" className="dsh-ph-iconButton" title={T('sideChat.split')} onClick={() => { splitSideChatTab(paneId) }}>
            ◫
          </button>
        )}
        {paneId !== undefined && (
          <button type="button" className="dsh-ph-iconButton" title={T('sideChat.dock')} onClick={() => { dockSideChatTab(paneId) }}>
            ⤓
          </button>
        )}
        {info?.tab?.actions?.close !== undefined && (
          <button type="button" className="dsh-ph-iconButton" title={T('sideChat.closeTab')} onClick={() => { info?.tab?.actions?.close?.() }}>
            ✕
          </button>
        )}
      </div>
      <div className="dsh-ph-sidechat-strip">
        {list.map((thread) => {
          const state = snapshot.states.get(thread.id)
          return (
          <span key={thread.id} className={thread.id === active?.id ? 'dsh-ph-sidechat-chip dsh-ph-sidechat-chip--on' : 'dsh-ph-sidechat-chip'}>
            <button type="button" className="dsh-ph-sidechat-chipLabel" onClick={() => { setActiveId(thread.id) }}>
              {state?.running === true && <span className="dsh-ph-sidechat-running" aria-label={T('sideChat.running')}>⟳ </span>}
              {thread.title}
              {state !== undefined && state.unread > 0 && <span className="dsh-ph-sidechat-badge">{state.unread}</span>}
            </button>
            <button type="button" className="dsh-ph-sidechat-chipClose" aria-label={T('sideChat.close')} onClick={() => { threads.close(thread.id) }}>
              ×
            </button>
          </span>
          )
        })}
        <button type="button" className="dsh-ph-sidechat-chip" onClick={() => { start('fork') }}>
          ＋{T('sideChat.newFork')}
        </button>
        <button type="button" className="dsh-ph-sidechat-chip" onClick={() => { start('blank') }}>
          ＋{T('sideChat.newBlank')}
        </button>
      </div>

      <div className="dsh-ph-sidechat-log" ref={logRef}>
        {active === null
          ? <p className="dsh-ph-sidechat-empty">{T('sideChat.empty')}</p>
          : rows.length === 0
            ? <p className="dsh-ph-sidechat-empty">{T('sideChat.placeholder')}</p>
            : rows.map((row) => <Row key={`${row.key}:${row.text.length}`} row={row} />)}
      </div>

      <div className="dsh-ph-sidechat-compose">
        <PromptComposer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          running={running}
          history={history}
          predictContext={predictContext}
          placeholder={T('sideChat.input')}
        />
        {running
          ? (
            <button type="button" className="dsh-ph-button" onClick={() => { if (active !== null) void threads.cancel(active) }}>
              {T('sideChat.stop')}
            </button>
            )
          : (
            <button type="button" className="dsh-ph-button" onClick={submit}>
              {T('sideChat.send')}
            </button>
            )}
      </div>
    </div>
  )
}

/**
 * Register the side-chat tab type and body while the feature is enabled, and
 * withdraw both when it is switched off (no reload required).
 * @param ctx - client context with `sidebarRightTabs` and `slots` injected.
 * @returns disposer that withdraws the registration.
 */
function installSideChat(ctx: ClientContext): () => void {
  const disposeType = ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SIDE_CHAT_ID,
    kind: SIDE_CHAT_KIND,
    multiple: true,
    keepMounted: true,
    priority: 'extension',
    title: () => T('sideChat.title'),
  }), 'dsh-prompt-history: side-chat type')
  const disposeBody = ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SIDE_CHAT_ID, locale: NS },
    SideChatBody,
  )), 'dsh-prompt-history: side-chat body')
  const disposeTitle = ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: SIDE_CHAT_ID, locale: NS },
    SideChatTitle,
  )), 'dsh-prompt-history: side-chat title')
  return () => {
    disposeTitle()
    disposeBody()
    disposeType()
  }
}

/**
 * Bind the side chat to the sidebar services and follow the settings toggle.
 * @param ctx - a context that injects `sidebarRightTabs`, `sidebarRight` and `slots`.
 */
export function bindSideChat(ctx: ClientContext): void {
  serviceCtx = ctx
  let dispose: (() => void) | null = null
  const sync = (): void => {
    if (getPrefs().sideChat) {
      if (dispose === null) dispose = installSideChat(ctx)
    } else if (dispose !== null) {
      dispose()
      dispose = null
    }
  }
  sync()
  ctx.effect(() => subscribePrefs(sync), 'dsh-prompt-history: side-chat toggle')
}

/**
 * Open (or reveal) a side-chat tab.
 * @param thread - thread identity passed to the body as navigation params.
 */
export function openSideChat(thread = 't1'): void {
  if (serviceCtx === null) return
  // DSH types tab params through a merge-extensible map declared inside the
  // sidebar package, which a kind registered from outside cannot augment; the
  // payload is ours and validated by the body, so it crosses untyped.
  serviceCtx.sidebarRight.openTab(SIDE_CHAT_KIND, {
    params: { thread } as never,
    preferNewPane: true,
    revealIfOpened: true,
  })
}

/**
 * Float the tab into its own panel (the shell owns the mechanics).
 * @param tabId - this tab's id from `useTabInfo`.
 */
export function floatSideChatTab(tabId: string): void {
  try { serviceCtx?.sidebarRight.float(tabId as never) } catch { /* placement refused */ }
}

/** Return a floating panel to the docked column. */
export function dockSideChatTab(paneId: string): void {
  try { serviceCtx?.sidebarRight.dock(paneId as never) } catch { /* not floating */ }
}

/**
 * Split the pane holding this tab and seed the new pane.
 * @param paneId - the containing pane from `useTabInfo`.
 */
export function splitSideChatTab(paneId: string): void {
  try { serviceCtx?.sidebarRight.split(paneId as never) } catch { /* split unavailable */ }
}

/** Whether the sidebar bridge is ready (the settings button uses it). */
export function sideChatReady(): boolean {
  return serviceCtx !== null
}
