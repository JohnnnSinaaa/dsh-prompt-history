/**
 * Client half of the prompt-suggestion bridge.
 *
 * The browser cannot call a model, so the host service registered by this
 * package's node half (`promptSuggest/suggest`) is mounted here through the
 * Typert Gateway and called with the recent conversation. Every failure is
 * swallowed: a missing host, an unmounted descriptor or a dead connection must
 * never disturb the composer.
 *
 * @module dsh-prompt-history/client/suggest
 */

/** The client Remote face this module consumes (structural: no runtime dep). */
interface RemoteFace {
  $mount?: (contribution: unknown) => Promise<unknown>
  promptSuggest?: {
    suggest?: (request: SuggestRequest, signal?: AbortSignal) => Promise<unknown>
  }
}

/** One prediction request (mirrors the host contract). */
export interface SuggestRequest {
  /** Recent conversation, oldest → newest, flattened to plain text. */
  readonly context: string
  /** Provider route override; the host default is used when absent. */
  readonly provider?: string
  /** Provider-owned model id override; the host default is used when absent. */
  readonly model?: string
}

/** One prediction result (mirrors the host contract). */
export interface SuggestResult {
  /** Single-line predicted prompt, or '' when unavailable. */
  readonly text: string
}

/**
 * Hand-written consumer descriptors for this package's host face. The official
 * packages generate these; the shape is public
 * (`InvocationDescriptor` in @deepseek-ai/dsh-typert-protocol) and the
 * `src-json` codec needs no schema.
 */
/**
 * A minimal strict codec. The consumer side only validates `mode === 'strict'`
 * (schema materialization happens on the host), so a pass-through schema keeps
 * this plugin free of a schema dependency.
 * @param typeSymbol - stable host-face symbol for diagnostics.
 * @returns one strict codec descriptor.
 */
function strictCodec(typeSymbol: string): {
  mode: 'strict'
  typeSymbol: string
  create: () => { safeParse: (value: unknown) => { success: true; data: unknown } }
} {
  return {
    mode: 'strict',
    typeSymbol,
    // Only `mode` is read on this side; the host owns schema materialization.
    create: () => ({ safeParse: (value: unknown) => ({ success: true as const, data: value }) }),
  }
}

const CONTRIBUTION = {
  package: 'dsh-prompt-history',
  descriptors: [
    {
      id: 'dsh-prompt-history#promptSuggest/suggest',
      service: 'promptSuggest',
      namespace: 'promptSuggest',
      method: 'suggest',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: strictCodec('dsh-prompt-history#promptSuggest/suggest:request'),
        },
      ],
      result: strictCodec('dsh-prompt-history#promptSuggest/suggest:result'),
    },
  ],
} as const

/** The mounted bridge: fetch one prediction, or '' when unavailable. */
export interface SuggestBridge {
  /**
   * Ask the host for a predicted next prompt.
   * @param context - recent conversation text.
   * @param signal - cancellation (a new keystroke or a submit aborts it).
   * @returns the predicted single-line prompt, or '' when unavailable.
   */
  fetch(context: string, signal?: AbortSignal): Promise<string>
}

/**
 * Mount this package's host face on the client Remote service.
 *
 * Must run inside a context that injects `remote`; the namespace service it
 * installs is `remote.<namespace>` (see the gateway's `remoteServiceKey`), so
 * binding happens from a second injected context that waits for that service.
 * @param ctx - a context with `remote` injected.
 * @returns true when the contribution mounted.
 */
export async function mountContribution(ctx: unknown): Promise<boolean> {
  const remote = (ctx as { remote?: Pick<RemoteFace, '$mount'> }).remote
  if (remote === undefined || typeof remote.$mount !== 'function') return false
  try {
    await remote.$mount(CONTRIBUTION)
    return true
  } catch (error) {
    console.warn('[dsh-prompt-history] prompt-suggestion bridge unavailable:', error)
    return false
  }
}

