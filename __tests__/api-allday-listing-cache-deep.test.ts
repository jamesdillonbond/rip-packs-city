import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"
import { recordDeletes, findFilter } from "./helpers/delete-recorder"

// Deep-drive of /api/allday-listing-cache — the NFL All Day Flowty ->
// cached_listings ingest (dual-sort sweep). POST runs the sweep synchronously
// and returns the computed stats, so most scenarios assert the handler's own
// summary AND its writes. Pins:
//   - dual-sort sweep request contract (listingKind:"sale", salePrice asc+desc),
//     short-page/empty-page break behavior;
//   - row mapping contract (traits->columns, first/last-name fallback, usdValue
//     ask, blended-FMV nulling of 0, ms blockTimestamp -> listed_at ISO,
//     edition_external_id stripped before upsert);
//   - dedup: listing_resource_id across sweeps, then flow_id keep-lowest-ask
//     (onConflict:flow_id would reject dup-key batches);
//   - upsert-then-conditional-purge (.lt cached_at <function-top startedAt>,
//     only when upserted > 0 — a Flowty outage preserves the prior cache);
//   - chained effects: clear_badge_low_ask_stale + fmv_from_cached_listings
//     RPCs, log_pipeline_run accounting on ok / outage / fatal paths.

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

// Both tokens are read at import time (FLOWTY_PROXY_TOKEN throws if unset).
process.env.INGEST_SECRET_TOKEN = "ad-cache-token"
process.env.FLOWTY_PROXY_TOKEN = "flowty-proxy-token"

const { GET, POST } = await import("@/app/api/allday-listing-cache/route")

const AD_COLLECTION = "dee28451-5d62-409e-a1ad-a83f763ac070"
const LISTED_TS_MS = 1789000000000

function adNft(opts: {
  flowId: string
  lrid: string
  ask: number | string
  fmv?: number | string | null
  editionId?: string
  serial?: number
  circ?: number
  playerTrait?: string | null
  firstLast?: [string, string]
  tier?: string
}) {
  const traits: Array<{ name: string; value: unknown }> = [
    { name: "editionID", value: opts.editionId ?? "ED-1" },
    { name: "serialNumber", value: String(opts.serial ?? 7) },
    { name: "editionTier", value: opts.tier ?? "RARE" },
    { name: "setName", value: "Base Set" },
    { name: "seriesName", value: "Series 2" },
    { name: "teamName", value: "Minnesota Vikings" },
  ]
  if (opts.playerTrait !== null) {
    traits.push({ name: "Player Name", value: opts.playerTrait ?? "Justin Jefferson" })
  }
  if (opts.firstLast) {
    traits.push({ name: "playerFirstName", value: opts.firstLast[0] })
    traits.push({ name: "playerLastName", value: opts.firstLast[1] })
  }
  return {
    id: opts.flowId,
    nftView: {
      serial: opts.serial ?? 7,
      traits: { traits },
      editions: { infoList: [{ max: opts.circ ?? 150 }] },
    },
    card: { images: [{ url: "https://img/ad.png" }] },
    orders: [
      {
        state: "LISTED",
        listingResourceID: opts.lrid,
        usdValue: opts.ask,
        valuations: { blended: { usdValue: opts.fmv ?? null } },
        storefrontAddress: "0xsellerAD",
        blockTimestamp: LISTED_TS_MS,
      },
    ],
  }
}

