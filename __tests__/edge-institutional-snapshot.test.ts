import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  isTransientErr,
  aggregateHoldingsByCollection,
  type HoldingRow,
} from "@/supabase/functions/_shared/institutional-snapshot"

// Pins the whale-holdings aggregation + retry classifier for
// snapshot-institutional-wallets. Wrong total_fmv_usd => every downstream
// "whale added $X" diff is wrong, and the run still logs ok:true.

describe("isTransientErr", () => {
  it("matches the transient set (retry-worthy)", () => {
    for (const m of [
      "statement timeout",
      "Timed out acquiring connection from connection pool",
      "upstream request timeout",
      "network error",
      "temporarily unavailable",
      "503 Service Unavailable",
      "HTTP 502",
      "504 Gateway Timeout",
      "429 Too Many Requests",
    ]) {
      expect(isTransientErr(m), m).toBe(true)
    }
  })
  it("does NOT match a hard/logic error (must fail fast, not retry)", () => {
    expect(isTransientErr("duplicate key value violates unique constraint")).toBe(false)
    expect(isTransientErr("column does not exist")).toBe(false)
    expect(isTransientErr("permission denied")).toBe(false)
  })
})

describe("aggregateHoldingsByCollection", () => {
  const rows: HoldingRow[] = [
    { collection_id: "c1", moment_id: "30", fmv_usd: 10.5 },
    { collection_id: "c1", moment_id: 20, fmv_usd: 4.25 },
    { collection_id: "c2", moment_id: "99", fmv_usd: 100 },
  ]

  it("groups per collection with a summed, cent-rounded FMV", () => {
    const out = aggregateHoldingsByCollection(rows)
    const c1 = out.find((o) => o.collection_id === "c1")!
    expect(c1.total_fmv_usd).toBe(14.75)
    expect(c1.moment_count).toBe(2)
    const c2 = out.find((o) => o.collection_id === "c2")!
    expect(c2.total_fmv_usd).toBe(100)
    expect(c2.moment_count).toBe(1)
  })

  it("sorts and string-coerces moment_ids (numeric ids never become NaN keys)", () => {
    const out = aggregateHoldingsByCollection(rows)
    const c1 = out.find((o) => o.collection_id === "c1")!
    expect(c1.moment_ids).toEqual(["20", "30"]) // string-sorted
  })

  it("treats null fmv_usd as 0, never NaN (one NaN would poison the whale total)", () => {
    const out = aggregateHoldingsByCollection([
      { collection_id: "c1", moment_id: "1", fmv_usd: null },
      { collection_id: "c1", moment_id: "2", fmv_usd: 5 },
    ])
    expect(out[0].total_fmv_usd).toBe(5)
    expect(Number.isNaN(out[0].total_fmv_usd)).toBe(false)
  })

  it("rounds half-cent sums to two decimals", () => {
    const out = aggregateHoldingsByCollection([
      { collection_id: "c1", moment_id: "1", fmv_usd: 0.1 },
      { collection_id: "c1", moment_id: "2", fmv_usd: 0.2 },
    ])
    expect(out[0].total_fmv_usd).toBe(0.3) // 0.1+0.2 rounded to cents
  })

  it("returns [] for no rows", () => {
    expect(aggregateHoldingsByCollection([])).toEqual([])
  })
})

describe("edge-fn source-drift guard", () => {
  const src = readFileSync(
    path.join(process.cwd(), "supabase/functions/snapshot-institutional-wallets/index.ts"),
    "utf8",
  )
  it("imports the shared aggregation + retry classifier", () => {
    expect(/from\s+["'][^"']*_shared\/institutional-snapshot/.test(src)).toBe(true)
    expect(/aggregateHoldingsByCollection/.test(src)).toBe(true)
    expect(/isTransientErr/.test(src)).toBe(true)
  })
  it("no longer defines an inline isTransientErr (single source of truth)", () => {
    expect(/function isTransientErr/.test(src)).toBe(false)
  })
})
