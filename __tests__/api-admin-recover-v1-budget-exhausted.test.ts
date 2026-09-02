import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Route integration test for /api/admin/recover-v1-budget-exhausted, rewritten
// 2026-07-25 from a fire-and-forget after() one-shot into a SYNCHRONOUS,
// self-budgeted, dual-auth standing drainer (pipeline=allday-price-recover).
// Stubs the Flow decode seam (decodeV1SaleTx) + the Supabase client. Pins:
//   - fail-closed 401; dual-auth (INGEST + CRON) on both POST and GET;
//   - unmapped price patch + marker strip when the row is still open;
//   - in-place sales price fix when the row already promoted at price 0;
//   - multi-NFT tx skip (unsplittable gross);
//   - uncertain decode left untouched; promote invoked; honest counters.
//
// ⚠ UPDATED 2026-09-02: candidates now arrive from the RPC
// `claim_allday_v1_price_recovery_candidates`, not from a raw `unmapped_sales`
// select. The old read had no ORDER BY, so it took physical order — the same
// page every tick — and discarded 999 of 1,000 rows as multi-NFT while 9,859
// singleton-tx rows sat unreachable behind it. The claim applies the
// singleton test in SQL.
//
// ⭐ THE MULTI-NFT CASE BELOW IS KEPT AND IS NOT DEAD. The RPC's answer is a
// snapshot; a second row for the same tx can be inserted between the claim and
// the decode, so the route's own group-size skip is the backstop. Deleting the
// test because "the query prevents it now" would remove the only thing pinning
// that backstop.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  decodeByTx: {} as Record<string, { priceCertain: boolean; priceDuc: number | null; priceReason: string }>,
  decodeCalls: [] as string[],
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => (state.sb as Record<PropertyKey, unknown>)[p] }),
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string) => {
    state.decodeCalls.push(tx)
    const d = state.decodeByTx[tx] ?? { priceCertain: false, priceDuc: null, priceReason: "tx_fetch_failed" }
    return { buyer: null, seller: null, sampleAmounts: [], ...d }
  },
}))

process.env.INGEST_SECRET_TOKEN = "ingest-token"
process.env.CRON_SECRET = "cron-token"

const { POST, GET } = await import("@/app/api/admin/recover-v1-budget-exhausted/route")

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
function req(auth: string | null, method: "POST" | "GET" = "POST"): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/recover-v1-budget-exhausted", { method, headers })
}
function umRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "u1",
    nft_id: "606",
    transaction_hash: "0x" + "a".repeat(64),
    resolved_at: null,
    resolution_hint: { backfill: "allday_v1_history", price_extraction: "v1_tx_decode_budget_exhausted", sample_duc_amounts: [] },
    ...over,
  }
}
function log(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "allday-price-recover").at(-1)?.args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-token"
  process.env.CRON_SECRET = "cron-token"
  state.decodeByTx = {}
  state.decodeCalls = []
})

describe("recover-v1-budget-exhausted — auth", () => {
  it("401s on a wrong token", async () => {
    install({})
    expect((await POST(req("Bearer nope"))).status).toBe(401)
  })
  it("accepts the INGEST token on POST and the CRON token on GET", async () => {
    install({ "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null }, "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null } })
    expect((await POST(req("Bearer ingest-token"))).status).toBe(200)
    install({ "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null }, "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null } })
    expect((await GET(req("Bearer cron-token", "GET"))).status).toBe(200)
  })
})

