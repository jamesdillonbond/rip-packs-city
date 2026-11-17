import { describe, it, expect, beforeEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// ⚠ WHY THIS EXISTS (2026-08-29). `topshot-buyer-backfill-historical` ran 36 times
// in a day at `decode_failed` == `rows_found` == 100%, wrote zero rows, and logged
// `ok: true` every time — and NOTHING in the row could say WHY. The spork decode
// collapsed three outcomes that need opposite responses into one silent
// `{ ok: false }`: a 404 (the transaction predates mainnet19 — permanent, stop
// asking), a 401/403 (our `SPORK_PROXY_SECRET` is wrong), and a 5xx (the proxy is
// down). The route's own comment named all three and then counted them identically.
//
// The era-floor reading was only establishable from OUTSIDE the system, by noticing
// the failure rate tracked the cursor's DATE (0% above 2023-11-17, 29.8% across
// 11-08→11-17, 100% below 11-08) rather than wall-clock — an auth failure would
// have flipped at a TIME and looked identical in every logged field.
//
// THE PROPERTY PINNED HERE IS THE DISCRIMINATION, in both directions:
//   • all-404  → the floor. Expected, permanent, NOT a failure → stays ok, flagged.
//   • all-5xx  → ours. Indistinguishable before this fix → must be ok:false + named.
// A fix that simply reddened every zero-row run would pass the second test and fail
// the first, which is why the floor case is asserted as a control rather than
// assumed.

const TOKEN = "topshot-buyers-ingest"

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  rows: [] as any[],
  sporkStatus: 404,
  runs: [] as any[],
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})

vi.mock("@/lib/supabase", () => {
  const sel: any = {
    eq: () => sel, is: () => sel, not: () => sel, lt: () => sel, gte: () => sel,
    order: () => sel, limit: () => sel,
    then: (r: any) => r({ data: state.rows, error: null }),
  }
  return {
    supabaseAdmin: {
      rpc: async () => ({ data: null, error: null }),
      from(table: string) {
        return {
          // ⚠ The cursor read ends in `.maybeSingle()`, not an awaited builder.
          // Omitting it makes the chain throw straight into the route's catch, and
          // the run then logs ok:false with every counter at 0 — which looks exactly
          // like the defect under test. The mock has to match the real chain.
          select: () => (table === "pipeline_runs"
            ? { eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }
            : sel),
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
  state.rows = []
  state.sporkStatus = 404
  // The spork proxy answers with whatever status the test set. A non-OK response
  // is what the decoder turns into `{ ok:false, status }`.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: state.sporkStatus,
    json: async () => ({}),
  })))
  const mod = await import("@/app/api/admin/backfill-topshot-buyers/route")
  POST = mod.POST as any
})

function saleRow(i: number) {
  return {
    id: i, nft_id: String(1000 + i), transaction_hash: "a".repeat(64),
    sold_at: "2023-11-06T04:00:00.000Z", seller_address: null,
  }
}

async function runHistorical(rows: any[], status: number) {
  state.rows = rows
  state.sporkStatus = status
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

describe("topshot-buyer-backfill-historical distinguishes the mainnet19 floor from our own fault", () => {
  it("CONTROL — every lookup 404 is the SPORK FLOOR: stays ok, and says so", async () => {
    const run = await runHistorical([saleRow(1), saleRow(2), saleRow(3)], 404)
    expect(run.ok, "the mainnet19 floor is the expected end of the range, not a failure").toBe(true)
    expect(run.extra.spork_floor).toBe(true)
    expect(run.extra.decode_404).toBe(3)
    expect(run.extra.decode_other_status).toBe(0)
    expect(run.error ?? null).toBeNull()
  })

  it("every lookup failing on a NON-404 is OUR fault: ok=false, and the status is named", async () => {
    const run = await runHistorical([saleRow(1), saleRow(2)], 403)
    expect(run.ok, "a 403 from the spork proxy is a broken credential, not the era floor").toBe(false)
    expect(run.extra.spork_floor, "a 403 must never be reported as the floor").toBe(false)
    expect(run.extra.decode_other_status).toBe(2)
    expect(run.extra.decode_404).toBe(0)
    expect(run.extra.first_bad_status).toBe(403)
    expect(run.error).toContain("403")
    // The message must say it is NOT the floor — that distinction is the whole fix.
    expect(run.error).toMatch(/not the mainnet19 floor/i)
  })

  it("a 5xx is treated the same as a 403 — ours, not the floor", async () => {
    const run = await runHistorical([saleRow(1)], 503)
    expect(run.ok).toBe(false)
    expect(run.extra.spork_floor).toBe(false)
    expect(run.extra.first_bad_status).toBe(503)
  })

  it("CONTROL — an EMPTY queue stays ok and is not flagged as the floor", async () => {
    const run = await runHistorical([], 404)
    expect(run.ok).toBe(true)
    expect(run.extra.spork_floor, "nothing attempted is not a floor").toBe(false)
    expect(run.extra.decode_404).toBe(0)
  })
})
