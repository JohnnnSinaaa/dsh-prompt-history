/**
 * The context-suggestion overlay: the predicted next prompt, ghosted in the
 * empty composer with a "press Tab" hint, matching the Codex composer look.
 *
 * Vanilla DOM (like the plugin's other overlays) so it can be driven from event
 * handlers without re-rendering the composer. It sits inside the editor's
 * content box with the same font, and never receives pointer events.
 *
 * @module dsh-prompt-history/client/suggestOverlay
 */
import { COMPOSER_CARD, editorHost, editorText } from './editor.ts'

const CLASS = 'dsh-ph-suggest'
/** Toggled on the composer card while a prediction is on screen. */
const CARD_CLASS = 'dsh-ph-suggesting'
/** The composer's own placeholder ("描述你想要构建的内容…"). */
const PLACEHOLDER = '[data-composer-placeholder], [class*="placeholder"]'
let node: HTMLDivElement | null = null
/** Placeholders hidden for the current overlay, with their previous inline value. */
let hiddenPlaceholders: Array<{ el: HTMLElement; prev: string }> = []
/** Self-healing re-hide timer (the composer card can be remounted). */
let rehideTimer: number | null = null

/**
 * Keep re-applying the placeholder hiding while the overlay is on screen.
 *
 * Opening the app mounts the composer in stages: the card (and its placeholder)
 * can be replaced right after the first prediction, which would drop the class
 * and reveal the placeholder under the ghost. A light poll is cheaper and more
 * robust here than observing every mount point.
 */
function startRehide(): void {
  if (rehideTimer !== null) return
  rehideTimer = window.setInterval(() => {
    if (node === null) {
      stopRehide()
      return
    }
    hidePlaceholders()
  }, 400)
}

/** Stop the self-healing poll. */
function stopRehide(): void {
  if (rehideTimer !== null) {
    window.clearInterval(rehideTimer)
    rehideTimer = null
  }
}

/** Hide the composer placeholder (inline + via the card class for re-renders). */
function hidePlaceholders(): void {
  const card = document.querySelector<HTMLElement>(COMPOSER_CARD)
  card?.classList.add(CARD_CLASS)
  for (const el of document.querySelectorAll<HTMLElement>(PLACEHOLDER)) {
    // Re-showing for the same context must not record "hidden" as the value to
    // restore (that would leave the placeholder permanently hidden).
    if (el.style.visibility === 'hidden') continue
    hiddenPlaceholders.push({ el, prev: el.style.visibility })
    el.style.visibility = 'hidden'
  }
}

/** Restore every placeholder this overlay hid. */
function restorePlaceholders(): void {
  document.querySelector<HTMLElement>(COMPOSER_CARD)?.classList.remove(CARD_CLASS)
  for (const { el, prev } of hiddenPlaceholders) el.style.visibility = prev
  hiddenPlaceholders = []
}

