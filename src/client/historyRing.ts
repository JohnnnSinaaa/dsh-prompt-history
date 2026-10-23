/**
 * The cross-session history ring: the localStorage-backed prompt list used when
 * "cross-session history memory" is on, plus the folding rule that turns
 * newly-arrived conversation messages into history entries.
 *
 * Pure apart from the storage reads/writes, so the composer keeps only the thin
 * effects that call it.
 *
 * @module dsh-prompt-history/client/historyRing
 */
import type { PromptMessage } from './nodes.ts'

/** Storage key for the persisted ring. */
export const RING_KEY = 'dsh-prompt-history.global'
/** Maximum entries kept (oldest dropped). */
export const RING_CAP = 200

/**
 * Read the persisted ring.
 * @returns the stored prompts, oldest first (empty when unreadable).
 */
export function loadRing(): string[] {
  try {
    const raw = localStorage.getItem(RING_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Persist the ring, capped.
 * @param history - the full ring, oldest first.
 */
export function saveRing(history: readonly string[]): void {
  try {
    localStorage.setItem(RING_KEY, JSON.stringify(history.slice(-RING_CAP)))
  } catch { /* storage unavailable */ }
}

/**
 * Fold newly-arrived user messages into the history list.
 *
 * The history is the session's own message log, so every submit becomes
 * recallable as its node lands. Dedup is consecutive duplicates for the
 * per-session list, and "already anywhere in the ring" when the cross-session
 * ring is on (that list outlives the session, so a prompt may come back).
 *
 * @param params - the message batch, the seen-seq set, the list, and the mode.
 * @returns whether anything was appended.
 */
export function foldHistory(params: {
  readonly messages: readonly PromptMessage[]
  readonly seen: Set<number>
  readonly history: string[]
  readonly globalOn: boolean
}): boolean {
  const { messages, seen, history, globalOn } = params
  let appended = false
  for (const message of messages) {
    if (seen.has(message.seq)) continue
    seen.add(message.seq)
    if (message.text === null) continue
    if (globalOn ? !history.includes(message.text) : history[history.length - 1] !== message.text) {
      history.push(message.text)
      appended = true
    }
  }
  return appended
}
