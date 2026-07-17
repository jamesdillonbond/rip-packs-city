import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep-drive of /api/ingest/backfill (handleBackfill) — the year-windowed TopShot
// sales backfill. Shallow suite pins auth/year-guard/empty. Here we drive the real
// resolve+insert body and assert:
//   - the WRITE contract: a resolvable tx becomes a sales row keyed on the int-pair
//     edition uuid with collection_id/collection/marketplace/currency stamped;
//   - an unresolved edition key is counted editions_missing (never inserted);
//   - the 23505 batch error falls back to per-row inserts -> rows_skipped;
//   - a non-duplicate batch error skips the whole batch;
//   - the offset>0/no-cursor skip-ahead branch still lands the final page.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  gql: (() => ({})) as () => unknown,
}))

vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => state.gql() }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

const { GET, POST } = await import("@/app/api/ingest/backfill/route")

const NBA = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function tx(o: { txHash?: string; price?: number; setID?: string; playID?: string } = {}) {
  return {
    id: "tx1",
    price: o.price ?? 12,
    updatedAt: "2026-06-01T10:00:00Z",
    txHash: o.txHash ?? "0x" + "a".repeat(64),
    moment: {
      id: "m1",
      flowId: "555",
      flowSerialNumber: "9",
      set: { id: "set-uuid" },
      setPlay: { ID: "sp1" },
      parallelSetPlay: { setID: o.setID ?? "3", playID: o.playID ?? "45" },
      play: { id: "play-uuid" },
    },
  }
}
function feed(txs: unknown[], rightCursor: string | null = "c2") {
  return {
    searchMarketplaceTransactions: {
      data: { searchSummary: { pagination: { rightCursor }, data: [{ size: txs.length, data: txs }] } },
    },
  }
}
function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
function r(url: string, method = "GET") {
  return makeReq({ url, method }) as never
}

beforeEach(() => {
  delete process.env.INGEST_SECRET_TOKEN // bypass auth — the resolve/insert body is the target
  state.gql = () => feed([tx()])
})

describe("ingest/backfill — resolve + insert body", () => {
  it("inserts a resolvable tx as a sales row with the full column contract", async () => {
    const spy = install({
      editions: { data: [{ id: "ed-1", external_id: "3:45" }], error: null },
      sales: { data: [{ id: "s1" }], error: null },
    })

    const res = await POST(r("https://t/api/ingest/backfill?year=2025", "POST"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      year: 2025,
      rows_inserted: 1,
      rows_skipped: 0,
      editions_missing: 0,
      hasMore: true,
    })

    const row = (spy.writes.sales ?? []).flatMap((w) => w.rows)[0]
    expect(row).toMatchObject({
      edition_id: "ed-1",
      collection_id: NBA,
      collection: "nba_top_shot",
      serial_number: 9,
      price_usd: 12,
      currency: "USD",
      marketplace: "topshot",
      transaction_hash: "0x" + "a".repeat(64),
      sold_at: "2026-06-01T10:00:00Z",
      nft_id: "555",
    })
  })

  it("counts an unresolved edition key as editions_missing and inserts nothing", async () => {
    const spy = install({
      editions: { data: [], error: null }, // key "3:45" not present
      sales: { data: [], error: null },
    })

    const res = await GET(r("https://t/api/ingest/backfill?year=2025"))
    const body = await res.json()
    expect(body).toMatchObject({ rows_inserted: 0, editions_missing: 1 })
    expect(spy.writes.sales ?? []).toHaveLength(0)
  })

  it("falls back to per-row inserts on a 23505 batch error -> rows_skipped", async () => {
    install({
      editions: { data: [{ id: "ed-1", external_id: "3:45" }], error: null },
      // 1st await = batch insert (dup), 2nd await = the per-row retry (dup)
      sales: [
        { data: null, error: { code: "23505" } },
        { data: null, error: { code: "23505" } },
      ],
    })

    const res = await GET(r("https://t/api/ingest/backfill?year=2025"))
    const body = await res.json()
    expect(body.rows_inserted).toBe(0)
    expect(body.rows_skipped).toBe(1)
  })

  it("skips the whole batch on a non-duplicate insert error", async () => {
    install({
      editions: { data: [{ id: "ed-1", external_id: "3:45" }], error: null },
      sales: { data: null, error: { code: "500", message: "constraint x" } },
    })

    const res = await GET(r("https://t/api/ingest/backfill?year=2025"))
    const body = await res.json()
    expect(body.rows_inserted).toBe(0)
    expect(body.rows_skipped).toBe(1) // batch.length
  })

  it("exercises the offset>0 skip-ahead branch and still lands the final page", async () => {
    const spy = install({
      editions: { data: [{ id: "ed-1", external_id: "3:45" }], error: null },
      sales: { data: [{ id: "s1" }], error: null },
    })

    const res = await GET(r("https://t/api/ingest/backfill?year=2025&limit=500&offset=500"))
    const body = await res.json()
    expect(body.offset).toBe(500)
    expect(body.rows_inserted).toBe(1)
    expect((spy.writes.sales ?? []).flatMap((w) => w.rows)[0]).toMatchObject({ edition_id: "ed-1" })
  })
})
