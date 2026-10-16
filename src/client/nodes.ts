/**
 * Tolerant conversation-node reading across DSH generations.
 *
 * ≤ 0.1.1 (web): session nodes are `{ kind, seq, content: ContentBlock[] }`.
 * 0.1.2 rc (web): the same old-shaped array is exposed as the chat snapshot's
 *   `legacy.nodes` (and `nodes` holds a ChatNodeStore). 2.0.x (desktop) nodes
 *   are `chatNode`-shaped `{ key, kind, ..., anchorSeq, data }` with the text
 *   content under `data.content`. Everything below normalizes one node to the
 *   three facts the plugin needs: kind, seq, plain text.
 */

export interface PromptMessage {
  readonly kind: string
  /** Stable order identity for append-once dedup. */
  readonly seq: number
  /** Trimmed plain text of the message, or null when empty/unsupported. */
  readonly text: string | null
}

type NodeLike = {
  kind?: unknown
  seq?: unknown
  anchorSeq?: unknown
  content?: unknown
  data?: unknown
}

/** The node's ordering identity: anchorSeq (new), then seq (old), then data.seq. */
export function nodeSeq(node: NodeLike): number {
  for (const key of ['anchorSeq', 'seq'] as const) {
    const value = node[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  const data = node.data as { seq?: unknown } | undefined
  return typeof data?.seq === 'number' && Number.isFinite(data.seq) ? data.seq : 0
}

/** The node's text content blocks (old `content` or new `data.content`). */
function textBlocks(node: NodeLike): unknown {
  const content = node.content
  if (Array.isArray(content)) return content
  const data = node.data as { content?: unknown } | undefined
  if (data !== undefined && Array.isArray(data.content)) return data.content
  return []
}

/** Normalize one node into {kind, seq, text}; null for non-text/unsupported. */
export function promptMessage(node: unknown): PromptMessage | null {
  const n = node as NodeLike | null | undefined
  if (n === null || n === undefined) return null
  if (n.kind !== 'user' && n.kind !== 'steering') return null
  let text = ''
  for (const block of textBlocks(n) as ReadonlyArray<{ type?: unknown; text?: unknown }>) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  const trimmed = text.trim()
  if (trimmed === '') return null
  return { kind: n.kind as string, seq: nodeSeq(n), text: trimmed }
}

/** One rendered conversation row: the role decides the bubble, text is its body. */
export interface ChatRow {
  readonly role: 'user' | 'assistant' | 'tool' | 'other'
  /** Stable identity for React keys (node seq, 0 when unknown). */
  readonly key: number
  readonly text: string
}

/** The ordered node array out of whichever chat snapshot shape is present. */
export function snapshotNodes(snapshot: unknown): readonly unknown[] {
  const snap = snapshot as { order?: unknown; nodes?: unknown; legacy?: { nodes?: unknown } } | null | undefined
  if (snap === null || snap === undefined) return []
  const legacy = snap.legacy?.nodes
  if (Array.isArray(legacy)) return legacy
  const store = snap.nodes as { get?: (key: string) => unknown } | undefined
  if (Array.isArray(snap.order) && store !== undefined && typeof store.get === 'function') {
    return snap.order.map((key) => store.get?.(key)).filter((node) => node !== null && node !== undefined)
  }
  return Array.isArray(snap.nodes) ? snap.nodes : []
}

/** Map one node kind onto the row role the side-chat log draws. */
function rowRole(kind: unknown): ChatRow['role'] {
  if (kind === 'user' || kind === 'steering') return 'user'
  if (kind === 'assistant') return 'assistant'
  if (typeof kind === 'string' && (kind.startsWith('tool') || kind.includes('call') || kind.includes('result'))) return 'tool'
  return 'other'
}

/**
 * Flatten assembled conversation nodes into the rows a compact log renders.
 *
 * Works for every generation because the text extraction above already handles
 * `content` and `data.content`; empty rows (pure containers) are skipped.
 * @param nodes - the ordered node array from a chat snapshot.
 * @returns the rows, oldest first.
 */
export function chatRows(nodes: readonly unknown[]): readonly ChatRow[] {
  const rows: ChatRow[] = []
  for (const node of nodes) {
    const n = node as NodeLike | null | undefined
    if (n === null || n === undefined) continue
    let text = ''
    for (const block of textBlocks(n) as ReadonlyArray<{ type?: unknown; text?: unknown }>) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text += block.text
      }
    }
    const trimmed = text.trim()
    if (trimmed === '') continue
    rows.push({ role: rowRole(n.kind), key: nodeSeq(n), text: trimmed })
  }
  return rows
}
