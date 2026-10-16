/**
 * InputHistory: bash-like prompt history + right-click paste for the composer
 * (dsh-prompt-history). Renders nothing — it mounts capture-phase listeners on
 * the document while the session's composer card is live.
 *
 * Prompt history: Up recalls previously submitted prompts (newest first), Down
 * walks forward and restores the line that was being typed before browsing
 * began; editing the draft while browsing drops back to the live line. The '/'
 * and '@' suggestion menus keep their own arrow-key navigation: while the menu
 * (role=listbox inside the composer card) is open, the history listener
 * declines and the input trigger pipeline owns the keys.
 *
 * Right-click paste (terminal-style, like Linux): a right-click on the composer
 * textarea pastes the clipboard directly — no context menu. Paste runs the
 * SAME pipeline as Ctrl+V (execCommand('paste') fires the composer's own paste
 * handler, so images and reference chips behave identically), with a
 * navigator.clipboard fallback that splices text at the caret.
 *
 * Copy on select: any selection in the composer textarea (left-drag,
 * double-click, keyboard Shift+arrows, Ctrl+A) auto-copies once it stabilizes
 * — so select → right-click paste works end to end. Copy prefers the
 * composer's own handler (execCommand), with a navigator.clipboard fallback.
 *
 * History is fed from the conversation snapshot's user nodes (kind 'user' and
 * 'steering'), appended as they land — so everything submitted while the page
 * is open is recallable even after the session event window slides. Consecutive
 * duplicates collapse; on a session switch the window's in-window user messages
 * seed the list. Unlike a parallel storage ring, the history IS the session's
 * own message log: it stays consistent with the transcript, survives reloads
 * through the session itself, and needs no configuration or extra storage.
 *
 * Interception guards: composer textarea target only, no modifier keys
 * (Shift+Up still extends selection), no IME composition, machine not
 * adjudicating/submitting, session not removed.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ui-conversation SlotMap merge (the input.right entry) and the
// session standard kit members (useInput/inputActions).
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ui-session merge (useSession/sessionId) on DSH >= 0.2 layouts.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { getPrefs, subscribePrefs } from './prefs.ts'
import {
  flashCopied, hideSearchOverlay, hideSelectionToolbar, showSearchOverlay, showSelectionToolbar,
} from './feedback.ts'
import { T } from './i18n.ts'
import { pullOlderPage } from './sessionCtx.ts'
import { promptMessage, type PromptMessage } from './nodes.ts'
import {
  COMPOSER_CARD, editorFocused, editorHost, editorSelectedText, editorSelectionOffsets,
  focusEditor, isEditorTarget, setEditorCaret,
} from './editor.ts'
import { completionEligible, matchCompletion } from './completion.ts'
import { ghostVisible, hideGhost, showGhost } from './ghost.ts'
import { buildContext, getActiveBridge } from './suggest.ts'
import { insertIntoMain, quoteBlock, registerMainInserter, sendToSideChat } from './bridge.ts'
import { hideSuggestion, showSuggestion, suggestionVisible } from './suggestOverlay.ts'
import { ChatToc } from './ChatToc.tsx'

/** Full props of the input-history entry: framework standard kit + owner share. */
export type InputHistoryProps = PropsRuntime<'conversation.input.right'>

/** One browse-position snapshot; index -1 = showing the live draft (not browsing). */
interface BrowseState {
  /** History index currently shown; -1 = the live line. */
  readonly index: number
  /** The draft saved when browsing started; restored at the bottom edge. */
  readonly saved: string
  /** The exact draft our own setDraft last wrote (user-edit detection). */
  readonly lastSet: string | null
  /** Present only in prefix-search mode: the prefix that anchors the matches. */
  readonly prefix?: string
}

/** One active Ctrl+R reverse-search session (null = not searching). */
interface SearchState {
  /** The draft before the search started (restored on Escape). */
  readonly preSearch: string
  /** The incremental query typed so far. */
  readonly query: string
  /** History index of the currently displayed match (-1 = no match). */
  readonly matchIndex: number
}

/** Not-browsing state; also the reset target after edits and session switches. */
const RESET_BROWSE: BrowseState = { index: -1, saved: '', lastSet: null }

/** The suggestion menu (slash/at) renders a listbox inside the card while open. */
const OPEN_MENU = '[role="listbox"]'

/** DSH ≥ 0.1.2 moved the conversation nodes off the session snapshot onto the
 * chat view (useChat); the lifecycle fields (removed/hasMore/loadingOlder/
 * openState) stay on useSession. Node shapes differ per generation, so reads
 * go through rawNodesOf + promptMessage (nodes.ts). */
