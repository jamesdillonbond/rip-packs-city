// 2026-11-03 — the Panini runner drives a FRESH tab each run, never the CDP Chrome's existing tab.
//
// Measured that afternoon, one card, the same per-card code, alternated twice: on the long-lived tab
// the runner had been reusing run after run, serial paging took 27 s and the SALES HISTORY tab never
// fired in time (no TOP, no RECENT); on a fresh tab in the same Chrome, 3.5 s, and both lists landed
// in 0.7 s. Three same-day fixes (bfe6467, 9dcf8ae, c02ce193e) had read that tab's slowness as
// "Panini answers TOP slowly". The runner drives a live browser, so this is a SOURCE pin.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const src = stripComments(readFileSync(join(process.cwd(), "scripts/ingest-panini-runner.mjs"), "utf8"))
const fnBody = (name: string) => {
  const i = src.indexOf(`async function ${name}(`)
  expect(i, `${name} must exist`).toBeGreaterThan(-1)
  return src.slice(i, src.indexOf("\n  }\n", i))
}

describe("panini runner — its own tab, every run", () => {
  it("the walk page comes from openRunnerPage, which opens a NEW tab over CDP", () => {
    expect(src).toMatch(/let page = await openRunnerPage\(\);/)
    const open = fnBody("openRunnerPage")
    expect(open).toMatch(/const pg = await ctx\.newPage\(\);/)
    // the reused-tab selection survives only on the non-CDP (own persistent context) branch
    expect(open).toMatch(/if \(!CDP\) return ctx\.pages\(\)\.find/)
  })

  it("no CDP path picks up an existing tab: recovery opens its own too", () => {
    const ensure = fnBody("ensurePage")
    expect(ensure).toContain("page = await openRunnerPage();")
    expect(ensure).not.toMatch(/ctx\.pages\(\)\.find/)
  })

  it("a tab a crashed run left behind is closed BY TARGET ID, never by evaluating in other tabs", () => {
    const leftover = fnBody("closeLeftoverRunnerTab")
    expect(leftover).toContain('"Target.closeTarget"')
    expect(leftover).not.toMatch(/\.evaluate\(/)
    expect(src).toMatch(/if \(CDP\) await closeLeftoverRunnerTab\(\);\s*let page = await openRunnerPage\(\);/)
  })

  it("every exit path closes this run's tab (end of run, stall, early exits)", () => {
    expect(src).toMatch(/await closeRunnerPage\(\);\s*if \(CDP\) \{ await browser\.close\(\)/)
    expect(src).toMatch(/if \(v\.kind === "stall"\) \{ await closeRunnerPage\(\); process\.exit\(4\); \}/)
    expect((src.match(/await closeRunnerPage\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })
})

describe("panini runner — the serial-paging script is bounded", () => {
  it("races the in-page loop against a cap derived from its own worst case", () => {
    const fn = fnBody("loadAllSerialPages")
    expect(fn).toMatch(/const serialEval = page\.evaluate\(/)
    expect(fn).toMatch(/r = await Promise\.race\(\[serialEval, /)
    expect(fn).toMatch(/SERIAL_EVAL_CAP_MS = SERIAL_PAGES_MAX \* \(SERIAL_PAGE_WAIT_MS \+ \d+\) \+ \d+/)
    expect(fn).not.toMatch(/r = await page\.evaluate\(/)
  })
})
