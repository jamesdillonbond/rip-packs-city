import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"
import { scriptResult } from "./helpers/flow-cdc-fixture"

// Deep-drive of /api/pinnacle-listings-retry — the Pinnacle
// listing_resolution_failures drainer. Pinnacle's twist (pinned here):
// "resolved" means the derived edition_key is KNOWN in EITHER pinnacle_editions
// (where Pinnacle editions actually live — no editions UUID exists, so there is
// nothing to write) OR editions (rare — then the existing cached_listings_v2
// row gets its NULL edition_id backfilled via UPDATE-in-place, never an
// upsert). Also pins:
//   - resolution ladder pinnacle_nft_map -> wallet_moments_cache -> Cadence
//     borrow returning the composite editionKey;
//   - a failed v2 backfill UPDATE re-queues the row (bump) instead of falsely
//     marking it resolved; unknown keys bump; a bump reaching 10 retires;
//   - dual auth (Bearer OR ?token=), empty-queue exit, fatal honesty — every
//     path still writes log_pipeline_run.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

process.env.INGEST_SECRET_TOKEN = "pin-retry-token"

const { POST, GET } = await import("@/app/api/pinnacle-listings-retry/route")

const PIN_COLLECTION = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

function qrow(opts: {
  id: number
  flowId: string
  retry?: number
  reason?: string | null
  seller?: string | null
}) {
  return {
    id: opts.id,
    collection_id: PIN_COLLECTION,
    flow_id: opts.flowId,
    listing_resource_id: `PLR-${opts.id}`,
    retry_count: opts.retry ?? 0,
    failure_reason: opts.reason ?? "nft_map_miss",
    event_payload: {
      blockHeight: 999,
      blockTimestamp: "2026-07-02T00:00:00Z",
      txHash: "cd".repeat(32),
      eventIndex: 0,
      listingResourceID: `PLR-${opts.id}`,
      ...(opts.seller === null ? {} : { storefrontAddress: opts.seller ?? "0xpinseller" }),
      nftID: opts.flowId,
      salePrice: "40.00000000",
      salePaymentVaultType: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
      customID: null,
      expiry: undefined,
    },
  }
}

function scriptsStub(results: Array<{ value: string }>): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("/v1/scripts"),
    respond: () => {
      const r = results[Math.min(call, results.length - 1)]
      call++
      return { json: r ?? scriptResult(null) }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(token: string | null = "pin-retry-token", url = "https://t/api/pinnacle-listings-retry"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: token ? new Headers({ authorization: `Bearer ${token}` }) : undefined,
  })
}

async function runDeferred() {
  for (const cb of state.afterCbs.splice(0)) await cb()
}

function terminalLog(spy: { rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> }) {
  return spy.rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
})

describe("pinnacle-listings-retry — dual-table resolution semantics", () => {
  it("pinnacle_editions-only keys resolve WITHOUT a v2 write; editions-backed keys UPDATE the v2 row's NULL edition_id in place", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      listing_resolution_failures: {
        data: [qrow({ id: 1, flowId: "100" }), qrow({ id: 2, flowId: "200" })],
        error: null,
      },
      // Ladder rung 1: nft map knows flow 100.
      pinnacle_nft_map: { data: [{ nft_id: "100", edition_key: "PIN:Standard:1" }], error: null },
      // Rung 2: wmc knows flow 200.
      wallet_moments_cache: { data: [{ moment_id: "200", edition_key: "ED:Chaser:2" }], error: null },
      // Key 1 lives only in pinnacle_editions (the common case: no UUID exists),
      // key 2 has a real editions row -> UUID backfill.
      pinnacle_editions: { data: [{ edition_key: "PIN:Standard:1" }], error: null },
      editions: { data: [{ id: "uuid-ed2", external_id: "ED:Chaser:2" }], error: null },
      cached_listings_v2: { data: null, error: null },
    })

    const res = await POST(req())
    expect(await res.json()).toEqual({ ok: true, message: "retry queued" })
    await runDeferred()

    // No Cadence spend — both keys came from the DB rungs.
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)

    // Exactly ONE v2 write, and it is an UPDATE (edition_id backfill in place),
    // never an upsert — the indexer already wrote the row.
    const v2Writes = spy.writes.cached_listings_v2 ?? []
    expect(v2Writes).toHaveLength(1)
    expect(v2Writes[0]?.method).toBe("update")
    expect(v2Writes[0]?.rows[0]).toEqual({ edition_id: "uuid-ed2" })

    // BOTH failures resolve (the pinnacle_editions-only hit is still resolved).
    const marks = (spy.writes.listing_resolution_failures ?? []).filter(
      (w) => w.method === "update",
    )
    expect(marks).toHaveLength(1)
    expect(typeof marks[0]?.rows[0]?.resolved_at).toBe("string")

    const log = terminalLog(spy)
    expect(log).toMatchObject({
      p_pipeline: "pinnacle-listings-retry",
      p_rows_found: 2,
      p_rows_written: 1, // only the UUID backfill counts as a write
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: "disney_pinnacle",
    })
    expect(log?.p_extra).toMatchObject({
      resolved: 2,
      still_unresolved: 0,
      retry_count_hit_cap: 0,
      cadence_attempted: 0,
      cadence_resolved: 0,
    })
  })

  it("both DB rungs miss -> the Cadence borrow derives the composite editionKey and a pinnacle_editions hit resolves the failure", async () => {
    fetchMock = installFetchMock([
      scriptsStub([scriptResult({ editionKey: "RC9:Chaser:3", serialNumber: "12" })]),
    ])
    const spy = install({
      listing_resolution_failures: {
        data: [qrow({ id: 3, flowId: "300", seller: "0xpinholder" })],
        error: null,
      },
      pinnacle_nft_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      pinnacle_editions: { data: [{ edition_key: "RC9:Chaser:3" }], error: null },
      editions: { data: [], error: null },
      cached_listings_v2: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const scriptCalls = fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))
    expect(scriptCalls).toHaveLength(1)
    const body = JSON.parse(String(scriptCalls[0]?.init?.body))
    const args = (body.arguments as string[]).map((a) =>
      JSON.parse(Buffer.from(a, "base64").toString("utf8")),
    )
    expect(args).toEqual([
      { type: "Address", value: "0xpinholder" },
      { type: "UInt64", value: "300" },
    ])

    // pinnacle_editions-only -> resolved, no v2 write.
    expect(spy.writes.cached_listings_v2 ?? []).toHaveLength(0)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 0 })
    expect(log?.p_extra).toMatchObject({ resolved: 1, cadence_attempted: 1, cadence_resolved: 1 })
  })
})