interface ChatLike {
  /** 0.1.1 session snapshot nodes, or a direct array on newer shapes. */
  nodes?: unknown
  /** 0.1.2 web: the old-shaped node array compatibility slice. */
  legacy?: { nodes?: unknown }
  /** 2.0.x desktop: ordered node keys + a store whose .get(key) returns a node. */
  order?: readonly string[]
  removed?: boolean
  hasMore?: boolean
  loadingOlder?: boolean
  openState?: string
}
type SelectorHook = (select: (snapshot: ChatLike) => unknown) => unknown

/** Pull the ordered node array out of whichever snapshot shape is present. */
function rawNodesOf(snapshot: ChatLike): readonly unknown[] {
  const legacy = snapshot.legacy?.nodes
  if (Array.isArray(legacy)) return legacy
  const order = snapshot.order
  const store = snapshot.nodes as { get?: (key: string) => unknown } | undefined
  if (Array.isArray(order) && store !== undefined && typeof store.get === 'function') {
    return order.map((key) => store.get?.(key)).filter((n): n is unknown => n !== null && n !== undefined)
  }
  if (Array.isArray(snapshot.nodes)) return snapshot.nodes
  return []
}

/**
 * The composer history + right-click-paste entry.
 * @param props - framework standard kit (useInput/useSession/inputActions/sessionId).
 * @returns null (the entry is invisible chrome).
 */
