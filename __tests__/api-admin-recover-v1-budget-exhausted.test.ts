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
  multiByTx: {} as Record<string, { ok: boolean; reason: string; perNft: Map<string, { priceDuc: number | null; priceCertain: boolean; priceReason: string; buyer: string | null; seller: string | null }> }>,
  multiCalls: [] as string[],
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => (state.sb as Record<PropertyKey, unknown>)[p] }),
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  // Real semantics, inlined: only the Dapper custodian is custodial.
  isCustodialDepositTarget: (a: string) => a.toLowerCase().replace(/^0x/, "") === "ddfbe848a81b2236",
  decodeV1MultiSaleTx: async (tx: string) => {
    state.multiCalls.push(tx)
    return state.multiByTx[tx] ?? { ok: false, reason: "tx_fetch_failed", perNft: new Map() }
  },
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
  state.multiByTx = {}
  state.multiCalls = []
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

// ─────────────────────────────────────────────────────────────────────────────
// The MULTI-NFT pass (2026-09-29). Cart purchases were "unsplittable"; the
// attribution itself is pinned against real txs in
// lib-v1-multi-sale-attribution.test.ts. Pinned here: the WIRING.
describe("recover-v1-budget-exhausted — multi-NFT pass", () => {
  const TX = "0x" + "e".repeat(64)
  const priced = (price: number | null, certain: boolean, reason = "matched") => ({
    priceDuc: price, priceCertain: certain, priceReason: reason, buyer: "0xe4cf4bdc1751c65d", seller: "0x909a0fd879c9891e",
  })

  it("prices each NFT of a cart from ITS segment, strips the marker, writes the seller AND the issuer buyer (#161)", async () => {
    state.multiByTx[TX] = { ok: true, reason: "ok", perNft: new Map([["1", priced(0.67, true)], ["2", priced(0.66, true)]]) }
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null },
      "rpc:claim_allday_v1_multi_price_recovery_candidates": {
        data: [umRow({ id: "m1", nft_id: "1", transaction_hash: TX }), umRow({ id: "m2", nft_id: "2", transaction_hash: TX })],
        error: null,
      },
      "rpc:promote_unmapped_sales": { data: { promoted: 2 }, error: null },
    })
    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(state.multiCalls).toEqual([TX]) // ONE decode for the whole cart
    expect(body).toMatchObject({ ok: true, multi_txs: 1, multi_rows_priced: 2, multi_rows_uncertain: 0, updated_unmapped: 2 })
    const ups = (spy.writes.unmapped_sales ?? []).filter((w) => w.method === "update").map((w) => w.rows[0])
    expect(ups.map((u) => u.price_usd)).toEqual([0.67, 0.66])
    for (const u of ups) {
      expect(u.seller_address).toBe("0x909a0fd879c9891e")
      // INVERTED 2026-09-30: the AllDay issuer is a buyback cart's final holder,
      // not a custodian (#161) — a NULL buyer would make the buyback untrackable.
      expect(u.buyer_address).toBe("0xe4cf4bdc1751c65d")
      expect(u.resolution_hint).toEqual({ backfill: "allday_v1_history", price_source: "v1_multi_nft_segment" })
    }
  })

  it("⛔ an uncertain NFT keeps its marker and is STAMPED so the claim moves past it", async () => {
    state.multiByTx[TX] = { ok: true, reason: "ok", perNft: new Map([["1", priced(0.67, true)], ["2", priced(null, false, "split_sum_mismatch")]]) }
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null },
      "rpc:claim_allday_v1_multi_price_recovery_candidates": {
        data: [umRow({ id: "m1", nft_id: "1", transaction_hash: TX }), umRow({ id: "m2", nft_id: "2", transaction_hash: TX })],
        error: null,
      },
      "rpc:promote_unmapped_sales": { data: { promoted: 1 }, error: null },
    })
    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(body).toMatchObject({ multi_rows_priced: 1, multi_rows_uncertain: 1, multi_fail_reasons: { split_sum_mismatch: 1 } })
    const stamp = (spy.writes.unmapped_sales ?? []).filter((w) => w.method === "update").map((w) => w.rows[0]).find((u) => !("price_usd" in u))!
    const hint = stamp.resolution_hint as Record<string, unknown>
    expect(hint.price_extraction).toBe("v1_tx_decode_budget_exhausted") // still recoverable later
    expect(hint.multi_price_reason).toBe("split_sum_mismatch")
    expect(typeof hint.multi_price_attempted_at).toBe("string")
  })

  it("stamps every row of a tx that failed to decode at all, and of an NFT the tx did not purchase", async () => {
    const TX2 = "0x" + "f".repeat(64)
    state.multiByTx[TX] = { ok: false, reason: "tx_fetch_failed", perNft: new Map() }
    state.multiByTx[TX2] = { ok: true, reason: "ok", perNft: new Map([["9", priced(1, true)]]) }
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null },
      "rpc:claim_allday_v1_multi_price_recovery_candidates": {
        data: [
          umRow({ id: "a", nft_id: "1", transaction_hash: TX }),
          umRow({ id: "b", nft_id: "2", transaction_hash: TX }),
          umRow({ id: "c", nft_id: "7", transaction_hash: TX2 }),
        ],
        error: null,
      },
      "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null },
    })
    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(body.multi_fail_reasons).toEqual({ tx_fetch_failed: 2, nft_not_purchased_in_tx: 1 })
    expect(body.multi_rows_priced).toBe(0)
    const stamps = (spy.writes.unmapped_sales ?? []).filter((w) => w.method === "update")
    expect(stamps).toHaveLength(3)
  })

  it("⛔ a failed multi claim fails the run but keeps the singleton pass's work", async () => {
    const tx = "0x" + "a".repeat(64)
    state.decodeByTx[tx] = { priceCertain: true, priceDuc: 3, priceReason: "matched" }
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [umRow()], error: null },
      "rpc:claim_allday_v1_multi_price_recovery_candidates": { data: null, error: { message: "statement timeout" } },
      "rpc:promote_unmapped_sales": { data: { promoted: 1 }, error: null },
    })
    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(body.updated_unmapped).toBe(1)
    expect(body.multi_fatal).toMatch(/statement timeout/)
    expect(log(spy.rpcCalls)).toMatchObject({ p_ok: false })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #160 (d), 2026-09-30: "both claims returned nothing" must not read as "the
