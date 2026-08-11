import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep-drive of POST /api/fmv-backfill. The shallow suite stops at auth +
// the empty-candidate 200. Here we drive the real compute+write body:
//   - the anti-join candidate RPC -> per-chunk sales read -> WAP/median compute
//     -> fmv_snapshots INSERT contract (the WHAT-does-it-write of this batch tool);
//   - the ULTIMATE carve-out (recalc_ultimate_fmv owns those rows -> skipped, no write);
//   - the all-time fallback when the 30d window is empty;
//   - hasMore/remaining reporting semantics (null when the batch filled);
//   - the candidate-RPC error -> honest 500.
// The HIGH/MEDIUM/LOW math lives in lib/fmv-confidence (96% covered) — we assert
// the route's ORCHESTRATION + the exact snapshot row it persists, not the lib.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

const { POST, GET } = await import("@/app/api/fmv-backfill/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function req(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/fmv-backfill", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      authorization: "Bearer ingest-secret",
    }),
    body: JSON.stringify(body),
  })
}

// Five sales, all ~1h ago (all weight 3.0), prices [10,10,10,10,100]:
//   WAP = 28, floor = 10, trimmedMedian = 10, fmv = WAP = 28.
function fiveSales() {
  const soldAt = new Date(Date.now() - 3600_000).toISOString()
  return [10, 10, 10, 10, 100].map((price, i) => ({
    edition_id: "ed-A",
    collection_id: TOPSHOT,
    price_usd: price,
    sold_at: soldAt,
    serial_number: i + 1,
  }))
}

function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

let savedIngest: string | undefined
beforeEach(() => {
  savedIngest = process.env.INGEST_SECRET_TOKEN
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  delete process.env.CRON_SECRET
})
afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("fmv-backfill — compute + write contract", () => {
  it("computes WAP-primary FMV and INSERTs one fmv_snapshots row with the full column contract", async () => {
    const spy = install({
      "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
      sales: { data: fiveSales(), error: null },
      editions: { data: [], error: null }, // no ULTIMATE in the set
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      editionsFound: 1,
      snapshotsInserted: 1,
      hasMore: false,
      remaining: 0,
    })

    // The candidate anti-join RPC was called with the batch cap.
    expect(spy.rpcCalls[0]).toMatchObject({
      name: "fmv_backfill_candidates",
      args: { p_limit: 100 },
    })

    const snap = (spy.writes.fmv_snapshots ?? []).flatMap((w) => w.rows)
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({
      edition_id: "ed-A",
      collection_id: TOPSHOT,
      fmv_usd: 28,
      floor_price_usd: 10,
      asp_usd: 28,
      confidence: "MEDIUM", // 5 sales, volume-floor MEDIUM (no HIGH gate < 7)
      sales_count_7d: 5,
      sales_count_30d: 5,
      days_since_sale: 0,
      algo_version: "1.5.0",
    })
  })

  it("skips ULTIMATE editions (owned by recalc_ultimate_fmv) — no snapshot written", async () => {
    const spy = install({
      "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
      sales: { data: fiveSales(), error: null },
      editions: { data: [{ id: "ed-A", tier: "ULTIMATE" }], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body.editionsFound).toBe(1)
    expect(body.snapshotsInserted).toBe(0)
    expect(spy.writes.fmv_snapshots ?? []).toHaveLength(0)
  })

  it("falls back to all-time sales when the 30d window is empty, then writes", async () => {
    const spy = install({
      "rpc:fmv_backfill_candidates": { data: ["ed-A"], error: null }, // bare-string candidate shape
      // sequence-aware: first read (window) is empty -> second read (all-time) has sales
      sales: [
        { data: [], error: null },
        { data: fiveSales(), error: null },
      ],
      editions: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body.snapshotsInserted).toBe(1)
    const snap = (spy.writes.fmv_snapshots ?? []).flatMap((w) => w.rows)
    expect(snap[0]).toMatchObject({ edition_id: "ed-A", fmv_usd: 28 })
  })

  it("reports hasMore:true + remaining:null when the batch was filled", async () => {
    install({
      "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
      sales: { data: fiveSales(), error: null },
      editions: { data: [], error: null },
    })

    const res = await POST(req({ batchSize: 1 })) // editionIds.length (1) >= batchSize (1)
    const body = await res.json()
    expect(body.hasMore).toBe(true)
    expect(body.remaining).toBeNull()
    expect(body.snapshotsInserted).toBe(1)
  })

  it("500s honestly when the candidate anti-join RPC errors", async () => {
    install({
      "rpc:fmv_backfill_candidates": { data: null, error: { message: "antijoin boom" } },
    })
    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("antijoin boom")
  })
})

describe("fmv-backfill — auth + config guards", () => {
  it("500s misconfigured when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain("INGEST_SECRET_TOKEN not set")
  })

  it("401s on a wrong bearer token", async () => {
    const bad = new NextRequest("https://t/api/fmv-backfill", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        authorization: "Bearer nope",
      }),
      body: JSON.stringify({}),
    })
    const res = await POST(bad)
    expect(res.status).toBe(401)
  })

  it("authorizes via CRON_SECRET as well", async () => {
    process.env.CRON_SECRET = "cron-x"
    install({ "rpc:fmv_backfill_candidates": { data: [], error: null } })
    const cronReq = new NextRequest("https://t/api/fmv-backfill", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        authorization: "Bearer cron-x",
      }),
      body: JSON.stringify({}),
    })
    const res = await POST(cronReq)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editionsFound).toBe(0)
  })
})

