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
import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Context merge (ctx.sidebarRight / ctx.sidebarRightTabs).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { T } from './i18n.ts'
import { NS } from './locales.ts'
import { getPrefs, subscribePrefs } from './prefs.ts'

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

/** The tab body: thread strip, conversation area and composer. */
function SideChatBody(): JSX.Element {
  const [threads] = useState<readonly Thread[]>([{ id: 't1', title: T('sideChat.thread1') }])
  const [active, setActive] = useState('t1')
  return (
    <div className="dsh-ph-sidechat">
      <div className="dsh-ph-sidechat-strip">
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            className={thread.id === active ? 'dsh-ph-sidechat-chip dsh-ph-sidechat-chip--on' : 'dsh-ph-sidechat-chip'}
            onClick={() => { setActive(thread.id) }}
          >
            {thread.title}
          </button>
        ))}
      </div>
      <div className="dsh-ph-sidechat-log">
        <p className="dsh-ph-sidechat-empty">{T('sideChat.placeholder')}</p>
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