export function InputHistory(props: InputHistoryProps) {
  const { useInput, useSession, inputActions, sessionId } = props
  // rc.1 merges useChat into the same session standard props (nodes source).
  const useChat = (props as InputHistoryProps & { useChat?: unknown }).useChat
  const nodesHook = (typeof useChat === 'function' ? useChat : useSession) as SelectorHook | undefined
  const sessionHook = useSession as SelectorHook | undefined

  // Latest machine/session facts at event time (the listeners mount once).
  const draft = useInput((s: InputState) => s.draft)
  const phase = useInput((s: InputState) => s.phase)
  // Node shapes differ by DSH generation (old {kind,seq,content} vs 2.0.x
  // chatNode with data.content/anchorSeq, and rc.1's nodes being a store, not
  // an array). rawNodesOf + promptMessage normalize them to {kind, seq, text},
  // so nothing non-iterable or mis-shaped reaches the history or the directory.
  const rawNodes = (nodesHook?.((s: ChatLike) => rawNodesOf(s)) as readonly unknown[] | undefined) ?? []
  const messages = useMemo(
    () => rawNodes.map(promptMessage).filter((m): m is PromptMessage => m !== null),
    [rawNodes],
  )
  // Directory texts: consecutive duplicates collapsed, in conversation order.
  const tocTexts = useMemo(() => {
    const out: string[] = []
    for (const message of messages) {
      if (message.text !== null && out[out.length - 1] !== message.text) out.push(message.text)
    }
    return out
  }, [messages])
  const removed = sessionHook?.((s) => s.removed) as boolean | undefined ?? false

  // Full-history TOC: when the directory opens it asks us to widen the loaded
  // window backwards (loadOlder page by page) until hasMore is false, so every
  // earlier user message shows up in the directory, not just the initial window.
  const hasMore = sessionHook?.((s) => s.hasMore) as boolean | undefined ?? false
  const loadingOlder = sessionHook?.((s) => s.loadingOlder) as boolean | undefined ?? false
  const openState = sessionHook?.((s) => s.openState) as string | undefined ?? ''
  const [widen, setWiden] = useState(false)
  const widenBusyRef = useRef(false)
  const widenPagesRef = useRef(0)
  const requestWiden = useCallback((): void => { setWiden(true) }, [])
  useEffect(() => {
    if (!widen) return
    if (removed || openState !== 'open') { setWiden(false); return }
    if (!hasMore) { setWiden(false); return }
    if (loadingOlder || widenBusyRef.current) return
    if (widenPagesRef.current >= 60) { setWiden(false); return } // safety cap
    widenBusyRef.current = true
    widenPagesRef.current += 1
    void pullOlderPage(sessionId).finally(() => { widenBusyRef.current = false })
  }, [widen, hasMore, loadingOlder, openState, sessionId, removed])

  /** Submitted prompt texts, oldest → newest (per session; append-only). */
  const historyRef = useRef<string[]>([])
  /** User-node seqs already folded into historyRef (append-once dedup). */
  const seenRef = useRef<Set<number>>(new Set())
  const browseRef = useRef<BrowseState>(RESET_BROWSE)
  const searchRef = useRef<SearchState | null>(null)
  const liveRef = useRef({ draft, phase, removed, inputActions })
  liveRef.current = { draft, phase, removed, inputActions }

  // ---- prompt completion (Codex/fish-style type-ahead) ----
  /** Draft the user dismissed the ghost on (Esc); cleared whenever it changes. */
  const dismissedRef = useRef<string | null>(null)
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs)

  /**
   * Recompute the ghost from the live draft + caret. Cheap (a backward scan
   * over the history ring) and idempotent, so it can be driven from any event
   * that may have moved the caret or changed the draft.
   */
  const syncCompletion = useCallback((): void => {
    if (!getPrefs().promptCompletion) { hideGhost(); return }
    const host = editorHost()
    if (host === null) { hideGhost(); return }
    const card = document.querySelector<HTMLElement>(COMPOSER_CARD)
    if (card !== null && card.querySelector(OPEN_MENU) !== null) { hideGhost(); return }
    const live = liveRef.current
    if (live.phase === 'adjudicating' || live.phase === 'submitting' || live.removed) { hideGhost(); return }
    const current = live.draft
    if (!completionEligible(current)) { hideGhost(); return }
    if (dismissedRef.current === current) { hideGhost(); return }
    // Only complete from the end of the draft: mid-line edits stay untouched.
    const offsets = editorSelectionOffsets(host)
    if (offsets === null || offsets.start !== current.length || offsets.end !== current.length) { hideGhost(); return }
    const suffix = matchCompletion(current, historyRef.current)
    if (suffix === null) { hideGhost(); return }
    showGhost(suffix, host)
  }, [])

  // Let the side chat hand a conclusion back into this composer's draft.
  useEffect(() => registerMainInserter((text) => {
    const host = editorHost()
    if (host === null) return false
    const live = liveRef.current
    const next = live.draft === '' ? text : `${live.draft}\n\n${text}`
    const actions = live.inputActions as {
      captureInsertion?: () => unknown
      insertText?: (value: string, span: unknown) => boolean
      setDraft?: (value: string) => void
    }
    if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
      try {
        if (actions.insertText(`${live.draft === '' ? '' : '\n\n'}${text}`, actions.captureInsertion()) === true) return true
      } catch { /* fall through to a draft write */ }
    }
    actions.setDraft?.(next)
    setEditorCaret(host, next.length)
    return true
  }), [])

  // Any draft change re-arms the ghost (a dismissed ghost must not stick).
  useEffect(() => { dismissedRef.current = null }, [draft])

  // ---- context suggestion (Codex-style predicted next prompt) ----
  /** Last prediction, keyed by session + context so it never crosses sessions. */
  const suggestRef = useRef<{ key: string; text: string } | null>(null)
  /** Context the user dismissed with Escape (suppressed until it changes). */
  const suggestDismissedRef = useRef<string | null>(null)
  const suggestAbortRef = useRef<AbortController | null>(null)
  const suggestTimerRef = useRef<number | null>(null)
  /** One attempt chain at a time: overlapping triggers would cancel each other. */
  const suggestPendingRef = useRef(false)
  /** Empty model answers already retried for the current context. */
  const emptyTriesRef = useRef(0)

  /** Stop any scheduled or in-flight prediction and drop the overlay. */
  const clearSuggestion = useCallback((): void => {
    if (suggestTimerRef.current !== null) {
      window.clearTimeout(suggestTimerRef.current)
      suggestTimerRef.current = null
    }
    suggestAbortRef.current?.abort()
    suggestAbortRef.current = null
    suggestPendingRef.current = false
    hideSuggestion()
  }, [])

  /**
   * Predict the next prompt from the conversation and ghost it in the
   * (empty) composer. Cached per context, debounced, and cancelled by any
   * draft change or submit.
   */
  const requestSuggestion = useCallback((): void => {
    const live0 = liveRef.current
    if (!getPrefs().contextSuggest) { clearSuggestion(); return }
    const live = liveRef.current
    if (live.draft !== '' || live.phase !== 'plain' || live.removed) { clearSuggestion(); return }
    if (suggestPendingRef.current || suggestionVisible()) return
    const bridge = getActiveBridge()
    if (bridge === null) return
    const host = editorHost()
    if (host === null) return
    suggestPendingRef.current = true
    const controller = new AbortController()
    suggestAbortRef.current = controller
    let attempts = 0
    // Wait for the frame to settle before reading the conversation: node
    // updates arrive before React paints the chat rows, so an immediate read
    // would see an empty transcript. Empty reads retry cheaply — no model call
    // happens until there is context.
    const attempt = (): void => {
      suggestTimerRef.current = null
      const now = liveRef.current
      if (controller.signal.aborted || now.draft !== '' || now.phase !== 'plain' || now.removed) {
        suggestPendingRef.current = false
        return
      }
      let context = ''
      try {
        context = buildContext()
      } catch (error) {
        suggestPendingRef.current = false
        return
      }
      if (context.trim() === '') {
        // Nothing readable yet (fresh session): never keep another context's
        // prediction on screen while we wait for rows to render.
        hideSuggestion()
        attempts += 1
        // A freshly opened session can take a while to paint its rows; empty
        // reads cost nothing, so keep watching for up to ~24s.
        if (attempts < 20) suggestTimerRef.current = window.setTimeout(attempt, 1200)
        else suggestPendingRef.current = false
        return
      }
      if (suggestDismissedRef.current === context) { suggestPendingRef.current = false; return }
      const key = `${sessionId}:${context.slice(-600)}`
      if (suggestRef.current?.key !== key) emptyTriesRef.current = 0
      const cached = suggestRef.current
      if (cached !== null && cached.key === key) {
        suggestPendingRef.current = false
        if (cached.text !== '') showSuggestion(cached.text, T('suggest.accept'), host)
        return
      }
      void bridge.fetch(context, controller.signal).then((text) => {
        suggestPendingRef.current = false
        if (controller.signal.aborted) return
        const latest = liveRef.current
        if (latest.draft !== '' || latest.phase !== 'plain' || latest.removed) return
        // An empty answer must not hide a suggestion that is already on screen,
        // and must not be cached: a later turn can still produce one. Reasoning
        // models occasionally spend the whole budget thinking, so one silent
        // retry is allowed per context before giving up on it.
        if (text === '') {
          if (emptyTriesRef.current < 2) {
            emptyTriesRef.current += 1
            attempt()
          }
          return
        }
        emptyTriesRef.current = 0
        suggestRef.current = { key, text }
        showSuggestion(text, T('suggest.accept'), host)
      })
    }
    suggestTimerRef.current = window.setTimeout(attempt, 300)
  }, [clearSuggestion])

  // A suggestion belongs to one conversation: switching sessions (or starting a
  // new one) must drop it immediately instead of showing the previous session's
  // prediction in every view.
  useEffect(() => {
    suggestRef.current = null
    suggestDismissedRef.current = null
    emptyTriesRef.current = 0
    clearSuggestion()
  }, [sessionId, clearSuggestion])

  // Triggers: the empty composer gaining focus, and each turn that just ended.
  useEffect(() => {
    const card = document.querySelector(COMPOSER_CARD)
    if (card === null) return
    const onFocusIn = (event: Event): void => {
      if (!isEditorTarget(event.target)) return
      requestSuggestion()
    }
    card.addEventListener('focusin', onFocusIn)
    // Any edit means the composer is no longer empty: drop the suggestion at the
    // DOM level so it can never be painted over what the user is typing.
    const onEdit = (): void => { clearSuggestion() }
    card.addEventListener('beforeinput', onEdit, true)
    card.addEventListener('input', onEdit, true)
    card.addEventListener('paste', onEdit, true)
    // Conversation rows render after the node update; observing the scrollport
    // is what makes a freshly opened session (and every finished turn) predict.
    const scrollport = document.querySelector('[data-conversation-scroll]') ?? document.body
    const observer = new MutationObserver(() => { requestSuggestion() })
    observer.observe(scrollport, { childList: true, subtree: true, characterData: true })
    return () => {
      card.removeEventListener('focusin', onFocusIn)
      card.removeEventListener('beforeinput', onEdit, true)
      card.removeEventListener('input', onEdit, true)
      card.removeEventListener('paste', onEdit, true)
      observer.disconnect()
    }
  }, [requestSuggestion, clearSuggestion])

  // The composer being empty and the session idle is the precondition; the
  // effect also re-runs whenever conversation nodes arrive (a freshly opened
  // session renders its messages after mount, and each turn adds nodes), which
  // is exactly when a fresh prediction makes sense. The cache keeps this to at
  // most one model call per context.
  useEffect(() => {
    if (draft !== '') {
      clearSuggestion()
      return
    }
    if (phase === 'plain') requestSuggestion()
    else clearSuggestion()
  }, [draft, phase, messages.length, clearSuggestion, requestSuggestion])
  useEffect(() => {
    syncCompletion()
    // Caret moves (arrow keys, clicks, selection), layout shifts and scrolls all
    // move the ghost's anchor without changing the draft.
    document.addEventListener('selectionchange', syncCompletion)
    window.addEventListener('resize', syncCompletion)
    window.addEventListener('scroll', syncCompletion, true)
    return () => {
      document.removeEventListener('selectionchange', syncCompletion)
      window.removeEventListener('resize', syncCompletion)
      window.removeEventListener('scroll', syncCompletion, true)
      hideGhost()
    }
  }, [syncCompletion, draft, messages, prefs.promptCompletion])

  // Cross-session history ring: when the setting is on, the history persists
  // in localStorage (capped), survives reloads and session switches, and is
  // deduplicated against the whole ring instead of only consecutive entries.
  const RING_KEY = 'dsh-prompt-history.global'
  const RING_CAP = 200
  const loadRing = (): string[] => {
    try {
      const raw = localStorage.getItem(RING_KEY)
      if (raw === null) return []
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const saveRing = (history: readonly string[]): void => {
    try {
      localStorage.setItem(RING_KEY, JSON.stringify(history.slice(-RING_CAP)))
    } catch { /* storage unavailable */ }
  }

  // Seed the ring once on mount when the option is on.
  useEffect(() => {
    if (getPrefs().globalHistory && historyRef.current.length === 0) {
      historyRef.current = loadRing()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Session switch: with global history the ring persists (only the transient
  // browse/search state resets); otherwise a fresh per-session history.
  useEffect(() => {
    if (!getPrefs().globalHistory) historyRef.current = []
    seenRef.current = new Set()
    browseRef.current = RESET_BROWSE
    searchRef.current = null
    hideSearchOverlay()
  }, [sessionId])

  // Fold newly arrived user messages into the history (window slides; the
  // append-only list survives it). With global history, dedup against the
  // whole ring and persist it after every append.
  useEffect(() => {
    const seen = seenRef.current
    const history = historyRef.current
    const globalOn = getPrefs().globalHistory
    for (const message of messages) {
      if (seen.has(message.seq)) continue
      seen.add(message.seq)
      if (message.text === null) continue
      if (globalOn ? !history.includes(message.text) : history[history.length - 1] !== message.text) {
        history.push(message.text)
      }
    }
    if (globalOn) saveRing(historyRef.current)
  }, [messages])

  // Any draft change that is not our own history write ends the browse
  // session (bash drops the recalled line when you edit it).
  useEffect(() => {
    const browse = browseRef.current
    if (browse.index !== -1 && draft !== browse.lastSet) browseRef.current = RESET_BROWSE
  }, [draft])

  /**
   * Accept the visible prediction: focus the composer, insert the text through
   * the official insertion pair (falling back to a draft write), and drop the
   * overlay. Safe to call from anywhere — a missing editor simply does nothing.
   * @returns whether something was accepted.
   */
  const acceptSuggestion = useCallback((): boolean => {
    const predicted = suggestRef.current
    if (predicted === null || predicted.text === '') return false
    const host = editorHost()
    if (host === null) return false
    const actions = liveRef.current.inputActions as {
      captureInsertion?: () => unknown
      insertText?: (text: string, span: unknown) => boolean
      setDraft?: (text: string) => void
    }
    focusEditor(host)
    let inserted = false
    if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
      try { inserted = actions.insertText(predicted.text, actions.captureInsertion()) === true } catch { inserted = false }
    }
    if (!inserted) {
      actions.setDraft?.(predicted.text)
      setEditorCaret(host, predicted.text.length)
    }
    clearSuggestion()
    dismissedRef.current = null
    return true
  }, [clearSuggestion])

  // History keydown listener (mounts once; reads refs at event time):
  // ↑/↓ browse (with bash-style prefix search when the draft is non-empty)
  // and Ctrl+R incremental reverse search.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target
      // The prediction belongs to the composer even when the caret wandered off
      // (clicking around the page is normal while reading a suggestion): accept
      // Tab or → anywhere except inside another text field.
      const acceptKey = e.key === 'Tab' || e.key === 'ArrowRight'
      if (acceptKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        && suggestionVisible() && liveRef.current.draft === '' && suggestRef.current !== null) {
        const active = document.activeElement
        const otherField = active instanceof HTMLElement
          && active !== document.body
          && active.closest(COMPOSER_CARD) === null
          && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
        if (!otherField) {
          e.preventDefault()
          e.stopPropagation()
          acceptSuggestion()
          return
        }
      }
      if (!isEditorTarget(target)) return
      const card = (target as Element).closest(COMPOSER_CARD)
      if (card === null) return
      // IME composition stays native; the suggestion menu owns the keys.
      if (e.isComposing || e.keyCode === 229) return
      if (card.querySelector(OPEN_MENU) !== null) return
      const live = liveRef.current
      if (live.phase === 'adjudicating' || live.phase === 'submitting' || live.removed) return
      const history = historyRef.current
      const recall = (index: number): string => history[index] ?? ''
      const searchMatches = (query: string): number[] => {
        const out: number[] = []
        history.forEach((entry, i) => { if (entry.includes(query)) out.push(i) })
        return out
      }
      const prefixMatches = (prefix: string): number[] => {
        const out: number[] = []
        history.forEach((entry, i) => { if (entry.startsWith(prefix)) out.push(i) })
        return out
      }

      // ---- Ctrl+R: start reverse search, or step to the older match ----
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
        const active = searchRef.current
        if (active !== null) {
          e.preventDefault()
          e.stopPropagation()
          const matches = searchMatches(active.query)
          const pos = matches.indexOf(active.matchIndex)
          if (pos > 0) {
            const matchIndex = matches[pos - 1] ?? 0
            searchRef.current = { ...active, matchIndex }
            live.inputActions.setDraft(recall(matchIndex))
            showSearchOverlay(active.query, recall(matchIndex))
          }
          return
        }
        if (history.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        hideSelectionToolbar()
        const matchIndex = history.length - 1
        searchRef.current = { preSearch: live.draft, query: '', matchIndex }
        live.inputActions.setDraft(recall(matchIndex))
        showSearchOverlay('', recall(matchIndex))
        return
      }

      // ---- active reverse search: typed keys feed the query ----
      const active = searchRef.current
      if (active !== null) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault(); e.stopPropagation()
          searchRef.current = null
          hideSearchOverlay()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation()
          searchRef.current = null
          hideSearchOverlay()
          live.inputActions.setDraft(active.preSearch)
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault(); e.stopPropagation()
          const query = active.query.slice(0, -1)
          const matches = searchMatches(query)
          if (query === '') {
            const matchIndex = history.length - 1
            searchRef.current = { ...active, query, matchIndex }
            live.inputActions.setDraft(recall(matchIndex))
            showSearchOverlay('', recall(matchIndex))
          } else if (matches.length > 0) {
            const matchIndex = matches[matches.length - 1] ?? 0
            searchRef.current = { ...active, query, matchIndex }
            live.inputActions.setDraft(recall(matchIndex))
            showSearchOverlay(query, recall(matchIndex))
          } else {
            searchRef.current = { ...active, query, matchIndex: -1 }
            showSearchOverlay(query, '(无匹配)')
          }
          return
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation()
          const query = active.query + e.key
          const matches = searchMatches(query)
          const matchIndex = matches.length > 0 ? (matches[matches.length - 1] ?? 0) : -1
          searchRef.current = { ...active, query, matchIndex }
          if (matchIndex >= 0) {
            live.inputActions.setDraft(recall(matchIndex))
            showSearchOverlay(query, recall(matchIndex))
          } else {
            live.inputActions.setDraft(active.preSearch)
            showSearchOverlay(query, '(无匹配)')
          }
          return
        }
        // Any other key exits the search, keeping the current match (the key
        // then applies to the draft natively).
        searchRef.current = null
        hideSearchOverlay()
        return
      }

      // ---- context suggestion: Tab accepts the predicted next prompt ----
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (e.key === 'Escape' && suggestionVisible()) {
          suggestDismissedRef.current = buildContext()
          clearSuggestion()
          return
        }
        if ((e.key === 'Tab' || e.key === 'ArrowRight') && live.draft === '' && suggestionVisible() && acceptSuggestion()) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }

      // ---- prompt completion: Tab (or →) accepts the ghosted suffix ----
      if (getPrefs().promptCompletion && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'Escape' && ghostVisible()) {
          dismissedRef.current = live.draft
          hideGhost()
          return
        }
        if ((e.key === 'Tab' || (e.key === 'ArrowRight' && !e.shiftKey)) && !e.shiftKey) {
          const host = editorHost()
          if (host !== null) {
            const offsets = editorSelectionOffsets(host)
            const atEnd = offsets !== null && offsets.start === live.draft.length && offsets.end === live.draft.length
            if (atEnd) {
              const suffix = matchCompletion(live.draft, history)
              if (suffix !== null) {
                e.preventDefault()
                e.stopPropagation()
                const actions = live.inputActions as {
                  captureInsertion?: () => unknown
                  insertText?: (text: string, span: unknown) => boolean
                  setDraft?: (text: string) => void
                }
                let inserted = false
                if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
                  try { inserted = actions.insertText(suffix, actions.captureInsertion()) === true } catch { inserted = false }
                }
                if (!inserted) {
                  // Legacy hosts (DSH <= 0.1.x) have no insertText: replace the
                  // draft and park the caret after the accepted suffix.
                  const full = live.draft + suffix
                  actions.setDraft?.(full)
                  setEditorCaret(host, full.length)
                }
                dismissedRef.current = null
                hideGhost()
                return
              }
            }
          }
        }
      }

      // ---- arrow keys: prefix search (non-empty draft) or plain browse ----
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      if (history.length === 0) return
      const browse = browseRef.current

      if (e.key === 'ArrowDown' && browse.index === -1) return // native caret-down on the live line

      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'ArrowUp') {
        if (browse.index === -1) {
          const draft = live.draft
          if (draft !== '') {
            // Prefix search: the typed line is the prefix; recall the most
            // recent history entry starting with it (bash history-search-backward).
            const matches = prefixMatches(draft)
            if (matches.length === 0) return // no prefix match: keep the line
            const index = matches[matches.length - 1] ?? 0
            browseRef.current = { index, saved: draft, lastSet: recall(index), prefix: draft }
            live.inputActions.setDraft(recall(index))
          } else {
            // Plain recall: save the live line, recall the newest prompt.
            const index = history.length - 1
            browseRef.current = { index, saved: '', lastSet: recall(index) }
            live.inputActions.setDraft(recall(index))
          }
        } else if (browse.prefix !== undefined) {
          // Walk further back through prefix matches.
          const matches = prefixMatches(browse.prefix)
          const pos = matches.indexOf(browse.index)
          if (pos > 0) {
            const index = matches[pos - 1] ?? 0
            browseRef.current = { ...browse, index, lastSet: recall(index) }
            live.inputActions.setDraft(recall(index))
          }
        } else {
          const index = Math.max(0, browse.index - 1)
          browseRef.current = { ...browse, index, lastSet: recall(index) }
          live.inputActions.setDraft(recall(index))
        }
        return
      }

      // ArrowDown while browsing.
      if (browse.prefix !== undefined) {
        const matches = prefixMatches(browse.prefix)
        const pos = matches.indexOf(browse.index)
        if (pos < matches.length - 1) {
          const index = matches[pos + 1] ?? 0
          browseRef.current = { ...browse, index, lastSet: recall(index) }
          live.inputActions.setDraft(recall(index))
        } else {
          // Bottom edge of the prefix matches: restore the typed prefix.
          browseRef.current = RESET_BROWSE
          live.inputActions.setDraft(browse.saved)
        }
      } else if (browse.index + 1 >= history.length) {
        // Bottom edge: restore the saved live line and stop browsing.
        browseRef.current = RESET_BROWSE
        live.inputActions.setDraft(browse.saved)
      } else {
        const index = browse.index + 1
        browseRef.current = { ...browse, index, lastSet: recall(index) }
        live.inputActions.setDraft(recall(index))
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [])

  // Right-click paste (terminal style): a right-click on the composer editor
  // pastes the clipboard directly, like a Linux terminal.
  useEffect(() => {
    const pasteInto = (host: HTMLElement): void => {
      // The composer's own paste handler (chip matching, image intake) fires on
      // the native paste event execCommand dispatches — full Ctrl+V parity.
      focusEditor(host)
      if (document.execCommand('paste')) return
      // Fallback: read text and splice it at the selection ourselves.
      void navigator.clipboard.readText().then(
        (text) => {
          if (text === '') return
          const sel = editorSelectionOffsets(host)
          const start = sel?.start ?? liveRef.current.draft.length
          const end = sel?.end ?? start
          const draft = liveRef.current.draft
          const next = draft.slice(0, start) + text + draft.slice(end)
          liveRef.current.inputActions.setDraft(next)
          const caret = start + text.length
          requestAnimationFrame(() => { setEditorCaret(host, caret) })
        },
        () => { /* clipboard read denied: nothing to paste */ },
      )
    }

    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target
      if (!isEditorTarget(target)) return
      const live = liveRef.current
      if (live.phase === 'adjudicating' || live.phase === 'submitting' || live.removed) return
      // Toggle off: leave the native context menu alone.
      if (!getPrefs().rightClickPaste) return
      e.preventDefault()
      e.stopPropagation()
      const host = editorHost()
      if (host === null) return
      // Right-click does not focus in browsers; focus so the caret/selection is
      // authoritative for the paste (preventScroll: the caret is where the user
      // sees it already).
      focusEditor(host)
      pasteInto(host)
    }
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => { document.removeEventListener('contextmenu', onContextMenu, true) }
  }, [])

  // Selection-driven copy, two modes (Settings → 终端式输入): 'auto' copies
  // any stable non-empty selection directly (terminal-style, floods the system
  // clipboard — opt-in); 'toolbar' (default) shows an explicit 复制 button
  // above the selection and copies only when clicked (nothing writes the
  // clipboard on its own). Both modes apply
  // anywhere in the page — the composer editor (chip-aware via the composer's
  // own copy handler), chat messages, code blocks. A stable-window
  // debounce keeps mid-drag partial selections out; the toolbar is dismissed
  // by collapsing the selection, Escape, scrolling, or clicking elsewhere.
  useEffect(() => {
    let timer: number | undefined
    let lastKey = ''
    let dragStartedInEditor = false

    const selectionRect = (): DOMRect | null => {
      try {
        const sel = document.getSelection()
        if (sel !== null && !sel.isCollapsed && sel.rangeCount > 0) {
          const rect = sel.getRangeAt(0).getBoundingClientRect()
          if (rect.width > 0 || rect.height > 0) return rect
        }
      } catch { /* no range for textarea selections in some engines */ }
      const host = editorHost()
      if (host !== null && document.activeElement === host) {
        const rect = host.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) return rect
      }
      return null
    }

    const copyText = (text: string, key: string, focusHost?: HTMLElement): void => {
      if (key === lastKey) return // unchanged selection: already copied
      lastKey = key
      if (focusHost !== undefined && document.activeElement !== focusHost) {
        focusEditor(focusHost)
      }
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false // flaky across engines; fall back to the clipboard API
      }
      if (ok) {
        flashCopied(selectionRect())
        return
      }
      if (text === '') return
      navigator.clipboard.writeText(text).then(
        () => { flashCopied(selectionRect()) },
        (error) => { console.warn('[dsh-prompt-history] clipboard copy failed:', error) },
      )
    }

    const copySelection = (): void => {
      const live = liveRef.current
      if (live.phase === 'adjudicating' || live.phase === 'submitting' || live.removed) return

      // 1) Composer editor selection (the composer's own handler expands
      //    chips; only while it is the active selection or a drag started in
      //    it — a stale editor selection must not shadow a chat selection).
      const host = editorHost()
      if (host !== null && (document.activeElement === host || dragStartedInEditor)) {
        const text = editorSelectedText(host)
        if (text !== '') {
          copyText(text, `ed:${text}`, host)
          return
        }
      }

      // 2) Any other document selection (chat messages, code blocks, ...).
      const sel = document.getSelection()
      if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return
      const text = sel.toString()
      if (text === '') return
      copyText(text, `doc:${text}`)
    }

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      dragStartedInEditor = isEditorTarget(e.target)
    }

    // 引用: insert the FULL selected text into the composer as a markdown
    // quote block (each line prefixed with '> ', Codex-style) — everything is
    // visible and editable in the input. A blank line before (unless the draft
    // starts there) and a blank line after keep the quote distinct from the
    // user's own next input, which begins on a fresh line after the caret.
    const quoteSelection = (): void => {
      const live = liveRef.current
      if (live.phase === 'adjudicating' || live.phase === 'submitting' || live.removed) return
      const host = editorHost()
      if (host === null) return
      const hostFocused = document.activeElement === host
      let text = ''
      if (hostFocused) {
        text = editorSelectedText(host)
      } else {
        const sel = document.getSelection()
        if (sel !== null && !sel.isCollapsed) text = sel.toString()
      }
      if (text.trim() === '') return
      // A plain markdown blockquote (each line prefixed with '> '), matching
      // how other DSH quote plugins format it — minimal and clean in the
      // input, rendered as a proper blockquote when sent.
      const quoted = '> ' + text.replace(/\n/g, '\n> ')
      const draft = live.draft
      const caret = hostFocused ? (editorSelectionOffsets(host)?.start ?? draft.length) : draft.length
      // A blank line before the quote separates it from prior text; a SINGLE
      // newline after lets the next input start on the line right below it.
      const lead = caret > 0 && draft[caret - 1] !== '\n' ? '\n\n' : caret > 0 ? '\n' : ''
      const tail = '\n'
      const next = draft.slice(0, caret) + lead + quoted + tail + draft.slice(caret)
      live.inputActions.setDraft(next)
      const pos = caret + lead.length + quoted.length + tail.length
      requestAnimationFrame(() => {
        focusEditor(host)
        setEditorCaret(host, pos)
      })
      flashCopied(null, T('pill.quoted'))
    }

    const onSelectionChange = (): void => {
      const live = liveRef.current
      if (live.phase === 'adjudicating' || live.phase === 'submitting' || live.removed) {
        hideSelectionToolbar()
        return
      }
      const mode = getPrefs().copyMode
      const host = editorHost()
      const editorActive = host !== null
        && (document.activeElement === host || dragStartedInEditor)
        && editorSelectedText(host) !== ''
      const sel = document.getSelection()
      const domActive = sel !== null && !sel.isCollapsed
      if (!editorActive && !domActive) {
        window.clearTimeout(timer)
        hideSelectionToolbar()
        return
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (mode === 'auto') {
          copySelection()
        } else {
          const rect = selectionRect()
          if (rect !== null) {
            showSelectionToolbar(rect, quoteSelection, () => {
              const selection = document.getSelection()
              const text = selection !== null && !selection.isCollapsed ? selection.toString() : ''
              if (text.trim() === '') return
              sendToSideChat(quoteBlock(text))
            })
          }
        }
      }, 150)
    }

    // Toolbar dismissal: Escape, scrolling anywhere, and pointer-down outside
    // the toolbar itself (its own mousedown is suppressed to keep the
    // selection, and the click handler copies before any hide).
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hideSelectionToolbar()
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Element && e.target.closest('.dsh-ph-toolbar') !== null) return
      hideSelectionToolbar()
    }
    const onScroll = (): void => { hideSelectionToolbar() }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', hideSelectionToolbar)
    console.info('[dsh-prompt-history] copy modes active (toolbar/auto)')
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', hideSelectionToolbar)
      window.clearTimeout(timer)
      hideSelectionToolbar()
    }
  }, [])

  return prefs.tocVisible
    ? <ChatToc texts={tocTexts} onWiden={requestWiden} />
    : null
}
