import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The dead-letter drain must order by `attempts` (the column it WRITES) before
// block_time. Ordered on block_time alone, rows that can never resolve (2026-11-08:
// 43 `edition_not_ingested` sales from 08-12) hold the head of every 60-row batch
// until they reach MAX_PARK_ATTEMPTS, and the ~2,200 priceable sales behind them
// wait ~3 days. The route harness does not record a select's modifiers, so this
// pins the query text.
describe("candy-sales-indexer dead-letter drain order", () => {
  const src = readFileSync(join(process.cwd(), "app/api/candy-sales-indexer/route.ts"), "utf8")
  const start = src.indexOf('.from("candy_sales_unresolved")\n        .select("signature, token_mint, block_time')
  const query = src.slice(start, src.indexOf(".limit(DRAIN_LIMIT)", start))

  it("finds exactly one drain query", () => {
    expect(start).toBeGreaterThan(-1)
    expect(src.split(".limit(DRAIN_LIMIT)").length - 1).toBe(1)
  })

  it("orders fewest attempts first, then oldest", () => {
    const a = query.indexOf('.order("attempts", { ascending: true })')
    const b = query.indexOf('.order("block_time", { ascending: true })')
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
  })
})
