import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  isTransientErr,
  aggregateHoldingsByCollection,
  shouldPersistSnapshot,
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

// 🚨 A SNAPSHOT BUILT FROM AN INCOMPLETE WALK IS NOT THE DAY'S HOLDINGS.
//
// Measured 2026-09-13/14 on 0x4d2c9216f1dca098 (Top Shot): the snapshot series
// reads 52,120 · 52,120 · 1,000 · 52,120. The 1,000 is 4 pages × PAGE_SIZE,
// written by the 12:46Z run that died on `wmc_load_page_4` — and because the
// upsert is keyed on (wallet, collection, day) it OVERWROTE the complete
// snapshot the 10:07Z run had written two hours earlier.
//
// The next day's diff read 52,120 − 1,000 = ~51,120 "arrivals" and started
// inserting them as `direct_transfer` buybacks. Zero landed, but only because
// the statement timeout killed it at 156–178 s and rolled back — twice. The
// timeout is not a guard; this is.
//
// Same file's ORDER BY comment records variant one of this defect: 161,366
// fabricated buyback acquisitions over three months. That fix made a COMPLETED
// walk correct. This one stops an INCOMPLETE walk from claiming it completed.
describe("shouldPersistSnapshot — a failed read must not be persisted as holdings", () => {
  it("REFUSES a partial walk, even though it has rows", () => {
    const r = shouldPersistSnapshot({ err: "wmc load page 4: statement timeout", rows: new Array(1000).fill(0) })
    expect(r.persist).toBe(false)
    expect(r.reason).toBe("incomplete_load")
  })

  it("calls an errored EMPTY walk incomplete, NOT an empty wallet", () => {
    // ⚠ The two are different facts and must not share a reason: "no rows"
    // says the wallet holds nothing, which is a claim this run cannot make.
    const r = shouldPersistSnapshot({ err: "wmc load page 0: statement timeout", rows: [] })
    expect(r.persist).toBe(false)
    expect(r.reason).toBe("incomplete_load")
  })

  it("persists a complete walk", () => {
    expect(shouldPersistSnapshot({ rows: [1, 2, 3] })).toEqual({ persist: true, reason: "complete" })
    expect(shouldPersistSnapshot({ err: null, rows: [1] })).toEqual({ persist: true, reason: "complete" })
  })

  it("does not persist a genuinely empty wallet, and says so distinctly", () => {
    expect(shouldPersistSnapshot({ rows: [] })).toEqual({ persist: false, reason: "no_rows" })
  })

  it("NOT VACUOUS: the real 2026-09-13 shape is refused", () => {
    // 4 pages × 250 rows read, then the fifth page exhausted its retries.
    const real = { err: "wmc load page 4: canceling statement due to statement timeout", rows: new Array(1000).fill(0) }
    expect(shouldPersistSnapshot(real).persist).toBe(false)
    // …and the complete walk from the same wallet the next day is persisted,
    // so the guard is not simply "never write".
    expect(shouldPersistSnapshot({ rows: new Array(52120).fill(0) }).persist).toBe(true)
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

  // The unit tests above pin the DECISION; this pins that the edge function
  // actually asks for it. Without this the guard can be correct and unreachable
  // — which is exactly how the partial snapshot got written in the first place.
  it("gates the snapshot upsert on shouldPersistSnapshot", () => {
    expect(/shouldPersistSnapshot/.test(src), "index.ts must import and call the gate").toBe(true)
    const gateIdx = src.indexOf("shouldPersistSnapshot(load)")
    const upsertIdx = src.indexOf('.from("wallet_holdings_snapshot")')
    expect(gateIdx, "the gate must be called").toBeGreaterThan(-1)
    expect(upsertIdx, "the snapshot upsert must still exist").toBeGreaterThan(-1)
    expect(gateIdx, "the gate must run BEFORE the snapshot upsert").toBeLessThan(upsertIdx)
  })
})