describe("pinnacle-listings-retry — re-queue + retirement accounting", () => {
  it("a failed v2 backfill UPDATE re-queues instead of falsely resolving; unknown keys bump; a bump reaching 10 retires", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      listing_resolution_failures: {
        data: [
          qrow({ id: 4, flowId: "400", retry: 0 }), // editions-backed, v2 update will FAIL
          qrow({ id: 5, flowId: "500", retry: 9 }), // key known nowhere -> bump to cap
        ],
        error: null,
      },
      pinnacle_nft_map: {
        data: [
          { nft_id: "400", edition_key: "KC:Standard:1" },
          { nft_id: "500", edition_key: "KD:Standard:1" },
        ],
        error: null,
      },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [{ id: "uuid-kc", external_id: "KC:Standard:1" }], error: null },
      pinnacle_editions: { data: [], error: null },
      cached_listings_v2: { data: null, error: { message: "row locked" } },
    })

    await POST(req())
    await runDeferred()

    // The v2 update was ATTEMPTED but errored -> row 4 must NOT be resolved.
    const failureUpdates = (spy.writes.listing_resolution_failures ?? [])
      .filter((w) => w.method === "update")
      .flatMap((w) => w.rows)
    // Two retry bumps, zero resolved marks.
    expect(failureUpdates).toHaveLength(2)
    expect(failureUpdates.every((r) => !("resolved_at" in r))).toBe(true)
    expect(failureUpdates.map((r) => r.retry_count).sort()).toEqual([1, 10])

    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_rows_found: 2, p_rows_written: 0, p_rows_skipped: 2 })
    expect(log?.p_extra).toMatchObject({
      resolved: 0,
      still_unresolved: 1, // id 4: 0 -> 1
      retry_count_hit_cap: 1, // id 5: 9 -> 10 retires
      cadence_attempted: 0,
    })
  })
})

describe("pinnacle-listings-retry — control flow + auth", () => {
  it("empty queue exits early, logging ok with empty_queue", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({ listing_resolution_failures: { data: [], error: null } })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    expect(log?.p_extra).toMatchObject({ empty_queue: true })
  })

  it("a queue-fetch failure logs ok=false with the honest error", async () => {
    fetchMock = installFetchMock([scriptsStub([])])
    const spy = install({
      listing_resolution_failures: { data: null, error: { message: "timeout" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("queue fetch: timeout")
  })

  it("accepts the ?token= query form, 401s with neither, GET aliases POST", async () => {
    install({ listing_resolution_failures: { data: [], error: null } })

    expect((await POST(req(null))).status).toBe(401)
    expect((await GET(req(null))).status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)

    const res = await POST(
      req(null, "https://t/api/pinnacle-listings-retry?token=pin-retry-token"),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("retry queued")
    expect(state.afterCbs).toHaveLength(1)
  })
})
