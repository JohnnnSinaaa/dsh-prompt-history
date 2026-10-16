/**
 * Side-chat threads: each thread is backed by a real session on the host, so the
 * main conversation and the side chat run their own turns in parallel over the
 * same workspace.
 *
 * Everything here goes through services the shell exposes on the client root
 * context: `sessions` (create / fork / retain) and `uiConversation` (the
 * per-session assembled chat target). Both are resolved lazily on every call —
 * they appear only after the host connection is up — and every face is typed
 * structurally so nothing is imported at runtime.
 *
 * @module dsh-prompt-history/client/threads
 */
import { rootContextOrNull } from './sessionCtx.ts'
import { chatRows, snapshotNodes, type ChatRow } from './nodes.ts'

/** How a thread's session was obtained. */
export type ThreadOrigin = 'fork' | 'blank'

/** One side thread. */
export interface SideThread {
  /** Local identity used by the panel (the session id is the durable one). */
  readonly id: string
  readonly sessionId: string
  readonly origin: ThreadOrigin
  /** Editable label; the session's own title can override it later. */
  readonly title: string
}

/** Per-thread live state the chips badge. */
export interface ThreadState {
  /** A turn is producing right now. */
  readonly running: boolean
  /** Turns that finished while this thread was not the one on screen. */
  readonly unread: number
  /**
   * Rows already present when the thread started: a fork inherits the whole main
   * transcript, and counting those as "touched by the thread" would make the
   * write guard report a clash nobody caused.
   */
  readonly baseline: number
}

/** The panel's snapshot: the thread list plus each thread's live state. */
export interface ThreadSnapshot {
  readonly threads: readonly SideThread[]
  readonly states: ReadonlyMap<string, ThreadState>
}

