import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-10-03: the 10:00 AM PT residential run died 90 s in on
// "page.waitForTimeout: Target page, context or browser has been closed" (exit 1, runner line 662) —
// the debug Chrome's tab or browser went away and every later step used the dead page. The runner
// now waits on plain timers and re-acquires a live page (ensurePage) before every navigation.

export function closedPageHazards(src: string): string[] {
  const code = stripComments(src)
  const out: string[] = []
  if (/\bpage\.waitForTimeout\s*\(/.test(code)) out.push("page.waitForTimeout (throws once the page is closed)")
  const lines = code.split("\n")
  lines.forEach((l, i) => {
    if (!/\bpage\.goto\s*\(/.test(l)) return
    // Login grace / discovery hold wait on a person, before the walk; everything else must recover.
    const prev = lines.slice(Math.max(0, i - 3), i + 1).join("\n")
    if (!/ensurePage\(/.test(prev) && !/PANINI_HEADLESS|HOLD_MIN|DISCOVERY HOLD/.test(lines.slice(Math.max(0, i - 6), i).join("\n")))
      out.push(`line ${i + 1}: page.goto without ensurePage`)
  })
  return out
}

const SRC = readFileSync("scripts/ingest-panini-runner.mjs", "utf8")

describe("panini runner survives a closed tab / browser", () => {
  it("inspects real navigations (not vacuous)", () => {
    expect((stripComments(SRC).match(/\bpage\.goto\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it("no page-bound waits, and every walk navigation re-acquires a live page first", () => {
    expect(closedPageHazards(SRC)).toEqual([])
  })

  it("planted defects are caught", () => {
    expect(closedPageHazards("async function f(){ await page.waitForTimeout(100) }")).toHaveLength(1)
    expect(closedPageHazards("x\ny\nz\nw\nawait page.goto(url)")).toEqual(["line 5: page.goto without ensurePage"])
    expect(closedPageHazards('await ensurePage("x");\nawait page.goto(url)')).toEqual([])
  })
})
