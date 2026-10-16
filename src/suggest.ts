/**
 * Host half of the prompt-suggestion bridge.
 *
 * The browser cannot reach a model: the harness owns `ctx.llm` (provider
 * routes, credentials, quota). This service exposes one Remote method to the
 * plugin's client half through the Typert Gateway, so the composer can ask the
 * host for a predicted next prompt.
 *
 * @module dsh-prompt-history/suggest
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'

/** One prediction request from the composer. */
export interface SuggestRequest {
  /** Recent conversation, oldest → newest, already flattened to plain text. */
  readonly context: string
  /** Provider route override; the host default is used when absent. */
  readonly provider?: string
  /** Provider-owned model id override; the host default is used when absent. */
  readonly model?: string
}

/** One prediction result. `text` is '' when no suggestion could be produced. */
export interface SuggestResult {
  /** Single-line predicted user prompt, or '' when unavailable. */
  readonly text: string
}

/** The host services this bridge reads (structural: no runtime dependency). */
interface HostServices {
  get?: (key: string) => unknown
}

/** One selectable reasoning effort as the adapter describes it. */
interface HostEffortInfo {
  readonly id?: string
  readonly name?: string
}

/** The subset of `ctx.llm` used here. */
interface HostLlm {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: readonly { role: 'user'; content: readonly { type: 'text'; text: string }[] }[]
    maxTokens?: number
    temperature?: number
    reasoningEffort?: string
    signal?: AbortSignal
  }): AsyncIterable<{ type?: string; text?: string }>
  resolveModelInfo?: (provider: string, model: string) => Promise<unknown>
}

/** The subset of `ctx.agentDefaultModel` used here. */
interface HostDefaultModel {
  currentSelection?: () => { provider?: string; model?: string }
}

/** Instruction for the prediction call: one line, nothing else. */
const SYSTEM = [
  "You predict the user's next message in a coding-assistant conversation.",
  'Reply with that message only: a single line, no quotes, no explanation, no code fence.',
  'Match the language the user writes in and keep it under 160 characters.',
  'If the conversation suggests no clear next step, reply with nothing at all.',
].join(' ')

/** Longest conversation tail sent to the model. */
const MAX_CONTEXT = 6000
/** Longest accepted suggestion; longer answers are rejected as prose, not a prompt. */
const MAX_TEXT = 200

/**
 * Reduce model output to one plain line, or '' when it is not a usable prompt.
 * @param raw - the accumulated assistant text.
 * @returns the single-line suggestion, or ''.
 */
function sanitize(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('```')) text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()
  text = text.replace(/^[\s"'“”「」]+/, '').replace(/[\s"'“”「」]+$/, '').trim()
  const line = text.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
  if (line === '' || line.length > MAX_TEXT) return ''
  // A trailing "here is..." preamble means the model explained instead of predicting.
  if (/^(sure|okay|ok|here|the next|i think)\b/i.test(line)) return ''
  return line
}

/** Prompt-suggestion Remote service: turns recent conversation into a next prompt. */
export class PromptSuggestService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'promptSuggest')
  }

  /**
   * Predict the user's next prompt from the recent conversation.
   * @param request - conversation context plus optional model override.
   * @returns the predicted single-line prompt ('' when unavailable).
   */
  @Remote('suggest')
  async suggest(request: SuggestRequest): Promise<SuggestResult> {
    const ctx = (this as unknown as { ctx: HostServices }).ctx
    const context = typeof request?.context === 'string' ? request.context.slice(-MAX_CONTEXT) : ''
    if (context.trim() === '') return { text: '' }
    const llm = ctx.get?.('llm') as HostLlm | undefined
    if (llm === undefined || typeof llm.stream !== 'function') return { text: '' }
    let provider = request.provider
    let model = request.model
    if (provider === undefined || model === undefined) {
      const selection = (ctx.get?.('agentDefaultModel') as HostDefaultModel | undefined)?.currentSelection?.()
      provider = provider ?? selection?.provider
      model = model ?? selection?.model
    }
    if (provider === undefined || model === undefined) return { text: '' }

    /**
     * Run one prediction call and return the raw assistant text.
     * @param effort - reasoning effort to request, or undefined for the default.
     * @param maxTokens - response budget for this attempt.
     * @returns the accumulated assistant text.
     */
    const collect = async (effort: string | undefined, maxTokens: number): Promise<string> => {
      let out = ''
      const stream = llm.stream({
        provider: provider as string,
        model: model as string,
        system: SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: context }] }],
        maxTokens,
        temperature: 0.2,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        if (out.length > MAX_TEXT * 2) break
      }
      return out
    }

    // Reasoning models can spend the whole budget thinking and emit no text, so
    // ask for the cheapest effort the route offers; a second pass without any
    // effort hint (and a larger budget) recovers when the first comes back empty.
    const effort = await pickLowEffort(llm, provider, model)
    try {
      const first = sanitize(await collect(effort, 1024))
      if (first !== '') return { text: first }
      // Second pass without any effort hint (and a larger budget) recovers when
      // the provider ignored the low-effort request.
      return { text: sanitize(await collect(undefined, 3072)) }
    } catch (error) {
      console.warn('[dsh-prompt-history] prompt-suggestion call failed:', error)
      return { text: '' }
    }
  }
}

/**
 * The cheapest reasoning effort the route offers, or undefined when unknown.
 * @param llm - the host LLM service.
 * @param provider - provider route.
 * @param model - model id.
 * @returns the effort id to request.
 */
async function pickLowEffort(llm: HostLlm, provider: string, model: string): Promise<string | undefined> {
  try {
    const info = await llm.resolveModelInfo?.(provider, model) as
      | { reasoning?: { efforts?: readonly HostEffortInfo[] } }
      | undefined
    const efforts = info?.reasoning?.efforts ?? []
    if (efforts.length === 0) return undefined
    const low = efforts.find((entry) => /minimal|none|off|low|basic/i.test(`${entry.id ?? ''} ${entry.name ?? ''}`))
    return (low ?? efforts[efforts.length - 1])?.id
  } catch {
    return undefined
  }
}
