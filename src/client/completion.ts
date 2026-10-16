/**
 * Prompt-history completion (Codex/fish-style type-ahead).
 *
 * Pure matching: given the live draft and the prompt history (oldest → newest)
 * return the remaining suffix of the newest entry the draft is a prefix of.
 * Rendering lives in ghost.ts; acceptance is wired up by InputHistory so the
 * feature can be toggled from Settings.
 */

/** Hide absurdly long tails (a 3 KB suffix is never a useful ghost). */
const MAX_SUFFIX = 400

/**
 * Whether a draft can be completed at all.
 *
 * Only single-line plain prompts: a ghost suffix cannot be laid out across
 * lines, and `/` / `@` drafts belong to the built-in command/reference menus —
 * the plugin must not compete with them.
 * @param draft - the live composer draft.
 * @returns true when the draft may be completed.
 */
export function completionEligible(draft: string): boolean {
  if (draft === '') return false
  if (draft.includes('\n')) return false
  const head = draft.trimStart()
  if (head.startsWith('/') || head.startsWith('@')) return false
  return true
}

/** The tail of `entry` after `cut` characters, or null when it is not useful. */
function suffixOf(entry: string, cut: number): string | null {
  const suffix = entry.slice(cut)
  if (suffix === '') return null
  return suffix.length > MAX_SUFFIX ? null : suffix
}

/**
 * The completion suffix for `draft`, or null when nothing matches.
 *
 * A case-sensitive pass runs first so the user's own casing preference wins;
 * a case-insensitive pass then handles e.g. `git st` → `Git status` (the ghost
 * always renders the history entry's original casing).
 * @param draft - the live composer draft.
 * @param history - prompt history, oldest → newest.
 * @returns the ghost suffix, or null.
 */
export function matchCompletion(draft: string, history: readonly string[]): string | null {
  if (!completionEligible(draft)) return null
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry === undefined || entry.length <= draft.length) continue
    if (entry.includes('\n')) continue
    if (entry.startsWith(draft)) return suffixOf(entry, draft.length)
  }
  const lowered = draft.toLowerCase()
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry === undefined || entry.length <= draft.length) continue
    if (entry.includes('\n')) continue
    if (entry.toLowerCase().startsWith(lowered)) return suffixOf(entry, draft.length)
  }
  return null
}