/**
 * Bind the mounted namespace service into a bridge.
 * @param ctx - a context with `remote.promptSuggest` injected.
 * @returns the bridge, or null when the namespace is not callable.
 */
export function createBridge(ctx: unknown): SuggestBridge | null {
  // The namespace service key is `remote.<namespace>`; the dotted inject proxy
  // refuses a read from a context that did not declare it, so resolve it with
  // `ctx.get` instead (same lookup, no declaration requirement).
  const getService = (ctx as { get?: (key: string) => unknown }).get
  const api = typeof getService === 'function'
    ? getService.call(ctx, 'remote.promptSuggest') as RemoteFace['promptSuggest']
    : undefined
  const call = api?.suggest
  if (typeof call !== 'function' || api === undefined) return null
  return {
    async fetch(context: string, signal?: AbortSignal): Promise<string> {
      try {
        // The carrier validates the argument count against the descriptor, so
        // the business argument is the only one sent; cancellation is honoured
        // by discarding the result (the caller checks its own signal).
        const raw = await call.call(api, { context }) as
          | SuggestResult
          | { readonly ok: true; readonly value: SuggestResult }
          | { readonly ok: false }
          | undefined
        // The carrier may hand back the bare value or its RemoteResult wrapper.
        const value = raw !== undefined && typeof raw === 'object' && 'ok' in raw
          ? (raw.ok ? raw.value : undefined)
          : raw
        const answer = typeof value?.text === 'string' ? value.text.trim() : ''
        // The conversation often discusses this feature, so the model may append
        // its own "按 Tab 接受" instruction; it is UI copy, never user content.
        return answer
          .replace(/[\s，,。.；;：:]*按?\s*(?:Tab|tab)\s*(?:键)?\s*(?:接受|确认|补全|采纳)[。.!！]?\s*$/u, '')
          .trim()
      } catch (error) {
        // Offline host, rate limit, cancelled call: simply no suggestion.
        return ''
      }
    },
  }
}

/** The mounted bridge for this page (set by the plugin apply, read by the composer entry). */
let activeBridge: SuggestBridge | null = null

/**
 * Publish the mounted bridge to the composer entry.
 * @param bridge - the mounted bridge, or null when unavailable.
 */
export function setActiveBridge(bridge: SuggestBridge | null): void {
  activeBridge = bridge
}

/** The mounted bridge, or null when the host face is unavailable. */
export function getActiveBridge(): SuggestBridge | null {
  return activeBridge
}

/** Longest conversation tail handed to the model. */
const MAX_CONTEXT = 6000
/** Rows of conversation inspected, newest last. */
const MAX_ROWS = 8
/** Longest text kept per row. */
const MAX_ROW = 1200

/**
 * Flatten the visible conversation into role-tagged text for the predictor.
 *
 * Reads the rendered rows (they carry both sides of the conversation, which the
 * node projection does not) and normalizes whitespace so the prompt stays
 * compact.
 * @returns the context tail, or '' when the conversation is not readable.
 */
export function buildContext(): string {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')].slice(-MAX_ROWS)
  const parts: string[] = []
  for (const row of rows) {
    const kind = row.getAttribute('data-chat-flow-kind')
    const role = kind === 'user' || kind === 'steering' ? 'user' : 'assistant'
    // Row text carries relative timestamps ("23分钟") that keep mutating; they
    // are not conversation and would re-key the cache on every repaint.
    const text = (row.textContent ?? '')
      .replace(/\s+/g, ' ')
      .replace(/(刚刚|\d+\s*(?:秒|分钟|小时|天|周|个月|年)前?)/g, ' ')
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_ROW)
    if (text !== '') parts.push(`${role}: ${text}`)
  }
  const joined = parts.join('\n')
  return joined.length > MAX_CONTEXT ? joined.slice(-MAX_CONTEXT) : joined
}