/** flowty-proxy stub keyed on (sort direction, offset); optional hard failure. */
function proxyStub(
  pages: { asc?: Record<number, unknown[]>; desc?: Record<number, unknown[]> },
  opts: { status?: number } = {},
): FetchStub {
  return {
    match: (url) => url.includes("flowty-proxy"),
    respond: (_url, init) => {
      if (opts.status) return { status: opts.status, text: "flowty down" }
      const parsed = JSON.parse(String(init?.body))
      const dir = parsed?.payload?.sort?.direction as "asc" | "desc"
      const offset = parsed?.payload?.offset as number
      return { json: { nfts: pages[dir]?.[offset] ?? [] } }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  const deletes = recordDeletes(spy.fixture)
  state.sb = spy.fixture
  return { ...spy, deletes }
}

function req(method: "GET" | "POST", token: string | null = "ad-cache-token"): NextRequest {
  return new NextRequest("https://t/api/allday-listing-cache", {
    method,
    headers: token ? new Headers({ authorization: `Bearer ${token}` }) : undefined,
  })
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

describe("allday-listing-cache — dual-sort sweep + row contract", () => {
  it("maps Flowty NFTs to the exact row contract, strips edition_external_id pre-upsert, purges stale AFTER upsert, fires badge-stale + FMV RPCs, logs the run", async () => {
    fetchMock = installFetchMock([
      proxyStub({
        asc: {
          0: [
            adNft({ flowId: "100", lrid: "L1", ask: 12.5, fmv: "30" }),
            // No "Player Name" trait -> first/last fallback; blended FMV 0 -> null.
            adNft({
              flowId: "101",
              lrid: "L2",
              ask: "3.25",
              fmv: 0,
              editionId: "ED-2",
              playerTrait: null,
              firstLast: ["TJ", "Hockenson"],
            }),
          ],
        },
        desc: { 0: [] },
      }),
    ])
    const spy = install({
      editions: { data: [{ id: "uuid-ed1", external_id: "ED-1" }], error: null },
      cached_listings: { data: null, error: null },
      "rpc:clear_badge_low_ask_stale": { data: 4, error: null },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
    })

    const res = await POST(req("POST"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      errorMsg: null,
      totalFetched: 2,
      totalListed: 2,
      upserted: 2,
      upsertErrors: 0,
      editionsMapped: 1, // only ED-1 resolves against editions
      fmvRpcCalled: true,
      badge_low_ask_stale_cleared: 4,
    })

    // Sweep request contract: listingKind:"sale" + salePrice sort, asc then desc.
    const bodies = fetchMock.calls.map((c) => JSON.parse(String(c.init?.body)))
    expect(bodies[0]).toMatchObject({
      contractAddress: "0xe4cf4bdc1751c65d",
      contractName: "AllDay",
      payload: {
        filters: { listingKind: "sale" },
        offset: 0,
        limit: 50,
        sort: { direction: "asc", path: "salePrice" },
      },
    })
    // Short first page (2 < 50) breaks the asc sweep; empty desc page breaks desc.
    expect(bodies).toHaveLength(2)
    expect(bodies[1].payload.sort.direction).toBe("desc")

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    const jj = upserts.find((r) => r.flow_id === "100")
    expect(jj).toMatchObject({
      id: "L1", // keyed by listingResourceID
      flow_id: "100",
      moment_id: "ED-1", // AllDay moment_id = editionID trait
      player_name: "Justin Jefferson",
      team_name: "Minnesota Vikings",
      set_name: "Base Set",
      series_name: "Series 2",
      tier: "RARE",
      serial_number: 7,
      circulation_count: 150,
      ask_price: 12.5, // usdValue, not salePrice
      fmv: 30,
      source: "flowty",
      buy_url:
        "https://www.flowty.io/asset/0xe4cf4bdc1751c65d/AllDay/NFT/100?listingResourceID=L1",
      thumbnail_url: "https://img/ad.png",
      listing_resource_id: "L1",
      storefront_address: "0xsellerAD",
      is_locked: false,
      listed_at: new Date(LISTED_TS_MS).toISOString(),
      collection_id: AD_COLLECTION,
    })
    // The lookup-only helper column never reaches the table.
    expect(jj).not.toHaveProperty("edition_external_id")
    const tj = upserts.find((r) => r.flow_id === "101")
    expect(tj).toMatchObject({ player_name: "TJ Hockenson", fmv: null, ask_price: 3.25 })

    // Purge AFTER upsert, scoped + thresholded at function-top startedAt.
    expect(spy.deletes).toHaveLength(1)
    const purge = spy.deletes[0]
    expect(purge.table).toBe("cached_listings")
    expect(findFilter(purge, "eq", "collection_id")?.args[1]).toBe(AD_COLLECTION)
    expect(findFilter(purge, "eq", "source")?.args[1]).toBe("flowty")
    const threshold = findFilter(purge, "lt", "cached_at")?.args[1] as string
    for (const row of upserts) {
      expect(Date.parse(threshold)).toBeLessThanOrEqual(Date.parse(String(row.cached_at)))
    }

    // Chained effects: badge stale-clear (with args) then ASK_ONLY FMV regen.
    const badgeCall = spy.rpcCalls.find((c) => c.name === "clear_badge_low_ask_stale")
    expect(badgeCall?.args).toEqual({ p_collection_id: AD_COLLECTION, p_stale_after: "100 minutes" })
    const fmvCall = spy.rpcCalls.find((c) => c.name === "fmv_from_cached_listings")
    expect(fmvCall?.args).toEqual({ p_collection_id: AD_COLLECTION })

    const log = terminalLog(spy)
    expect(log).toMatchObject({
      p_pipeline: "allday-listing-cache",
      p_started_at: body.startedAt,
      p_rows_found: 2,
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: "nfl_all_day",
    })
    expect(log?.p_extra).toMatchObject({
      total_fetched: 2,
      editions_mapped: 1,
      fmv_rpc_called: true,
      badge_low_ask_stale_cleared: 4,
    })
  })

  it("dedups by listing_resource_id across sweeps, then keeps the LOWEST ask per flow_id before the onConflict:flow_id upsert", async () => {
    const ascRow = adNft({ flowId: "100", lrid: "L1", ask: 10 })
    fetchMock = installFetchMock([
      proxyStub({
        asc: { 0: [ascRow] },
        // Same lrid reappears (skipped), same flow_id under a new lrid at a
        // lower ask (kept — replaces the L1 row in the flow_id dedup).
        desc: { 0: [ascRow, adNft({ flowId: "100", lrid: "L2", ask: 5 })] },
      }),
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: null },
    })

    const res = await POST(req("POST"))
    const body = await res.json()
    expect(body).toMatchObject({ totalListed: 2, upserted: 1 })

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ flow_id: "100", listing_resource_id: "L2", ask_price: 5 })

    expect(terminalLog(spy)).toMatchObject({ p_rows_found: 2, p_rows_written: 1, p_ok: true })
  })
})

