// 2026-09-23 — the Panini runner must page the serial list, not stop at page 1.
//
// getPskuTotalCardsList is requested with `l: 30` and the detail page asks only for p:1 on
// load. Before this pin, every walk re-read at most 30 serials per card (max captured per
// edition walk = 30 EXACTLY), leaving 48% of serial asks un-re-read for 7+ days and 41% of
// sold serials unmatched. The fix scrolls the window so the SPA requests (and signs) p:2..N
// itself. The runner drives a live browser, so this is a SOURCE pin — the behavioural signal
// is DB-side: panini_serial_freshness.max_serials_per_edition_walk rising above 30.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = readFileSync(join(process.cwd(), "scripts/ingest-panini-runner.mjs"), "utf8")

describe("panini runner — serial paging", () => {
  it("defines the pager and it is ON by default", () => {
    expect(src).toMatch(/async function loadAllSerialPages\(/)
    const m = src.match(/SERIAL_PAGES_MAX = Number\(process\.env\.PANINI_SERIAL_PAGES \?\? (\d+)\)/)
    expect(m).not.toBeNull()
    // Largest Panini print run is 259 = 9 pages of 30, i.e. 8 EXTRA pages; the default
    // must cover it or the tail of the biggest cards is silently never read.
    expect(Number(m![1])).toBeGreaterThanOrEqual(8)
  })

  it("is called in the per-card walk BEFORE the sales-history click", () => {
    const walk = src.slice(src.indexOf("for (const psku of pskus)"))
    const paging = walk.indexOf("await loadAllSerialPages()")
    const sales = walk.indexOf("await openSalesHistory()")
    expect(paging).toBeGreaterThan(-1)
    expect(sales).toBeGreaterThan(-1)
    expect(paging).toBeLessThan(sales)
  })

  it("stops on a short final page instead of waiting out every card", () => {
    expect(src).toMatch(/before % 30 !== 0/)
  })
})
