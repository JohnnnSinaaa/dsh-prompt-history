/**
 * The inline completion ghost: the matched suffix rendered in dim text right
 * after the caret. Vanilla DOM (like the plugin's other overlays) so it can be
 * driven from event handlers without re-rendering the composer.
 *
 * Placement is measured from the live caret: on the Lexical contenteditable the
 * collapsed Range gives the caret box; on the legacy <textarea> a hidden mirror
 * of the text before the caret yields the same thing. When the box cannot be
 * measured the ghost simply stays hidden — a misplaced hint is worse than none.
 */
import { COMPOSER_CARD } from './editor.ts'

const GHOST_CLASS = 'dsh-ph-ghost'
let node: HTMLDivElement | null = null

/** Create the overlay style tag once. */
function ensureStyle(): void {
  if (document.querySelector('style[data-plugin-css="dsh-ph-ghost"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'dsh-ph-ghost'
  tag.textContent = [
    `.${GHOST_CLASS}{position:fixed;z-index:2147482000;pointer-events:none;`,
    'white-space:pre;overflow:hidden;font:inherit;opacity:.45;',
    'color:var(--dsw-alias-label-primary);}',
  ].join('')
  document.head.appendChild(tag)
}

/** Is the ghost currently on screen? */
export function ghostVisible(): boolean {
  return node !== null
}

/** Remove the ghost (idempotent). */
export function hideGhost(): void {
  if (node !== null) {
    node.remove()
    node = null
  }
}

/** A caret box with a usable height, or null. */
function usable(rect: DOMRect | undefined | null): DOMRect | null {
  if (rect === undefined || rect === null) return null
  if (rect.height <= 0 && rect.width <= 0) return null
  return rect
}

/** Caret box inside a contenteditable host (collapsed selection, then fallback). */
function editableCaretRect(host: HTMLElement): DOMRect | null {
  const sel = document.getSelection()
  if (sel === null || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const anchor = sel.anchorNode
  if (anchor === null || !(anchor === host || host.contains(anchor))) return null
  const direct = usable(range.getBoundingClientRect())
  if (direct !== null && direct.height > 0) return direct
  const rects = range.getClientRects()
  for (const rect of rects) {
    const hit = usable(rect)
    if (hit !== null && hit.height > 0) return hit
  }
  // Empty caret box (end of a line in some engines): measure the character
  // before the caret and take its right edge.
  const before = range.cloneRange()
  try {
    before.setStart(range.startContainer, Math.max(0, range.startOffset - 1))
    before.setEnd(range.startContainer, range.startOffset)
    const prev = usable(before.getBoundingClientRect())
    if (prev !== null && prev.height > 0) return prev
  } catch { /* boundary node: give up */ }
  return null
}

/** Caret box inside a legacy textarea, via a hidden mirror of the text before it. */
function textareaCaretRect(host: HTMLTextAreaElement): DOMRect | null {
  const box = host.getBoundingClientRect()
  if (box.height <= 0) return null
  const style = window.getComputedStyle(host)
  const mirror = document.createElement('div')
  const caret = document.createElement('span')
  mirror.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;' +
    `left:${box.left}px;top:${box.top}px;width:${box.width}px;` +
    `font:${style.font};letter-spacing:${style.letterSpacing};` +
    `padding:${style.padding};border:${style.borderWidth} solid transparent;box-sizing:${style.boxSizing};`
  mirror.textContent = host.value.slice(0, host.selectionStart ?? 0)
  caret.textContent = '\u200b'
  mirror.appendChild(caret)
  document.body.appendChild(mirror)
  const rect = usable(caret.getBoundingClientRect())
  mirror.remove()
  if (rect === null) return null
  return rect
}

/** The caret box for the composer host, or null when it cannot be measured. */
function caretRect(host: HTMLTextAreaElement | HTMLElement): DOMRect | null {
  if (host instanceof HTMLTextAreaElement) return textareaCaretRect(host)
  return editableCaretRect(host)
}

/**
 * Render `text` as a dim ghost right after the caret inside the composer.
 * @param text - the suffix to ghost.
 * @param host - the composer editor host holding the caret.
 * @returns whether the ghost is on screen.
 */
export function showGhost(text: string, host: HTMLTextAreaElement | HTMLElement): boolean {
  if (text === '') {
    hideGhost()
    return false
  }
  const rect = caretRect(host)
  if (rect === null) {
    hideGhost()
    return false
  }
  ensureStyle()
  if (node === null) {
    node = document.createElement('div')
    node.className = GHOST_CLASS
    node.setAttribute('aria-hidden', 'true')
    document.body.appendChild(node)
  }
  const card = document.querySelector<HTMLElement>(COMPOSER_CARD)
  const font = card !== null ? window.getComputedStyle(card).font : ''
  node.textContent = text
  node.style.font = font === '' ? 'inherit' : font
  node.style.left = `${rect.right}px`
  node.style.top = `${rect.top}px`
  node.style.height = `${rect.height}px`
  node.style.lineHeight = `${rect.height}px`
  return true
}
