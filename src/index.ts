/**
 * dsh-prompt-history, node half. Mounts the prompt-suggestion Remote service
 * (the browser half reaches the model only through it); the browser half ships
 * via exports["./client"], discovered through the package.json dsh.client
 * declaration.
 */
import type { Context } from '@deepseek-ai/cordis'
import { PromptSuggestService } from './suggest.ts'

/**
 * Host plugin body: register the suggestion service so the Gateway can export
 * `promptSuggest/suggest` to the plugin's own client half.
 * @param ctx - the plugin's root Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(PromptSuggestService)
}

export { PromptSuggestService }
export type { SuggestRequest, SuggestResult } from './suggest.ts'
