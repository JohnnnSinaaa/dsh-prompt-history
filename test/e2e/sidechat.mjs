/**
 * Side-chat regressions: the default-on preference, the toolbar action that must
 * vanish when the feature is off, and the panel itself (open, fork a thread).
 *
 * @module dsh-prompt-history/test/e2e/sidechat
 */
import { openFirstSession, sleep } from './harness.mjs'

/** Open the settings section of this plugin. */
async function openSettingsSection(page) {
  await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="设置"]')
    if (button !== null) button.click()
  })
  await sleep(2200)
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], li, a, div, span')]
      .find((el) => el.children.length === 0 && /终端式输入|Terminal Input/.test((el.textContent ?? '').trim()))
    if (label === undefined) return
    const clickable = label.closest('button, [role="tab"], [role="menuitem"], li, a') ?? label
    clickable.click()
  })
  await sleep(1500)
}

/** The selection toolbar's button labels for a message selection. */
async function toolbarButtons(page) {
  await page.evaluate(() => {
    const row = document.querySelector('[data-chat-flow-kind="user"]')
    if (row === null) return
    const range = document.createRange()
    range.selectNodeContents(row)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await sleep(900)
  const labels = await page.evaluate(() => [...document.querySelectorAll('.dsh-ph-toolbar button')]
    .map((b) => (b.textContent ?? '').trim()))
  await page.keyboard.press('Escape')
  await sleep(300)
  return labels
}

/**
 * Run the side-chat suite.
 * @param page - an app page seeded with {@link import('./harness.mjs').BASE_PREFS}.
 * @param check - the runner's assertion collector.
 * @param browser - the browser, so a suite can probe the off-state in a second page.
 */
export async function sideChatSuite(page, check, browser) {
  await openFirstSession(page)

  // 1) Default-on: a fresh profile keeps the switch on, so the toolbar offers it.
  const withFeature = await toolbarButtons(page)
  check('side chat is on by default (toolbar offers 侧聊追问)',
    withFeature.includes('复制') && withFeature.includes('引用') && withFeature.some((label) => /侧聊/.test(label)),
    { labels: withFeature })

  // 2) Settings reads the toggle as enabled.
  await openSettingsSection(page)
  const settings = await page.evaluate(() => {
    const box = document.querySelector('.dsh-ph-settings')
    if (box === null) return { found: false }
    const rows = [...box.querySelectorAll('label')]
    const toggle = rows.find((row) => /侧聊|side chat/i.test(row.textContent ?? '') && !/冲突提醒|parallel writes/i.test(row.textContent ?? ''))
    const text = (box.textContent ?? '').replace(/\s+/g, ' ')
    return {
      found: true,
      checked: toggle?.querySelector('input')?.checked ?? null,
      groups: [...box.querySelectorAll('.dsh-ph-group')].map((g) => (g.textContent ?? '').trim()),
      version: (text.match(/v1\.[0-9.]+/) ?? [])[0] ?? null,
      bridgeOn: /桥接：已连接/.test(text),
    }
  })
  await page.keyboard.press('Escape')
  await sleep(700)
  check('settings shows the side-chat toggle as enabled',
    settings.found === true && settings.checked === true && settings.bridgeOn === true,
    settings)

  // 3) The panel opens and a fork thread appears (no model call involved).
  await openSettingsSection(page)
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((b) => /打开侧聊|Open side chat/.test((b.textContent ?? '').trim()))
    if (button !== undefined) button.click()
  })
  await sleep(2500)
  await page.keyboard.press('Escape')
  await sleep(1200)
  const panelOpen = await page.evaluate(() => document.querySelector('.dsh-ph-sidechat') !== null)
  const clickCreate = () => page.evaluate(() => {
    const create = [...document.querySelectorAll('.dsh-ph-sidechat button')]
      .find((b) => /带上下文|with context/i.test((b.textContent ?? '').trim()))
    if (create !== undefined) create.click()
  })
  await clickCreate()
  for (let i = 0; i < 12; i += 1) {
    await sleep(1500)
    const chips = await page.evaluate(() => document.querySelectorAll('.dsh-ph-sidechat-chipLabel').length)
    if (chips > 0) break
    // A host hiccup can drop the fork call; one user-visible retry is enough.
    if (i === 5) await clickCreate()
  }
  const panel = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.dsh-ph-sidechat-chipLabel')].map((b) => (b.textContent ?? '').trim()),
    composer: document.querySelector('.dsh-ph-sidechat-input') !== null,
    icons: [...document.querySelectorAll('.dsh-ph-iconButton')].map((b) => b.getAttribute('title')),
  }))
  check('side-chat panel opens and starts a forked thread',
    panelOpen && panel.chips.length > 0 && panel.composer,
    { panelOpen, panel })

  // 4) Regression: switching the feature off must remove the toolbar action.
  const { openApp, BASE_PREFS } = await import('./harness.mjs')
  const offPrefs = { version: 3, data: { ...BASE_PREFS.data, sideChat: false } }
  const off = await openApp(browser, offPrefs)
  await openFirstSession(off.page)
  const withoutFeature = await toolbarButtons(off.page)
  check('side-chat toolbar action disappears when the feature is off',
    withoutFeature.includes('复制') && withoutFeature.includes('引用') && !withoutFeature.some((label) => /侧聊/.test(label)),
    { labels: withoutFeature })
  await off.page.close()
}
