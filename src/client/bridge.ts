/**
 * The bridge between the main conversation and the side chat.
 *
 * Two directions, one small registry each:
 *
 * - main → side: the selection toolbar (or any caller) hands text to the panel
 *   composer; the panel registers a listener when it is mounted, and anything
 *   sent while it is closed waits in a queue.
 * - side → main: the panel appends its conclusion to the main composer's draft
 *   through the inserter the composer entry registers for its session.
 *
 * @module dsh-prompt-history/client/bridge
 */
import { openSideChat } from './sideChat.tsx'
import { flashCopied } from './feedback.ts'
import { T } from './i18n.ts'

/** Format selection text as a plain markdown blockquote (the plugin's quote style). */
export function quoteBlock(text: string): string {
  return `> ${text.replace(/\n/g, '\n> ')}`
}

type TextHandler = (text: string) => void
/** The main composer's draft inserter: true when the text landed. */
type MainInserter = (text: string) => boolean

/** Registered by the main composer entry for its session. */
let mainInserter: MainInserter | null = null

/**
 * Register the main composer's "append to draft" behaviour.
 * @param insert - receives the text; returns whether it landed.
 * @returns disposer that clears the registration when the same handler is current.
 */
export function registerMainInserter(insert: MainInserter): () => void {
  mainInserter = insert
  return () => {
    if (mainInserter === insert) mainInserter = null
  }
}

/**
 * Append text to the main composer draft.
 * @param text - already-formatted text (quote or plain).
 * @returns whether a main composer accepted it.
 */
export function insertIntoMain(text: string): boolean {
  return mainInserter === null ? false : mainInserter(text)
}

/** Side-chat composer listeners (the panel registers while mounted). */
const panelListeners = new Set<TextHandler>()
/** Text sent while the panel was closed. */
const pending: string[] = []

/**
 * Send text to the side-chat composer, opening the panel first.
 *
 * Text is delivered to a mounted panel immediately, or queued until one mounts
 * (the panel drains the queue when it subscribes).
 * @param text - already-formatted text (typically a quote block).
 */
export function sendToSideChat(text: string): void {
  if (text.trim() === '') return
  if (!openSideChat()) {
    // Silently dropping the click is the one thing a user cannot recover from.
    flashCopied(null, T('sideChat.disabledHint'))
    return
  }
  if (panelListeners.size === 0) {
    pending.push(text)
    return
  }
  for (const listener of [...panelListeners]) {
    try { listener(text) } catch { /* one faulty listener must not starve the others */ }
  }
}

/**
 * Subscribe the panel composer to incoming text.
 * @param listener - receives text (queued text is flushed immediately).
 * @returns disposer removing the listener.
 */
export function subscribeSideChatInsert(listener: TextHandler): () => void {
  panelListeners.add(listener)
  for (const text of pending.splice(0)) {
    try { listener(text) } catch { /* ignore */ }
  }
  return () => { panelListeners.delete(listener) }
}
