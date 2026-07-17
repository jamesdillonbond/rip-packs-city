import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/cron/topshot-flowty-unmapped-drain — the synchronous
// consumer of the topshot_flowty_history unmapped backlog. The shallow test
// covers auth only; these drive the real resolution tiers (wmc -> map ->
// getMintedMoment), and pin the correctness contracts:
//   - a resolved row is promoted into `sales` with the exact write shape and
//     the unmapped row is marked resolved with resolved_sale_id = the sale id;
//   - a getMinted-resolved nft is persisted into nft_edition_map (shrinks
//     future inflow at the source);
//   - only clean HTTP-200 not-founds bump drain_attempts / retire; transient
//     (rate-limit) nulls NEVER touch the row, and 20 consecutive transients
//     bail the loop with rate_limited=true;
//   - sales dedup (23505) still clears the unmapped row (dup_skipped);
//   - the saturation throttle, kill switch, dryRun, and fatal paths.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

// TOKEN is read into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "drain-token"

const { GET, POST } = await import("@/app/api/cron/topshot-flowty-unmapped-drain/route")

const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

type GmSpec =
  | { setFlowId: number; playFlowId: number; serial: number }
  | "not_found"
  | "http_500"
  | "gql_errors"

/** getMintedMoment stub keyed by variables.id, in the route's exact GQL shape. */
function getMintedStub(byId: Record<string, GmSpec>): FetchStub {
  return {
    match: (url) => url.includes("ts-proxy.test"),
    respond: (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { id?: string } }
      const spec = byId[body.variables?.id ?? ""]
      if (spec === "http_500") return { status: 500, json: {} }
      if (spec === "gql_errors") return { json: { errors: [{ message: "rate limited" }] } }
      if (spec === "not_found" || spec === undefined) {
        return { json: { data: { getMintedMoment: { data: null } } } }
      }
      return {
        json: {
          data: {
            getMintedMoment: {
              data: {
                flowSerialNumber: String(spec.serial),
                play: { flowID: String(spec.playFlowId) },
                set: { flowId: spec.setFlowId },
              },
            },
          },
        },
      }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    pipeline_runs: { count: 0, data: null, error: null } as never,
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function uRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "u-1",
    nft_id: "101",
    serial_number: null,
    price_usd: "4.50",
    marketplace: "flowty",
    transaction_hash: "0x" + "a".repeat(64),
    block_height: 123456,
    sold_at: "2026-04-01T00:00:00Z",
    buyer_address: "0x1111111111111111",
    seller_address: "0x2222222222222222",
    source: "onchain",
    resolution_hint: { backfill: "topshot_flowty_history" },
    ...over,
  }
}