describe("recover-v1-budget-exhausted — recovery", () => {
  it("recovers price on an open row, strips the marker, and promotes", async () => {
    const tx = "0x" + "a".repeat(64)
    state.decodeByTx[tx] = { priceCertain: true, priceDuc: 14.25, priceReason: "matched" }
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [umRow()], error: null },
      "rpc:promote_unmapped_sales": { data: { promoted: 1, still_unresolved: 9 }, error: null },
    })

    const res = await POST(req("Bearer ingest-token"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.updated_unmapped).toBe(1)
    expect(body.promoted).toBe(1)

    // The unmapped update stripped the price marker but kept the backfill tag.
    const upd = (spy.writes.unmapped_sales ?? []).find((w) => w.method === "update")
    expect(upd?.rows[0]).toMatchObject({ price_usd: 14.25, price_native: 14.25 })
    expect((upd?.rows[0].resolution_hint as Record<string, unknown>)).toEqual({ backfill: "allday_v1_history" })

    expect(state.decodeCalls).toEqual([tx])
    expect(log(spy.rpcCalls)).toMatchObject({ p_ok: true, p_pipeline: "allday-price-recover", p_collection_slug: "nfl_all_day" })
  })

  it("fixes an already-promoted price-0 sale in place (resolved row)", async () => {
    const tx = "0x" + "c".repeat(64)
    state.decodeByTx[tx] = { priceCertain: true, priceDuc: 8, priceReason: "matched_no_splits" }
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [umRow({ id: "u2", transaction_hash: tx, resolved_at: new Date().toISOString() })], error: null },
      sales: { data: [{ id: "s1" }], error: null },
      "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null },
    })

    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(body.updated_sales).toBe(1)
    expect(body.updated_unmapped).toBe(0)
    const upd = (spy.writes.sales ?? []).find((w) => w.method === "update")
    expect(upd?.rows[0]).toMatchObject({ price_usd: 8, price_native: 8 })
  })

  it("claims through the singleton-tx RPC with a bounded limit, not a raw unordered read", async () => {
    // The defect this replaced was a `.from("unmapped_sales").select(...)` with no
    // ORDER BY and a limit of 2000 that PostgREST clamped to 1000 — so the route
    // re-read one physical page forever and decoded one row per tick. Two things
    // are pinned: the claim goes through the RPC, and the limit it asks for is
    // one it can actually be given.
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null },
      "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null },
    })
    await POST(req("Bearer ingest-token"))

    const claim = spy.rpcCalls.find((c) => c.name === "claim_allday_v1_price_recovery_candidates")
    expect(claim, "candidates must come from the singleton-tx claim, not a raw table read").toBeTruthy()
    const limit = (claim!.args as Record<string, number>).p_limit
    expect(limit).toBeGreaterThan(0)
    // Above 1000 the value is silently clamped, which is how the old constant
    // (2000) came to mean 1000 without anyone noticing.
    expect(limit).toBeLessThanOrEqual(1000)
  })

  it("skips a multi-NFT tx (unsplittable gross) and leaves an uncertain decode alone", async () => {
    const multiTx = "0x" + "d".repeat(64)
    const soloTx = "0x" + "e".repeat(64)
    state.decodeByTx[soloTx] = { priceCertain: false, priceDuc: null, priceReason: "split_sum_mismatch" }
    const spy = install({
      // Two rows on ONE tx, as they would arrive if a sibling row landed between
      // the claim and the decode — the case the route's own skip still covers.
      "rpc:claim_allday_v1_price_recovery_candidates": {
        data: [
          umRow({ id: "m1", transaction_hash: multiTx, nft_id: "1" }),
          umRow({ id: "m2", transaction_hash: multiTx, nft_id: "2" }),
          umRow({ id: "s3", transaction_hash: soloTx, nft_id: "3" }),
        ],
        error: null,
      },
      "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null },
    })

    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(body.skipped_multi_nft_rows).toBe(2)
    expect(body.updated_unmapped).toBe(0)
    expect(body.still_uncertain).toBe(1)
    // Only the solo tx was decoded (the multi-nft group never called decode).
    expect(state.decodeCalls).toEqual([soloTx])
    expect((log(spy.rpcCalls)?.p_extra as Record<string, unknown>).fail_reasons).toMatchObject({
      multi_nft_tx_total_unsplittable: 2,
      split_sum_mismatch: 1,
    })
  })
})
