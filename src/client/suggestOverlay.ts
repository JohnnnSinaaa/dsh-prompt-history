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
import { COMPOSER_CARD, editorHost } from './editor.ts'

const CLASS = 'dsh-ph-suggest'
let node: HTMLDivElement | null = null

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
  ].join('')
  document.head.appendChild(tag)
}

/** Is a suggestion currently on screen? */
export function suggestionVisible(): boolean {
  return node !== null
}

/** Remove the suggestion overlay (idempotent). */
export function hideSuggestion(): void {
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
export function showSuggestion(text: string, hint: string, host: HTMLElement): boolean {
  if (text === '') {
    hideSuggestion()
    return false
  }
  const box = editorBox(host)
  if (box === null) {
    hideSuggestion()
    return false
  }
  ensureStyle()
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
  // A block hint needs a second line of room inside the composer.
  const block = box.height >= box.line * 2.1
  if (block) {
    hintEl.classList.add('dsh-ph-suggest-hint--block')
    hintEl.textContent = hint
  } else {
    hintEl.textContent = hint === '' ? '' : ` ${hint}`
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
