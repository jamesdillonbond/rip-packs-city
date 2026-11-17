// Keyboard contract for role="tablist" (WAI-ARIA APG "Tabs"): Left/Right (and
// Up/Down) move between the tabs, Home/End jump to the ends. A BUTTON tab is
// activated as focus lands on it (automatic activation — the common pattern
// for in-page panel switchers and pill filters); a LINK tab only takes focus,
// and Enter follows it (manual activation — arrows must not navigate pages).
//
// 2026-11-07: nine tablists across eight components claimed the role with no
// arrow-key handling at all — a screen reader announced "tab 2 of 8" and the
// arrows did nothing. Attach as `onKeyDown={onTablistKeyDown}` on the element
// that carries role="tablist" (it reads its own `[role="tab"]` descendants, so
// a `display: contents` wrapper works too) together with `tabIndex={-1}`: the
// container is never in the Tab order (its tabs are), but jsx-a11y's
// interactive-supports-focus wants an element that handles keys to be
// focusable, and -1 satisfies it without adding a Tab stop. Pinned by
// __tests__/tablists-handle-arrow-keys.test.ts.
import type { KeyboardEvent } from "react"

const KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"])

export function onTablistKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (!KEYS.has(e.key)) return
  const root = e.currentTarget
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (t) => t.getAttribute("aria-disabled") !== "true" && !(t as HTMLButtonElement).disabled,
  )
  if (tabs.length < 2) return
  const current = tabs.findIndex((t) => t === document.activeElement || t.contains(document.activeElement))
  if (current === -1) return
  let next = current
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1) % tabs.length
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (current - 1 + tabs.length) % tabs.length
  else if (e.key === "Home") next = 0
  else if (e.key === "End") next = tabs.length - 1
  e.preventDefault()
  const target = tabs[next]
  target.focus()
  // Automatic activation for buttons only; a link tab waits for Enter.
  if (target.tagName === "BUTTON") target.click()
}