function req(qs = "", opts: { auth?: string | null; method?: "GET" | "POST" } = {}): NextRequest {
  const headers = new Headers()
  if (opts.auth !== null) headers.set("authorization", opts.auth ?? "Bearer drain-token")
  return new NextRequest(`https://t/api/cron/topshot-flowty-unmapped-drain${qs}`, {
    method: opts.method ?? "POST",
    headers,
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
  delete process.env.TOPSHOT_FLOWTY_UNMAPPED_DRAIN_DISABLED
  delete process.env.CRON_SECRET
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "drain-token"
  process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
  process.env.TS_PROXY_SECRET = "proxy-secret"
})

describe("topshot-flowty-unmapped-drain — promotion happy path", () => {
  it("resolves via all three tiers, promotes exact sales rows, links resolved_sale_id, persists the getMinted map row", async () => {
    // 101 resolves via wmc, 102 via nft_edition_map, 103 via getMintedMoment.
    fetchMock = installFetchMock([
      getMintedStub({ "103": { setFlowId: 7, playFlowId: 70, serial: 33 } }),
    ])
    const spy = install({
      unmapped_sales: [
        {
          data: [
            uRow({ id: "u-1", nft_id: "101" }),
            uRow({ id: "u-2", nft_id: "102", price_usd: "9.99", serial_number: 44 }),
            uRow({ id: "u-3", nft_id: "103", price_usd: null }),
          ],
          error: null,
        },
        { data: null, error: null }, // resolve updates
      ],
      wallet_moments_cache: {
        data: [{ moment_id: "101", edition_key: "5:50", serial_number: 11 }],
        error: null,
      },
      nft_edition_map: [
        { data: [{ nft_id: "102", edition_external_id: "6:60", serial_number: 22 }], error: null },
        { data: null, error: null }, // upsert of the newly resolved 103
      ],
      editions: {
        data: [
          { id: "ed-a", external_id: "5:50" },
          { id: "ed-b", external_id: "6:60" },
          { id: "ed-c", external_id: "7:70" },
        ],
        error: null,
      },
      sales: { data: null, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, found: 3, promoted: 3, dup_skipped: 0, retired: 0 })

    // Exactly one getMinted call — the two cheap tiers covered 101/102.
    expect(fetchMock.calls).toHaveLength(1)
    const gqlBody = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(gqlBody.variables.id).toBe("103")
    expect((fetchMock.calls[0].init?.headers as Record<string, string>)["X-Proxy-Secret"]).toBe("proxy-secret")

    // Sales rows: handler-computed shape per tier.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(3)
    const byNft = Object.fromEntries(saleRows.map((r) => [r.nft_id, r]))
    expect(byNft["101"]).toMatchObject({
      edition_id: "ed-a",
      collection_id: TS_UUID,
      collection: "nba_top_shot",
      price_usd: 4.5,
      serial_number: 11, // from wmc, not the unmapped row
      marketplace: "flowty",
      source: "onchain",
      block_height: 123456,
      transaction_hash: "0x" + "a".repeat(64),
      buyer_address: "0x1111111111111111",
      seller_address: "0x2222222222222222",
      sold_at: "2026-04-01T00:00:00Z",
    })
    expect(byNft["102"]).toMatchObject({ edition_id: "ed-b", price_usd: 9.99, serial_number: 22 })
    expect(byNft["103"]).toMatchObject({ edition_id: "ed-c", price_usd: 0, serial_number: 33 })

    // The getMinted resolution was persisted for the producer's cheap DB path.
    const mapUpsert = (spy.writes.nft_edition_map ?? []).find((w) => w.method === "upsert")
    expect(mapUpsert?.rows).toEqual([
      { collection_id: TS_UUID, nft_id: "103", edition_external_id: "7:70", serial_number: 33 },
    ])

    // Each unmapped row was marked resolved and linked to ITS inserted sale id.
    const resolveUpdates = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(resolveUpdates).toHaveLength(3)
    const saleIds = new Set(saleRows.map((r) => r.id))
    for (const u of resolveUpdates) {
      expect(typeof u.resolved_at).toBe("string")
      expect(saleIds.has(u.resolved_sale_id as string)).toBe(true)
    }

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 3, p_rows_written: 3, p_rows_skipped: 0 })
    expect(log?.p_extra).toMatchObject({
      candidates: 3,
      get_minted_used: 1,
      editions_resolved: 1,
      transient_nulls: 0,
      rate_limited: false,
      promoted: 3,
      dup_skipped: 0,
      retired: 0,
      bumped: 0,
    })
  })

  it("filters out non-topshot_flowty_history tags and rows at MAX_DRAIN_ATTEMPTS", async () => {
    fetchMock = installFetchMock([getMintedStub({})])
    const spy = install({
      unmapped_sales: {
        data: [
          uRow({ id: "u-1", resolution_hint: { backfill: "some_other_backfill" } }),
          uRow({ id: "u-2", resolution_hint: { backfill: "topshot_flowty_history", drain_attempts: 4 } }),
        ],
        error: null,
      },
    })

    const res = await GET(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, found: 0, note: "no_candidates" })
    expect(fetchMock.calls).toHaveLength(0)
    expect(spy.writes.sales ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect(log?.p_extra).toMatchObject({ note: "no_candidates" })
  })
})

describe("topshot-flowty-unmapped-drain — retirement discipline", () => {
  it("a definitive HTTP-200 not-found bumps drain_attempts below the threshold and retires at it", async () => {
    fetchMock = installFetchMock([getMintedStub({ "201": "not_found", "202": "not_found" })])
    const spy = install({
      unmapped_sales: [
        {
          data: [
            uRow({ id: "u-bump", nft_id: "201" }), // attempts 0 -> bump to 1
            uRow({
              id: "u-retire",
              nft_id: "202",
              resolution_hint: { backfill: "topshot_flowty_history", drain_attempts: 3 },
            }), // attempts 3 -> retire at 4
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, found: 2, promoted: 0, retired: 1 })
    expect(spy.writes.sales ?? []).toHaveLength(0)

    const updates = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(updates).toHaveLength(2)
    // Retires run first: resolved_at stamped + retired hint (left the open backlog, NOT promoted).
    expect(updates[0]).toMatchObject({
      resolution_hint: {
        backfill: "topshot_flowty_history",
        drain_attempts: 4,
        retired: true,
        retire_reason: "getminted_null",
      },
    })
    expect(typeof updates[0].resolved_at).toBe("string")
    // The bump only rewrites the hint — no resolved_at, still open for next tick.
    expect(updates[1]).toEqual({
      resolution_hint: { backfill: "topshot_flowty_history", drain_attempts: 1 },
    })

    expect(terminalLog(spy.rpcCalls)?.p_extra).toMatchObject({ retired: 1, bumped: 1, get_minted_used: 2 })
  })

  it("transient nulls never bump or retire, and 20 consecutive transients bail with rate_limited=true", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => uRow({ id: `u-${i}`, nft_id: `3${String(i).padStart(2, "0")}` }))
    const byId: Record<string, GmSpec> = {}
    for (const r of rows) byId[r.nft_id as string] = "http_500"
    fetchMock = installFetchMock([getMintedStub(byId)])
    const spy = install({
      unmapped_sales: [{ data: rows, error: null }],
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, found: 25, promoted: 0, retired: 0 })

    // Bailed after exactly 20 consecutive transient attempts (not all 25).
    expect(fetchMock.calls).toHaveLength(20)
    // No row was touched — transient throttling must never count toward retirement.
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls)?.p_extra).toMatchObject({
      get_minted_used: 20,
      transient_nulls: 20,
      rate_limited: true,
      retired: 0,
      bumped: 0,
    })
  }, 15_000)
})

