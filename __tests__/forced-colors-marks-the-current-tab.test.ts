import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-07: under forced-colors (Windows High Contrast) every background and
// border colour is replaced, so the selected collection tab, the selected
// bottom-bar tab and the active header group computed IDENTICAL to their
// neighbours (measured at 390 px). app/globals.css marks the current one with
// an underline + a system-colour outline, keyed on the ARIA state the markup
// already carries. This pins the block and its three hooks; the visual was
// verified by injecting the rule on production under `forcedColors: active`.

const CSS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8")

describe("forced-colors: the current tab / bar item / header group is marked by more than colour", () => {
  const start = CSS.indexOf("@media (forced-colors: active)")
  it("declares a forced-colors block", () => {
    expect(start).toBeGreaterThan(-1)
  })
  const block = CSS.slice(start, CSS.indexOf("\n}\n", start) + 3)
  it.each([
    ['[role="tab"][aria-selected="true"]', "the selected tab"],
    ['nav[aria-label="Primary"] a[aria-current="page"]', "the bottom bar's current item"],
    ['a[data-ia-group][aria-current="page"]', "the header's active group"],
  ])("%s — %s", (selector) => {
    expect(block).toContain(selector)
  })
  it("uses an underline and an outline (both survive forced colours), not a colour", () => {
    expect(block).toMatch(/text-decoration:\s*underline/)
    expect(block).toMatch(/outline:\s*2px solid CanvasText/)
  })
  it("the hooks it keys on still exist in the components", () => {
    expect(readFileSync(join(__dirname, "..", "components", "MobileNav.tsx"), "utf8")).toContain('aria-label="Primary"')
    expect(readFileSync(join(__dirname, "..", "components", "TopNav.tsx"), "utf8")).toContain("data-ia-group")
    expect(readFileSync(join(__dirname, "..", "components", "collection-tab-bar.tsx"), "utf8")).toContain("aria-selected={isActive}")
  })
})
