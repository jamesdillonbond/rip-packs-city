// 2026-09-24 — the Panini runner must read RECENT sales, not only TOP sales.
//
// The SALES HISTORY tab opens on "TOP SALES / ALL TIME" (nftSalesData sale_type:"top",
// pageSize 20): the twenty highest-priced sales ever. It was the only list the runner read,
// so last_sale_usd/_at came from a price-sorted sample — on Maradona Base Prizms Silver the
// eight sales of 09-05..09-15 ($14-$25) were absent while the published FMV sat at $40.93.
// The runner drives a live browser, so this is a SOURCE pin; the behavioural signal is DB-side
// (recent last_sale_at values appearing for editions walked after the pull).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = readFileSync(join(process.cwd(), "scripts/ingest-panini-runner.mjs"), "utf8")
const walk = src.slice(src.indexOf("for (const psku of pskus)"))

describe("panini runner — recent sales", () => {
  it("switches the sales dropdown from TOP SALES to RECENT SALES", () => {
    expect(src).toMatch(/async function openRecentSales\(/)
    expect(src).toMatch(/top\\s\*sales/)
    expect(src).toMatch(/recent\\s\*sales/)
  })

  it("reads recent sales in the per-card walk, after the tab is open", () => {
    const tab = walk.indexOf("await openSalesHistory()")
    const recent = walk.indexOf("await openRecentSales()")
    expect(tab).toBeGreaterThan(-1)
    expect(recent).toBeGreaterThan(tab)
  })

  it("is on unless explicitly disabled", () => {
    expect(src).toMatch(/SALES_RECENT = process\.env\.PANINI_SALES_RECENT !== "0"/)
  })
})