describe("topshot-flowty-unmapped-drain — dedup, throttles, and failure paths", () => {
  it("a 23505 duplicate sale still clears the unmapped row (dup_skipped) without counting as written", async () => {
    fetchMock = installFetchMock([getMintedStub({})])
    const dup = { code: "23505", message: "duplicate key value violates unique constraint" }
    const spy = install({
      unmapped_sales: [
        { data: [uRow({ id: "u-dup", nft_id: "401" })], error: null },
        { data: null, error: null },
      ],
      wallet_moments_cache: {
        data: [{ moment_id: "401", edition_key: "8:80", serial_number: 5 }],
        error: null,
      },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "ed-x", external_id: "8:80" }], error: null },
      sales: [
        { data: null, error: dup }, // batch insert
        { data: null, error: dup }, // per-row retry
      ],
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, promoted: 0, dup_skipped: 1, retired: 0 })

    // The already-captured tx is treated as resolved: the unmapped row is cleared.
    const updates = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(updates).toHaveLength(1)
    expect(typeof updates[0].resolved_at).toBe("string")
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_rows_written: 0 })
    expect(terminalLog(spy.rpcCalls)?.p_extra).toMatchObject({ dup_skipped: 1 })
  })

  it("self-throttles when >15 recent non-self pipeline fails", async () => {
    fetchMock = installFetchMock([getMintedStub({})])
    const spy = install({ pipeline_runs: { count: 16, data: null, error: null } as never })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, skipped: "saturation", recent_fails: 16 })
    expect(terminalLog(spy.rpcCalls)?.p_extra).toMatchObject({ skipped: "saturation", recent_fails: 16 })
    expect(spy.writes.sales ?? []).toHaveLength(0)
  })

  it("kill switch env short-circuits with a logged skipped run", async () => {
    process.env.TOPSHOT_FLOWTY_UNMAPPED_DRAIN_DISABLED = "1"
    fetchMock = installFetchMock([getMintedStub({})])
    const spy = install({})

    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "disabled" })
    expect(terminalLog(spy.rpcCalls)?.p_extra).toMatchObject({ skipped: "disabled" })
  })

  it("dryRun previews without writing sales or logging a pipeline run", async () => {
    fetchMock = installFetchMock([getMintedStub({})])
    const spy = install({
      unmapped_sales: [{ data: [uRow({ id: "u-1", nft_id: "101" })], error: null }],
      wallet_moments_cache: {
        data: [{ moment_id: "101", edition_key: "5:50", serial_number: 3 }],
        error: null,
      },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "ed-a", external_id: "5:50" }], error: null },
    })

    const res = await POST(req("?dryRun=true"))
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "dryRun",
      candidates: 1,
      resolvable: 1,
      would_retire: 0,
      attempted_null: 0,
    })
    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    expect(spy.rpcCalls.filter((c) => c.name === "log_pipeline_run")).toHaveLength(0)
  })

  it("a candidate-select failure is fatal: 500 response + ok=false log", async () => {
    fetchMock = installFetchMock([getMintedStub({})])
    const spy = install({
      unmapped_sales: { data: null, error: { message: "permission denied" } },
    })

    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("candidate select: permission denied")
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_ok: false })
  })

  it("401s without a token; accepts CRON_SECRET via ?token=", async () => {
    process.env.CRON_SECRET = "cron-s"
    install({})
    expect((await POST(req("", { auth: null }))).status).toBe(401)
    expect((await POST(req("", { auth: "Bearer wrong" }))).status).toBe(401)
    const res = await POST(req("?token=cron-s", { auth: null }))
    expect(res.status).toBe(200)
  })
})