describe("allday-listing-cache — degradation + fatal honesty", () => {
  it("a full Flowty outage (every page 500s) walks all 20 pages, writes nothing, PRESERVES the prior cache (no purge), and logs the run as FAILED — not ok", async () => {
    fetchMock = installFetchMock([proxyStub({}, { status: 500 })])
    const spy = install({
      cached_listings: { data: null, error: null },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
    })

    const res = await POST(req("POST"))
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, totalFetched: 0, totalListed: 0, upserted: 0 })
    // Page failures don't break the sweep loops: 10 offsets x 2 sorts.
    expect(fetchMock.calls).toHaveLength(20)
    expect(spy.writes.cached_listings ?? []).toHaveLength(0)
    expect(spy.deletes).toHaveLength(0) // outage never wipes the cache
    // The FMV regen still runs off whatever the cache already holds.
    expect(spy.rpcCalls.map((c) => c.name)).toContain("fmv_from_cached_listings")
    // INVERTED 2026-08-25: this used to pin `p_ok: true`. A run that could not
    // read a single page of the book is not a healthy run — it is a degraded one
    // whose purge was suppressed, and `pipeline_runs` is the only place that
    // fact can be counted from.
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: false, p_rows_found: 0, p_rows_written: 0 })
    expect(String(log?.p_error)).toContain("sweep incomplete")
    expect(log?.p_extra).toMatchObject({ sweep_complete: false, page_errors: 20 })
  })

  it("REGRESSION: a sweep whose FIRST page lands and a LATER page 500s skips the purge — a partial book never drives a delete", async () => {
    let call = 0
    fetchMock = installFetchMock([
      {
        match: (url: string) => url.includes("flowty-proxy"),
        respond: (_url: string, init?: RequestInit) => {
          // Page 0 of the asc sweep lands; the very next page fails. The run
          // therefore holds a real, non-empty, INCOMPLETE book — the shape
          // `upserted > 0` could never distinguish from a complete one.
          call++
          if (call === 1) {
            return { json: { nfts: [adNft({ flowId: "100", lrid: "L1", ask: 10 })] } }
          }
          return call === 2
            ? { status: 500, text: "flowty down" }
            : { json: { nfts: [] } }
        },
      } as never,
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: null, count: 1 },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
      "rpc:clear_badge_low_ask_stale": { data: 0, error: null },
    })

    await POST(req("POST"))

    expect((spy.writes.cached_listings ?? []).length).toBeGreaterThan(0)
    expect(spy.deletes).toHaveLength(0)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: false })
    expect(String(log?.p_error)).toContain("sweep incomplete")
    expect(log?.p_extra).toMatchObject({ sweep_complete: false, page_errors: 1 })
  })

  it("an upsert batch error counts every row as an upsertError, skips the purge, and reports p_rows_skipped", async () => {
    fetchMock = installFetchMock([
      proxyStub({
        asc: { 0: [adNft({ flowId: "100", lrid: "L1", ask: 10 }), adNft({ flowId: "101", lrid: "L2", ask: 11, editionId: "ED-2" })] },
        desc: { 0: [] },
      }),
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: { message: "constraint violation" } },
    })

    const res = await POST(req("POST"))
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, upserted: 0, upsertErrors: 2 })
    expect(spy.deletes).toHaveLength(0)
    expect(terminalLog(spy)).toMatchObject({
      p_rows_found: 2,
      p_rows_written: 0,
      p_rows_skipped: 2,
      p_ok: true, // batch errors degrade, they don't flip the run to failed
    })
  })

  it("fatal (upsert THROWS) -> ok=false with the error message, run still logged via log_pipeline_run", async () => {
    fetchMock = installFetchMock([
      proxyStub({ asc: { 0: [adNft({ flowId: "100", lrid: "L1", ask: 10 })] }, desc: { 0: [] } }),
    ])
    const spy = install(
      { editions: { data: [], error: null } },
      { failWrites: ["cached_listings"] },
    )

    const res = await POST(req("POST"))
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.errorMsg)).toContain("forced cached_listings upsert failure")

    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_pipeline: "allday-listing-cache", p_ok: false })
    expect(String(log?.p_error)).toContain("forced cached_listings upsert failure")
  })
})

describe("allday-listing-cache — auth + after() deferral", () => {
  it("401s both verbs without the token", async () => {
    install({})
    expect((await GET(req("GET", null))).status).toBe(401)
    expect((await POST(req("POST", null))).status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("GET accepts immediately and defers the sweep via after(); the deferred run logs its pipeline row", async () => {
    fetchMock = installFetchMock([proxyStub({ asc: { 0: [] }, desc: { 0: [] } })])
    const spy = install({})

    const res = await GET(req("GET"))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
    expect(state.afterCbs).toHaveLength(1)
    // Nothing ran yet.
    expect(spy.rpcCalls.filter((c) => c.name === "log_pipeline_run")).toHaveLength(0)

    for (const cb of state.afterCbs.splice(0)) await cb()
    expect(terminalLog(spy)).toMatchObject({
      p_pipeline: "allday-listing-cache",
      p_ok: true,
      p_rows_found: 0,
    })
  })
})
