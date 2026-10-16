/**
 * Prompt-history browsing, shared by the main composer and the side-chat
 * composer: bash-style prefix matching for ↑/↓, and substring matching for the
 * Ctrl+R reverse search. Pure functions so both composers keep the same feel.
 *
 * @module dsh-prompt-history/client/browse
 */

/** Indices of history entries that start with `prefix`, newest last. */
export function prefixMatches(history: readonly string[], prefix: string): number[] {
  const out: number[] = []
  if (prefix === '') {
    for (let i = 0; i < history.length; i += 1) out.push(i)
    return out
  }
  history.forEach((entry, index) => {
    if (entry.startsWith(prefix)) out.push(index)
  })
  return out
}

/** Indices of history entries containing `query`, newest last. */
export function containsMatches(history: readonly string[], query: string): number[] {
  const out: number[] = []
  if (query === '') return prefixMatches(history, '')
  history.forEach((entry, index) => {
    if (entry.includes(query)) out.push(index)
  })
  return out
}

/** One browse session: where we are plus the line to restore on the way back. */
export interface BrowseState {
  /** Index into the history, or -1 when not browsing. */
  readonly index: number
  /** The draft the user had before browsing started. */
  readonly saved: string
  /** The line this plugin last wrote (so an edit ends browsing). */
  readonly lastSet: string
  /** The prefix that started a prefix search, when there was one. */
  readonly prefix?: string
}

/** Not browsing. */
export const RESET_BROWSE: BrowseState = { index: -1, saved: '', lastSet: '' }

/**
 * Step one position through the matches of a prefix search.
 * @param history - prompt history, oldest → newest.
 * @param state - the current browse session (must carry a prefix).
 * @param delta - -1 for older, +1 for newer.
 * @returns the next state and line, or null when the walk leaves the matches.
 */
export function stepPrefix(
  history: readonly string[],
  state: BrowseState,
  delta: -1 | 1,
): { state: BrowseState; text: string } | null {
  const prefix = state.prefix ?? ''
  const matches = prefixMatches(history, prefix)
  const position = matches.indexOf(state.index)
  const next = position < 0 ? -1 : position + delta
  if (next < 0 || next >= matches.length) return null
  const index = matches[next] ?? 0
  return { state: { ...state, index, lastSet: history[index] ?? '' }, text: history[index] ?? '' }
}
