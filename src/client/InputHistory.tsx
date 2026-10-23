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
import { matchCompletion } from './completion.ts'
import { useClipboard } from './useClipboard.ts'
import { useCompletion } from './useCompletion.ts'
import { RESET_BROWSE, type BrowseState, type SearchState } from './browse.ts'
import { foldHistory, loadRing, saveRing } from './historyRing.ts'
import { getActiveBridge } from './suggest.ts'
import { useSuggestion } from './useSuggestion.ts'
import { insertIntoMain, quoteBlock, registerMainInserter, sendToSideChat } from './bridge.ts'
import { ChatToc } from './ChatToc.tsx'

/** Full props of the input-history entry: framework standard kit + owner share. */
export type InputHistoryProps = PropsRuntime<'conversation.input.right'>

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
  /** Settings snapshot: the TOC render and the leaf flags follow it. */
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs)

  // Prediction lifecycle (cache, dismissal, debounce, pending line, accept).
  const suggestion = useSuggestion({ sessionId, liveRef, draft, phase, messagesLength: messages.length })
  // History-completion ghost (suffix of a past prompt after the caret).
  const completion = useCompletion({ liveRef, historyRef, draft })
  // Clipboard: right-click paste, copy modes, selection toolbar, quote.
  useClipboard({ liveRef })
  liveRef.current = { draft, phase, removed, inputActions }

  // ---- prompt completion (Codex/fish-style type-ahead) ----
  /** Draft the user dismissed the ghost on (Esc); cleared whenever it changes. */
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
    const globalOn = getPrefs().globalHistory
    foldHistory({ messages, seen: seenRef.current, history: historyRef.current, globalOn })
    if (globalOn) saveRing(historyRef.current)
  }, [messages])

  // Any draft change that is not our own history write ends the browse
  // session (bash drops the recalled line when you edit it).
  useEffect(() => {
    const browse = browseRef.current
    if (browse.index !== -1 && draft !== browse.lastSet) browseRef.current = RESET_BROWSE
  }, [draft])

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
        && suggestion.visible() && liveRef.current.draft === '') {
        const active = document.activeElement
        const otherField = active instanceof HTMLElement
          && active !== document.body
          && active.closest(COMPOSER_CARD) === null
          && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
        if (!otherField) {
          e.preventDefault()
          e.stopPropagation()
          suggestion.accept()
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
      // Ctrl/Cmd+Shift+Space: predict now. The automatic pass only fires when an
      // empty composer gains focus or a turn ends, so a dismissed (or slow)
      // prediction otherwise has no way back.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
        if (live.draft !== '' || live.phase !== 'plain' || live.removed) return
        e.preventDefault()
        e.stopPropagation()
        suggestion.requestNow()
        return
      }
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
        if (e.key === 'Escape' && suggestion.visible()) {
          suggestion.dismiss()
          return
        }
        if ((e.key === 'Tab' || e.key === 'ArrowRight') && live.draft === '' && suggestion.accept()) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }

      // ---- prompt completion: Tab (or →) accepts the ghosted suffix ----
      if (getPrefs().promptCompletion && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'Escape' && completion.visible()) {
          completion.dismiss()
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
                completion.sync()
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

  return prefs.tocVisible
    ? <ChatToc texts={tocTexts} onWiden={requestWiden} />
    : null
}
