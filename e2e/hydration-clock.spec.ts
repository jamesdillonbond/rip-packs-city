import { test, expect } from "playwright/test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { CONSOLE_FAILURES } from "./healthy-page"
import { armClockShift, assertClockShiftArmed, CLOCK_SHIFT_MS } from "./clock-shift"

// DETERMINISTIC hydration check: render each clock-reading insights board in a
// browser whose wall clock is 7 hours ahead of the server's, and require that
// nothing mismatches.
//
// See e2e/clock-shift.ts for why probabilistic detection was not enough — in
// short, the two green runs that followed the 2026-08-26 #418 fix both landed
// while the branch that had been failing could not render at all.
//
// ── THE PAGE SET IS DERIVED, NOT CURATED ───────────────────────────────────
// A hand-listed set drifts silently; this repo has paid for that in the smoke
// spec's own page list (5 of 30 boards, 2026-08-17). The population here is
// every `app/insights/<slug>/` that contains a CLIENT file which reads the wall
// clock — the same predicate as Rule C in
// __tests__/insights-client-dates-are-hydration-safe-guard.test.ts.
//
// ⚠ MARKED CALLS ARE DELIBERATELY IN SCOPE — they are the reason this exists.
// Rule C's `hydration-safe:` escape records the author's CLAIM that a clock read
// cannot run before mount. A static check cannot verify that claim; a shifted
// browser clock can. A board whose marker is wrong reds here.
//
// ⚠ WHAT A GREEN RUN DOES AND DOES NOT MEAN. It means: on this data, no page in
// the set renders clock-derived output during hydration. It does NOT mean the
// app is free of the class — a board with no clock read of its own can still
// receive one from a shared component, and the site-wide population lives in
// Rule C's ratchet, not here.
const WALL_CLOCK = /(\bDate\.now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\))/

function clockReadingBoards(): string[] {
  const root = join(process.cwd(), "app", "insights")
  const out: string[] = []
  for (const slug of readdirSync(root).sort()) {
    const dir = join(root, slug)
    if (!statSync(dir).isDirectory()) continue
    let hasPage = false
    let readsClock = false
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue
      if (file === "page.tsx") hasPage = true
      const raw = readFileSync(join(dir, file), "utf8")
      if (!raw.slice(0, 300).includes("use client")) continue
      if (WALL_CLOCK.test(stripComments(raw))) readsClock = true
    }
    if (hasPage && readsClock) out.push(`/insights/${slug}`)
  }
  return out
}

const BOARDS = clockReadingBoards()

// How long to let the bundle hydrate before reading what it logged. Same value
// as the smoke helper's, for the same reason: hydration errors surface after
// domcontentloaded.
const HYDRATION_SETTLE_MS = 1_500

function collectFailures(page: import("playwright/test").Page): string[] {
  const failures: string[] = []
  const record = (text: string) => {
    if (CONSOLE_FAILURES.some((rx) => rx.test(text))) failures.push(text.slice(0, 300))
  }
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") record(msg.text())
  })
  page.on("pageerror", (err) => record(err.message))
  return failures
}

test("the derived board set is not empty (this spec cannot pass vacuously)", () => {
  // ⚠ Asserts on what was ENUMERATED, never on how many boards are clean — a
  // count of dirty pages would go red the moment the population reached zero,
  // which is the goal.
  expect(
    BOARDS.length,
    "no /insights board reads the wall clock — either the app changed or the predicate broke",
  ).toBeGreaterThan(0)
  // The board this spec was written for. If it is ever refactored out of the
  // set, that should be a visible decision rather than a silent narrowing.
  expect(BOARDS).toContain("/insights/underpriced-serials")
})

for (const path of BOARDS) {
  test(`hydration is clock-independent: ${path}`, async ({ page }) => {
    // CONTROL FIRST, unshifted. If the page is broken for an unrelated reason,
    // this fails and says so — so a failure under the shift below is
    // attributable to the clock rather than to the page being generally sick.
    const controlFailures = collectFailures(page)
    await page.goto(path, { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("load").catch(() => {})
    await page.waitForTimeout(HYDRATION_SETTLE_MS)
    expect(
      controlFailures,
      `${path} already logs a client-side failure with the REAL clock — fix that first; ` +
        `the clock shift below is not the cause. Messages: ${controlFailures.join(" | ")}`,
    ).toEqual([])

    // Now the same page, hydrated 7 hours in the future.
    const context = page.context()
    const shifted = await context.newPage()
    const shiftedFailures = collectFailures(shifted)
    await armClockShift(shifted)
    await shifted.goto(path, { waitUntil: "domcontentloaded" })
    await shifted.waitForLoadState("load").catch(() => {})
    await assertClockShiftArmed(shifted)
    await shifted.waitForTimeout(HYDRATION_SETTLE_MS)

    expect(
      shiftedFailures,
      `${path} hydrated differently when the browser clock ran ${CLOCK_SHIFT_MS / 3_600_000}h ahead of the ` +
        `server's — i.e. its first client render reads the wall clock. That is React #418 in production ` +
        `whenever the cached HTML and the visitor's clock straddle a boundary, and the cached HTML can be ` +
        `HOURS old (measured 2.5h on 2026-08-27). Anchor the value to a server-stamped prop, or gate the ` +
        `call site on mount. Messages: ${shiftedFailures.join(" | ")}`,
    ).toEqual([])
    await shifted.close()
  })
}
