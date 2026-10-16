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
import { threads, type SideThread, type ThreadObservable } from './threads.ts'
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

/** Stable fallbacks so the body's hooks are unconditional. */
const NO_ROWS: readonly ChatRow[] = []
const EMPTY_ROWS: ThreadObservable<readonly ChatRow[]> = { getSnapshot: () => NO_ROWS, subscribe: () => () => {} }
const EMPTY_RUNNING: ThreadObservable<boolean> = { getSnapshot: () => false, subscribe: () => () => {} }

/** Standard props the session-scoped sidebar seat passes to a tab body. */
interface SideChatBodyProps {
  /** The conversation the sidebar is showing; threads fork from it by default. */
  readonly sessionId?: string
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
  const list = useSyncExternalStore(threads.subscribe.bind(threads), threads.list.bind(threads))
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

  // Follow the tail as the turn streams in.
  useEffect(() => {
    const log = logRef.current
    if (log !== null) log.scrollTop = log.scrollHeight
  }, [rows.length, active?.id])

  const sourceId = props.sessionId ?? ''
  const start = (origin: 'fork' | 'blank'): void => {
    const title = origin === 'fork'
      ? `${T('sideChat.origin.fork')} ${list.length + 1}`
      : `${T('sideChat.origin.blank')} ${list.length + 1}`
    void threads.start(origin, sourceId, title).then((thread) => {
      if (thread !== null) setActiveId(thread.id)
    })
  }

  const submit = (): void => {
    if (active === null || draft.trim() === '') return
    const text = draft
    setDraft('')
    void threads.send(active, text)
  }

  return (
    <div className="dsh-ph-sidechat">
      <div className="dsh-ph-sidechat-strip">
        {list.map((thread) => (
          <span key={thread.id} className={thread.id === active?.id ? 'dsh-ph-sidechat-chip dsh-ph-sidechat-chip--on' : 'dsh-ph-sidechat-chip'}>
            <button type="button" className="dsh-ph-sidechat-chipLabel" onClick={() => { setActiveId(thread.id) }}>
              {thread.title}
            </button>
            <button type="button" className="dsh-ph-sidechat-chipClose" aria-label={T('sideChat.close')} onClick={() => { threads.close(thread.id) }}>
              ×
            </button>
          </span>
        ))}
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
  return () => {
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

/** Whether the sidebar bridge is ready (the settings button uses it). */
export function sideChatReady(): boolean {
  return serviceCtx !== null
}