/** A minimal observable: React reads it through useSyncExternalStore. */
export interface ThreadObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The behaviour verbs a thread's session exposes (see ISession). */
interface SessionFaceLike {
  readonly sessionId: string
  prompt(content: readonly unknown[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<unknown>
  cancel(): Promise<unknown>
  rename(title: string): Promise<unknown>
}

interface SessionReferenceLike {
  readonly sessionId: string
  readonly binding: { readonly session: SessionFaceLike }
  release(): void
}

interface SessionsLike {
  create(opts?: { workspaceId?: string; cwd?: string }): Promise<string>
  fork(opts: { sessionId: string }): Promise<string>
  retain(target: string, options: { source: string }): SessionReferenceLike
}

interface ChatTargetLike {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

interface ConversationBindingLike {
  target(name: 'chat'): ChatTargetLike
  /** Open-turn marker: the session is producing when it is not undefined. */
  openTurn: { getSnapshot(): number | undefined; subscribe(listener: () => void): () => void }
}

interface UiConversationLike {
  binding(source: string): ConversationBindingLike
}

/** Constant empty rows snapshot (stable identity). */
const NO_ROWS: readonly ChatRow[] = []

/** Threads and their session references, shared by every panel of this page. */
class ThreadStore {
  private readonly threads: SideThread[] = []
  private readonly refs = new Map<string, SessionReferenceLike>()
  private readonly rows = new Map<string, ThreadObservable<readonly ChatRow[]>>()
  private readonly turn = new Map<string, ThreadObservable<boolean>>()
  private readonly listeners = new Set<() => void>()
  private readonly states = new Map<string, ThreadState>()
  private readonly watchers = new Map<string, () => void>()
  private viewed: string | null = null
  private sequence = 0
  private cache: ThreadSnapshot = { threads: [], states: new Map() }

  /** The lazy `sessions` service, or undefined before the host connection. */
  private sessions(): SessionsLike | undefined {
    return rootContextOrNull()?.get('sessions') as SessionsLike | undefined
  }

  /** The lazy `uiConversation` service, or undefined before it is provided. */
  private conversation(): UiConversationLike | undefined {
    return rootContextOrNull()?.get('uiConversation') as UiConversationLike | undefined
  }

  /** Current threads (stable array identity between changes). */
  list(): readonly SideThread[] {
    return this.threads
  }

  /** Stable snapshot of threads and their live state. */
  snapshot(): ThreadSnapshot {
    return this.cache
  }

  /** State of one thread (never undefined for a known id). */
  stateOf(threadId: string): ThreadState {
    return this.states.get(threadId) ?? { running: false, unread: 0, baseline: 0 }
  }

  /** Total unread completions, for the sidebar tab chip. */
  unreadTotal(): number {
    let total = 0
    for (const state of this.states.values()) total += state.unread
    return total
  }

  /** Whether any thread is producing right now. */
  anyRunning(): boolean {
    for (const state of this.states.values()) if (state.running) return true
    return false
  }

  /**
   * Mark the thread the user is looking at: it stops being unread.
   * @param threadId - the on-screen thread, or null when the panel shows none.
   */
  setViewed(threadId: string | null): void {
    this.viewed = threadId
    if (threadId === null) return
    const state = this.states.get(threadId)
    if (state === undefined || state.unread === 0) return
    this.states.set(threadId, { ...state, unread: 0 })
    this.notify()
  }

  /** Subscribe to the thread list. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify the panel that the thread list changed. */
  private notify(): void {
    this.cache = { threads: [...this.threads], states: new Map(this.states) }
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* one faulty listener must not starve the others */ }
    }
  }

  /**
   * Start a thread: fork the source session (full context) or create a blank one.
   * @param origin - fork inherits the whole conversation; blank starts empty.
   * @param sourceSessionId - the conversation to fork from (required for 'fork').
   * @param label - the panel label the thread is numbered under.
   * @returns the created thread, or null when the services are unavailable.
   */
  async start(origin: ThreadOrigin, sourceSessionId: string, label: string): Promise<SideThread | null> {
    const sessions = this.sessions()
    if (sessions === undefined) return null
    try {
      const sessionId = origin === 'fork' && sourceSessionId !== ''
        ? await sessions.fork({ sessionId: sourceSessionId })
        : await sessions.create({})
      const reference = sessions.retain(sessionId, { source: 'dsh-prompt-history.side-chat' })
      // Number here, not in the caller: two quick creations would both read the
      // pre-push list length and collide on the same title.
      this.sequence += 1
      const thread: SideThread = {
        id: `t${this.sequence}`,
        sessionId,
        origin,
        title: `${label} ${this.sequence}`,
      }
      this.refs.set(thread.id, reference)
      this.states.set(thread.id, { running: false, unread: 0, baseline: this.rowsOf(sessionId).getSnapshot().length })
      this.threads.push(thread)
      this.watchTurn(thread.id, thread.sessionId)
      this.notify()
      return thread
    } catch (error) {
      console.warn('[dsh-prompt-history] side-chat session start failed:', error)
      return null
    }
  }

  /** Send one prompt to a thread. */
  async send(thread: SideThread, text: string): Promise<boolean> {
    const reference = this.refs.get(thread.id)
    if (reference === undefined || text.trim() === '') return false
    try {
      await reference.binding.session.prompt([{ type: 'text', text }], 'queue')
      return true
    } catch (error) {
      console.warn('[dsh-prompt-history] side-chat prompt failed:', error)
      return false
    }
  }

  /** Cancel the thread's running turn. */
  async cancel(thread: SideThread): Promise<void> {
    const reference = this.refs.get(thread.id)
    if (reference === undefined) return
    try { await reference.binding.session.cancel() } catch { /* already settled */ }
  }

  /** Close a thread and release its session reference. */
  close(threadId: string): void {
    const reference = this.refs.get(threadId)
    if (reference !== undefined) {
      try { reference.release() } catch { /* released twice */ }
      this.refs.delete(threadId)
    }
    const stopWatching = this.watchers.get(threadId)
    if (stopWatching !== undefined) {
      stopWatching()
      this.watchers.delete(threadId)
    }
    this.states.delete(threadId)
    if (this.viewed === threadId) this.viewed = null
    const index = this.threads.findIndex((thread) => thread.id === threadId)
    if (index >= 0) this.threads.splice(index, 1)
    this.notify()
  }

  /**
   * Follow a thread's turn so a completion can be badged even while the user is
   * looking at another thread (or the panel is collapsed).
   * @param threadId - local thread identity.
   * @param sessionId - the thread's session.
   */
  private watchTurn(threadId: string, sessionId: string): void {
    const observable = this.runningOf(sessionId)
    let wasRunning = observable.getSnapshot()
    const stop = observable.subscribe(() => {
      const running = observable.getSnapshot()
      const state = this.states.get(threadId) ?? { running: false, unread: 0, baseline: 0 }
      const finished = wasRunning && !running
      wasRunning = running
      this.states.set(threadId, {
        running,
        unread: finished && this.viewed !== threadId ? state.unread + 1 : state.unread,
        baseline: state.baseline,
      })
      this.notify()
    })
    this.watchers.set(threadId, stop)
  }

  /**
   * The thread's rendered rows, assembled by the shell's own conversation
   * pipeline (the same snapshot the official view draws).
   * @param sessionId - the thread's session.
   * @returns an observable of rows, stable per session.
   */
  rowsOf(sessionId: string): ThreadObservable<readonly ChatRow[]> {
    const existing = this.rows.get(sessionId)
    if (existing !== undefined) return existing
    const conversation = this.conversation()
    if (conversation === undefined) {
      return { getSnapshot: () => NO_ROWS, subscribe: () => () => {} }
    }
    const target = conversation.binding(sessionId).target('chat')
    const listeners = new Set<() => void>()
    let cache: readonly ChatRow[] = chatRows(snapshotNodes(target.getSnapshot()))
    const unsubscribe = target.subscribe(() => {
      cache = chatRows(snapshotNodes(target.getSnapshot()))
      for (const listener of [...listeners]) {
        try { listener() } catch { /* ignore */ }
      }
    })
    const observable: ThreadObservable<readonly ChatRow[]> = {
      getSnapshot: () => cache,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) {
            unsubscribe()
            this.rows.delete(sessionId)
          }
        }
      },
    }
    this.rows.set(sessionId, observable)
    return observable
  }

  /**
   * Whether the thread is producing a turn.
   * @param sessionId - the thread's session.
   * @returns an observable boolean, stable per session.
   */
  runningOf(sessionId: string): ThreadObservable<boolean> {
    const existing = this.turn.get(sessionId)
    if (existing !== undefined) return existing
    const conversation = this.conversation()
    if (conversation === undefined) {
      return { getSnapshot: () => false, subscribe: () => () => {} }
    }
    const openTurn = conversation.binding(sessionId).openTurn
    const listeners = new Set<() => void>()
    let cache = openTurn.getSnapshot() !== undefined
    const unsubscribe = openTurn.subscribe(() => {
      cache = openTurn.getSnapshot() !== undefined
      for (const listener of [...listeners]) {
        try { listener() } catch { /* ignore */ }
      }
    })
    const observable: ThreadObservable<boolean> = {
      getSnapshot: () => cache,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) {
            unsubscribe()
            this.turn.delete(sessionId)
          }
        }
      },
    }
    this.turn.set(sessionId, observable)
    return observable
  }
}

/** The page-wide thread store. */
export const threads = new ThreadStore()