describe("fmv-backfill — batch sizing + candidate shaping", () => {
  it("clamps batchSize to the 500 cap and passes it to the candidate RPC", async () => {
    const spy = install({
      "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
      sales: { data: fiveSales(), error: null },
      editions: { data: [], error: null },
    })
    await POST(req({ batchSize: 999 }))
    expect(spy.rpcCalls[0]).toMatchObject({ name: "fmv_backfill_candidates", args: { p_limit: 500 } })
  })

  it("defaults batchSize to 100 when the request body is invalid JSON", async () => {
    const spy = install({
      "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
      sales: { data: fiveSales(), error: null },
      editions: { data: [], error: null },
    })
    const badBody = new NextRequest("https://t/api/fmv-backfill", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        authorization: "Bearer ingest-secret",
      }),
      body: "{not valid json",
    })
    const res = await POST(badBody)
    expect(res.status).toBe(200)
    expect(spy.rpcCalls[0].args).toMatchObject({ p_limit: 100 })
  })

  it("returns editionsFound:0 / remaining:0 when there are no candidates", async () => {
    install({ "rpc:fmv_backfill_candidates": { data: [], error: null } })
    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, editionsFound: 0, snapshotsInserted: 0, remaining: 0 })
    expect(typeof body.durationMs).toBe("number")
  })

  it("filters null/garbage candidate entries and handles mixed row shapes", async () => {
    const spy = install({
      // object, null-id object, bare string, and a null entry
      "rpc:fmv_backfill_candidates": {
        data: [{ ed_id: "ed-A" }, { ed_id: null }, "ed-B", null],
        error: null,
      },
      // only ed-A has sales -> ed-B produces no snapshot, but both count as found
      sales: { data: fiveSales(), error: null },
      editions: { data: [], error: null },
    })
    const res = await POST(req())
    const body = await res.json()
    expect(body.editionsFound).toBe(2) // ed-A + ed-B, nulls dropped
    expect(body.snapshotsInserted).toBe(1) // only ed-A had sales
    expect(spy.rpcCalls[0].args).toMatchObject({ p_limit: 100 })
  })
})

describe("fmv-backfill — empty sales + insert error paths", () => {
  it("writes nothing when both the window and all-time sales reads are empty", async () => {
    const spy = install({
      "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
      sales: [
        { data: [], error: null }, // 30d window empty
        { data: [], error: null }, // all-time fallback also empty
      ],
      editions: { data: [], error: null },
    })
    const res = await POST(req())
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editionsFound).toBe(1)
    expect(body.snapshotsInserted).toBe(0)
    expect(spy.writes.fmv_snapshots ?? []).toHaveLength(0)
  })

  it("logs but does not count a chunk whose INSERT returns an error", async () => {
    const spy = install({
      "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
      sales: { data: fiveSales(), error: null },
      editions: { data: [], error: null },
      fmv_snapshots: { data: null, error: { message: "insert boom" } },
    })
    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editionsFound).toBe(1)
    expect(body.snapshotsInserted).toBe(0) // insert error -> not counted
    // the insert was still attempted (one recorded write)
    expect((spy.writes.fmv_snapshots ?? []).flatMap((w) => w.rows)).toHaveLength(1)
  })

  it("500s (ok:false) when the fmv_snapshots INSERT throws (fatal catch)", async () => {
    const spy = makeInstrumentedSupabaseFixture(
      {
        "rpc:fmv_backfill_candidates": { data: [{ ed_id: "ed-A" }], error: null },
        sales: { data: fiveSales(), error: null },
        editions: { data: [], error: null },
      },
      { failWrites: ["fmv_snapshots"] },
    )
    state.sb = spy.fixture
    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("forced fmv_snapshots insert failure")
  })
})

describe("fmv-backfill — GET wrapper", () => {
  it("GET delegates to POST", async () => {
    install({ "rpc:fmv_backfill_candidates": { data: [], error: null } })
    const getReq = new NextRequest("https://t/api/fmv-backfill", {
      method: "GET",
      headers: new Headers({ authorization: "Bearer ingest-secret" }),
    })
    const res = await GET(getReq)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, editionsFound: 0 })
  })
})