// backlog is drained" when it is not. On 09-28 duplicate rows made the singleton
// claim return 0 for days and every run logged ok. Three states, never two:
// stalled (eligible rows exist) · drained (count 0) · unknown (count read failed).
describe("recover-v1-budget-exhausted — empty claims vs an eligible backlog", () => {
  const empty = {
    "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null },
    "rpc:claim_allday_v1_multi_price_recovery_candidates": { data: [], error: null },
    "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null },
  }

  it("⛔ fails the RUN when both claims are empty but eligible rows wait — yet keeps HTTP 200 for the scheduler", async () => {
    const spy = install({ ...empty, unmapped_sales: { data: null, error: null, count: 5 } })
    const res = await POST(req("Bearer ingest-token"))
    // 200, not 500: cron-job.org auto-disables an entry after repeated failures,
    // which would switch off the recovery lane for reporting that it is stuck.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, stalled: true, eligible_backlog: 5, fatal: "claim_empty_with_backlog:5" })
    expect(log(spy.rpcCalls)).toMatchObject({ p_ok: false, p_error: "claim_empty_with_backlog:5" })
  })

  it("a genuinely drained backlog is a clean ok run with a MEASURED zero", async () => {
    const spy = install({ ...empty, unmapped_sales: { data: null, error: null, count: 0 } })
    const res = await POST(req("Bearer ingest-token"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, eligible_backlog: 0 })
    expect(body.stalled).toBeUndefined()
    expect(log(spy.rpcCalls)).toMatchObject({ p_ok: true })
  })

  it("a FAILED count read is unknown (null), not a stall and not a zero", async () => {
    const spy = install({ ...empty, unmapped_sales: { data: null, error: { message: "statement timeout" }, count: null } })
    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(body.ok).toBe(true)
    expect(body.eligible_backlog).toBeNull()
    expect(body.eligible_backlog_error).toMatch(/statement timeout/)
    expect(body.stalled).toBeUndefined()
    expect(log(spy.rpcCalls)).toMatchObject({ p_ok: true })
  })

  it("does not run the backlog check when a claim returned work", async () => {
    const tx = "0x" + "a".repeat(64)
    state.decodeByTx[tx] = { priceCertain: true, priceDuc: 2, priceReason: "matched" }
    install({ ...empty, "rpc:claim_allday_v1_price_recovery_candidates": { data: [umRow()], error: null }, unmapped_sales: { data: null, error: null, count: 99 } })
    const body = await (await POST(req("Bearer ingest-token"))).json()
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty("eligible_backlog")
  })
})

describe("recover-v1-budget-exhausted — buyer attribution in multi carts (#161)", () => {
  const TX = "0x" + "b".repeat(64)
  it("⛔ never writes a CUSTODIAL deposit target as the buyer", async () => {
    state.multiByTx[TX] = {
      ok: true,
      reason: "ok",
      perNft: new Map([["1", { priceDuc: 2, priceCertain: true, priceReason: "matched", buyer: "0xddfbe848a81b2236", seller: "0x01" }]]),
    }
    const spy = install({
      "rpc:claim_allday_v1_price_recovery_candidates": { data: [], error: null },
      "rpc:claim_allday_v1_multi_price_recovery_candidates": { data: [umRow({ id: "x1", nft_id: "1", transaction_hash: TX })], error: null },
      "rpc:promote_unmapped_sales": { data: { promoted: 0 }, error: null },
    })
    await POST(req("Bearer ingest-token"))
    const up = (spy.writes.unmapped_sales ?? []).find((w) => w.method === "update")!.rows[0]
    expect(up.price_usd).toBe(2)
    expect(up).not.toHaveProperty("buyer_address")
  })

  it("the stall count covers BOTH markers the multi claim takes", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("app/api/admin/recover-v1-budget-exhausted/route.ts", "utf8")
    const countCall = src.slice(src.indexOf("claim_empty_with_backlog") - 1500, src.indexOf("claim_empty_with_backlog"))
    expect(countCall).toContain("v1_tx_decode_budget_exhausted")
    expect(countCall).toContain("v1_tx_decode_multi_nft_unsplittable")
  })
})
