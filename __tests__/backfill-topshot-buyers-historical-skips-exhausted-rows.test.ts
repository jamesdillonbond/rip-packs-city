import { describe, it, expect, beforeEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// ⚠ WHY THIS EXISTS (2026-09-02). `topshot-buyer-backfill-historical` ran a
// TREADMILL for days and every instrument called it healthy.
//
// Measured in production: 47 runs/day, `rows_found` **45 on every single run**,
// `buyers_resolved` 0 on every run, and `decode_404`, `decode_failed` and
// `decode_other_status` ALL ZERO — so nothing was failing. The window held exactly
// 45 null-buyer rows, and all 45 already carried a payer AND a proposer: every one
// had already been decoded successfully by this lane, which found exec accounts and
// no buyer. A buyer-less row keeps `buyer_address IS NULL`, so it was re-selected
// next run, re-decoded through the spork proxy, and re-UPDATEd with the identical
// payer/proposer — 2,115 proxy decodes and 2,115 no-op row versions a day on a
// partitioned `sales`, forever, logging `ok: true` with `rows_written: 0`, which
// reads exactly like "nothing to do".
//
// THE PROPERTY PINNED HERE, and it is asserted as BEHAVIOUR rather than as the
// presence of a predicate: given a queue that mixes never-attempted rows with
// already-exhausted ones, the lane must attempt ONLY the never-attempted rows —
// and must REPORT how many it excluded, because a predicate that silently shrinks
// a population makes "nothing left to do" and "we stopped looking" the same
// reading. That is the defect one level up from the one being fixed.
//
// The mock below therefore APPLIES the filters instead of ignoring them; a builder
// that returns a fixed array no matter what it is asked would pass this file with
// the predicate deleted.

const TOKEN = "topshot-buyers-ingest"

type Row = {
  id: number
  collection: string
  nft_id: string
  transaction_hash: string
  sold_at: string
  seller_address: string | null
  buyer_address: string | null
  payer_address: string | null
}

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sales: [] as any[],
  countErr: false,
  runs: [] as any[],
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})

vi.mock("@/lib/supabase", () => {
  // A builder that actually FILTERS. Only the operators this route uses are
  // implemented, and an unknown one throws rather than being ignored — a silent
  // no-op filter is how a mock ends up proving nothing.
  function salesQuery(head: boolean) {
    let rows = [...state.sales]
    const b: any = {
      eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return b },
      is(col: string, val: unknown) {
        if (val !== null) throw new Error(`unsupported is(${col}, ${String(val)})`)
        rows = rows.filter((r) => r[col] === null || r[col] === undefined)
        return b
      },
      not(col: string, op: string, val: unknown) {
        if (op !== "is" || val !== null) throw new Error(`unsupported not(${col}, ${op})`)
        rows = rows.filter((r) => r[col] !== null && r[col] !== undefined)
        return b
      },
      gte(col: string, val: string) { rows = rows.filter((r) => String(r[col]) >= val); return b },
      lt(col: string, val: string) { rows = rows.filter((r) => String(r[col]) < val); return b },
      order() { return b },
      limit(n: number) { rows = rows.slice(0, n); return b },
      then(resolve: any) {
        if (head && state.countErr) return resolve({ data: null, count: null, error: { message: "count blew up" } })
        return resolve(head ? { data: null, count: rows.length, error: null } : { data: rows, error: null })
      },
    }
    return b
  }

  return {
    supabaseAdmin: {
      rpc: async () => ({ data: null, error: null }),
      from(table: string) {
        return {
          select: (_cols?: string, opts?: { head?: boolean }) =>
            table === "pipeline_runs"
              ? { eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }
              : salesQuery(!!opts?.head),
          update: () => ({ eq: () => ({ is: () => ({ then: (r: any) => r({ error: null }) }) }) }),
          insert: (row: any) => { state.runs.push(row); return { then: (r: any) => r({ error: null }) } },
        } as any
      },
    },
  }
})

let POST: (req: any) => Promise<Response>

beforeEach(async () => {
  vi.resetModules()
  process.env.INGEST_SECRET_TOKEN = TOKEN
  process.env.TS_HISTORICAL_BUYER_BACKFILL_ENABLED = "1"
  process.env.SPORK_PROXY_URL = "https://spork.example/tx"
  process.env.SPORK_PROXY_SECRET = "s3cret"
  state.afterCbs.length = 0
  state.runs.length = 0
  state.sales = []
  state.countErr = false
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
  const mod = await import("@/app/api/admin/backfill-topshot-buyers/route")
  POST = mod.POST as any
})

// Inside the historical window [2023-11-08T16:07:03Z, 2025-01-01).
function row(id: number, payer: string | null): Row {
  return {
    id,
    collection: "nba_top_shot",
    nft_id: String(1000 + id),
    transaction_hash: "a".repeat(64),
    sold_at: "2024-05-01T00:00:00.000Z",
    seller_address: null,
    buyer_address: null,
    payer_address: payer,
  }
}

async function runHistorical(): Promise<any> {
  const res = await POST(adminReq(
    "https://t/api/admin/backfill-topshot-buyers?mode=historical",
    { authorization: `Bearer ${TOKEN}` },
  ))
  expect(res.status).toBe(200)
  for (const cb of [...state.afterCbs]) await cb()
  const run = state.runs.find((r) => r.pipeline === "topshot-buyer-backfill-historical")
  expect(run, "historical lane logged no pipeline_runs row").toBeTruthy()
  return run
}

describe("topshot-buyer-backfill-historical does not re-decode rows it has already exhausted", () => {
  it("claims ONLY the never-attempted row and reports the two it skipped", async () => {
    // 1 never attempted (payer null) + 2 already decoded to exec accounts only.
    state.sales = [row(1, null), row(2, "0xpayer2"), row(3, "0xpayer3")]
    const run = await runHistorical()

    // The production shape was rows_found === 3 forever. One is the fix.
    expect(run.rows_found, "an exhausted row must not be claimed again").toBe(1)
    expect(run.extra.exhausted_in_window, "the excluded rows must be visible, not merely absent").toBe(2)
  })

  it("CONTROL — when nothing is exhausted the lane still claims everything", async () => {
    // Without this, a predicate that excluded EVERY row would pass the test above.
    state.sales = [row(1, null), row(2, null), row(3, null)]
    const run = await runHistorical()
    expect(run.rows_found).toBe(3)
    expect(run.extra.exhausted_in_window).toBe(0)
  })

  it("CONTROL — an empty window reports zero exhausted, not a missing key", async () => {
    state.sales = []
    const run = await runHistorical()
    expect(run.rows_found).toBe(0)
    // Present-and-zero. An absent key cannot answer "is anything parked here?".
    expect(Object.keys(run.extra)).toContain("exhausted_in_window")
    expect(run.extra.exhausted_in_window).toBe(0)
  })

  it("a FAILED count reports -1, never 0 — a failed read must not render as a measurement", async () => {
    state.sales = [row(1, null), row(2, "0xpayer2")]
    state.countErr = true
    const run = await runHistorical()
    expect(run.rows_found).toBe(1)
    // 0 here would claim "nothing is parked" when the truth is "we could not look".
    expect(run.extra.exhausted_in_window).toBe(-1)
  })
})