/** Create the overlay style tag once. */
function ensureStyle(): void {
  if (document.querySelector('style[data-plugin-css="dsh-ph-suggest"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'dsh-ph-suggest'
  tag.textContent = [
    `.${CLASS}{position:fixed;z-index:2147482000;pointer-events:none;overflow:hidden;`,
    'white-space:pre-wrap;word-break:break-word;}',
    `.${CLASS} .dsh-ph-suggest-text{color:var(--dsw-alias-label-primary);opacity:.42;}`,
    `.${CLASS} .dsh-ph-suggest-hint{color:var(--dsw-alias-label-primary);opacity:.3;}`,
    `.${CLASS} .dsh-ph-suggest-hint--block{display:block;}`,
    // The composer's own hint must not sit under the prediction.
    `[data-composer-card].${CARD_CLASS} [data-composer-placeholder],`,
    `[data-composer-card].${CARD_CLASS} [class*="placeholder"]{visibility:hidden !important;}`,
  ].join('')
  document.head.appendChild(tag)
}

/**
 * Install the overlay stylesheet. Called once from the plugin body so the
 * placeholder-hiding rule exists even before the first prediction.
 */
export function installSuggestStyle(): void {
  ensureStyle()
}

/** Is a suggestion currently on screen? */
export function suggestionVisible(): boolean {
  return node !== null
}

/** Remove the suggestion overlay (idempotent). */
export function hideSuggestion(): void {
  stopRehide()
  restorePlaceholders()
  if (node !== null) {
    node.remove()
    node = null
  }
}

/** The editor's content box plus its line height, or null when unmeasurable. */
function editorBox(host: HTMLElement): { left: number; top: number; width: number; height: number; line: number } | null {
  const rect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const style = window.getComputedStyle(host)
  const pad = (side: string): number => Number.parseFloat(style.getPropertyValue(side)) || 0
  const fontSize = Number.parseFloat(style.fontSize) || 14
  const rawLine = Number.parseFloat(style.lineHeight)
  const line = Number.isFinite(rawLine) && rawLine > 0 ? rawLine : fontSize * 1.5
  return {
    left: rect.left + pad('padding-left'),
    top: rect.top + pad('padding-top'),
    width: Math.max(40, rect.width - pad('padding-left') - pad('padding-right')),
    height: Math.max(line, rect.height - pad('padding-top') - pad('padding-bottom')),
    line,
  }
}

/**
 * Draw the predicted prompt inside the empty composer.
 *
 * The hint sits on its own line when the composer is tall enough (the Codex
 * look) and inline after the prediction when it is not, so nothing is ever
 * clipped.
 * @param text - the predicted next prompt.
 * @param hint - the accept hint copy (already localized).
 * @param host - the composer editor host to align against.
 * @returns whether the overlay is on screen.
 */
export interface ShowSuggestionOptions {
  /** Hide the composer's own placeholder under the ghost (off for panel fields). */
  readonly hidePlaceholder?: boolean
}

export function showSuggestion(
  text: string,
  hint: string,
  host: HTMLElement,
  options: ShowSuggestionOptions = {},
): boolean {
  if (text === '') {
    hideSuggestion()
    return false
  }
  // Guard against a lagging draft state: never paint over real input.
  if (editorText(host).trim() !== '') {
    hideSuggestion()
    return false
  }
  const box = editorBox(host)
  if (box === null) {
    hideSuggestion()
    return false
  }
  ensureStyle()
  if (options.hidePlaceholder !== false) {
    hidePlaceholders()
    startRehide()
  }
  if (node === null) {
    node = document.createElement('div')
    node.className = CLASS
    node.setAttribute('aria-hidden', 'true')
    document.body.appendChild(node)
  }
  node.textContent = ''
  const card = document.querySelector<HTMLElement>(COMPOSER_CARD)
  const style = window.getComputedStyle(card ?? host)
  const textEl = document.createElement('span')
  textEl.className = 'dsh-ph-suggest-text'
  textEl.textContent = text
  const hintEl = document.createElement('span')
  hintEl.className = 'dsh-ph-suggest-hint'
  // The prediction may itself mention Tab (the conversation talks about it);
  // never repeat the hint in that case.
  const showHint = hint !== '' && !/tab/i.test(text)
  // A block hint needs a second line of room inside the composer.
  const block = box.height >= box.line * 2.1
  if (!showHint) {
    hintEl.textContent = ''
  } else if (block) {
    hintEl.classList.add('dsh-ph-suggest-hint--block')
    hintEl.textContent = hint
  } else {
    hintEl.textContent = ` ${hint}`
  }
  node.append(textEl, hintEl)
  node.style.font = style.font === '' ? 'inherit' : style.font
  node.style.letterSpacing = style.letterSpacing
  node.style.left = `${box.left}px`
  node.style.top = `${box.top}px`
  node.style.width = `${box.width}px`
  node.style.height = `${box.height}px`
  node.style.lineHeight = `${box.line}px`
  hintEl.style.fontSize = `${Math.max(10, (Number.parseFloat(style.fontSize) || 14) - 2)}px`
  return true
}
