/**
 * Parallel-write guard for the side chat.
 *
 * The side chat shares the main conversation's workspace and, by the user's
 * choice, may write files. Two agents editing one tree can clobber each other,
 * so this module turns the transcripts into the one fact that matters — which
 * files each side has touched — and reports the intersection.
 *
 * It is a reminder, never a gate: nothing here blocks a prompt or a write.
 *
 * @module dsh-prompt-history/client/guard
 */
import type { ChatRow } from './nodes.ts'

/**
 * File-looking tokens inside tool output: an absolute, home-relative or
 * dot-relative path ending in a short extension. Deliberately conservative —
 * a false positive here would nag the user about a file nobody touched.
 */
const PATH_PATTERN = /(?:^|[\s"'`(（[<=])((?:~|\.{1,2}|\/)[\w./@+-]*\.[A-Za-z0-9]{1,8})(?=[\s"'`),，。:：;\]}>]|$)/g

/** Extract the files a set of rows mentions. */
export function extractPaths(rows: readonly ChatRow[]): ReadonlySet<string> {
  const found = new Set<string>()
  for (const row of rows) {
    PATH_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null = PATH_PATTERN.exec(row.text)
    while (match !== null) {
      const path = match[1]
      if (path !== undefined && path.length > 2) found.add(normalize(path))
      match = PATH_PATTERN.exec(row.text)
    }
  }
  return found
}

/**
 * Normalize one path so the two sides compare equal: trailing sentence
 * punctuation is not part of the path.
 * @param path - raw token.
 * @returns the comparison form.
 */
function normalize(path: string): string {
  return path.replace(/[.,;:]+$/, '')
}

/**
 * Files both sides touched.
 * @param left - one side's paths.
 * @param right - the other side's paths.
 * @returns the shared paths, sorted, capped by the caller when rendering.
 */
export function overlaps(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  const shared: string[] = []
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const path of small) if (large.has(path)) shared.push(path)
  return shared.sort()
}
