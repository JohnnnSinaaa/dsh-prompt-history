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
  private sequence = 0

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

  /** Subscribe to the thread list. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify the panel that the thread list changed. */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* one faulty listener must not starve the others */ }
    }
  }

  /**
   * Start a thread: fork the source session (full context) or create a blank one.
   * @param origin - fork inherits the whole conversation; blank starts empty.
   * @param sourceSessionId - the conversation to fork from (required for 'fork').
   * @param title - the panel label.
   * @returns the created thread, or null when the services are unavailable.
   */
  async start(origin: ThreadOrigin, sourceSessionId: string, title: string): Promise<SideThread | null> {
    const sessions = this.sessions()
    if (sessions === undefined) return null
    try {
      const sessionId = origin === 'fork' && sourceSessionId !== ''
        ? await sessions.fork({ sessionId: sourceSessionId })
        : await sessions.create({})
      const reference = sessions.retain(sessionId, { source: 'dsh-prompt-history.side-chat' })
      this.sequence += 1
      const thread: SideThread = {
        id: `t${this.sequence}`,
        sessionId,
        origin,
        title,
      }
      this.refs.set(thread.id, reference)
      this.threads.push(thread)
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
    const index = this.threads.findIndex((thread) => thread.id === threadId)
    if (index >= 0) this.threads.splice(index, 1)
    this.notify()
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
