import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"
import { recordDeletes, findFilter } from "./helpers/delete-recorder"

// Deep-drive of /api/golazos-listing-cache — the LaLiga Golazos Flowty ->
// cached_listings ingest (after()-deferred for both GET and POST). Pins:
//   - row mapping contract: card.title-first player naming with the
//     first/last-name trait fallback and the no-name row DROPPED; PlayDataID as
//     the moment_id fallback when no editionID trait exists; salePrice
//     preferred over usdValue for the ask; tier UPPERCASED; the
//     MatchHighlightedTeam team-name variant; ms blockTimestamp -> ISO;
//   - flow_id dedup is first-wins (asc sweep = cheapest listing wins);
//   - upsert-then-conditional-purge with the function-top startedAt threshold,
//     purge skipped entirely on a zero-upsert run (Flowty outage);
//   - chained fmv_from_cached_listings + update_badge_low_ask_from_cached_listings
//     RPCs and log_pipeline_run accounting incl. the fatal path.

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

process.env.INGEST_SECRET_TOKEN = "gz-cache-token"
process.env.FLOWTY_PROXY_TOKEN = "flowty-proxy-token"

const { GET, POST } = await import("@/app/api/golazos-listing-cache/route")

const GZ_COLLECTION = "06248cc4-b85f-47cd-af67-1855d14acd75"
const LISTED_TS_MS = 1789000000000

function gzNft(opts: {
  flowId: string
  lrid: string
  salePrice?: string | number | null
  usdValue?: string | number | null
  title?: string | null
  firstLast?: [string, string]
  playDataId?: string
  tier?: string
  circ?: number
}) {
  const traits: Array<{ name: string; value: unknown }> = [
    { name: "SerialNumber", value: "12" },
    { name: "SetName", value: "Opening Day" },
    { name: "seriesName", value: "Series 2 (2023-24)" },
    { name: "MatchHighlightedTeam", value: "Real Madrid" },
  ]
  if (opts.playDataId) traits.push({ name: "PlayDataID", value: opts.playDataId })
  if (opts.tier) traits.push({ name: "Tier", value: opts.tier })
  if (opts.firstLast) {
    traits.push({ name: "PlayerFirstName", value: opts.firstLast[0] })
    traits.push({ name: "PlayerLastName", value: opts.firstLast[1] })
  }
  return {
    id: opts.flowId,
    card: {
      title: opts.title ?? undefined,
      max: opts.circ ?? 199,
      images: [{ url: "https://img/gz.png" }],
    },
    nftView: { traits: { traits } },
    orders: [
      {
        state: "LISTED",
        listingResourceID: opts.lrid,
        salePrice: opts.salePrice,
        usdValue: opts.usdValue,
        valuations: { blended: { usdValue: "14" } },
        storefrontAddress: "0xsellerGZ",
        blockTimestamp: LISTED_TS_MS,
      },
    ],
  }
}

/** flowty-proxy stub: offset 0 per sort serves nfts; deeper offsets 500 so the
 *  fixed 10-offset walk skips its 200ms inter-page delays. */
function proxyStub(
  pages: { asc?: unknown[]; desc?: unknown[] },
  opts: { allFail?: boolean; pageErrorAtOffset?: number } = {},
): FetchStub {
  return {
    match: (url) => url.includes("flowty-proxy"),
    respond: (_url, init) => {
      if (opts.allFail) return { status: 500, text: "flowty down" }
      const parsed = JSON.parse(String(init?.body))
      const dir = parsed?.payload?.sort?.direction as "asc" | "desc"
      const offset = parsed?.payload?.offset as number
      // ⚠ Past the fixture this used to answer HTTP 500 ("end of fixture"),
      // which is exactly the conflation the route no longer makes: an upstream
      // ERROR is not an end-of-book. Flowty answers a past-the-end offset with
      // a 200 and an empty list, so the stub does too — otherwise every ordinary
      // sweep here would register 18 page errors and skip its purge.
      // `pageErrorAtOffset` below is the deliberate way to inject a real one.
      if (offset !== 0) {
        return offset === opts.pageErrorAtOffset
          ? { status: 500, text: "flowty down" }
          : { json: { nfts: [] } }
      }
      return { json: { nfts: pages[dir] ?? [] } }
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

function req(method: "GET" | "POST", token: string | null = "gz-cache-token"): NextRequest {
  return new NextRequest("https://t/api/golazos-listing-cache", {
    method,
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

describe("golazos-listing-cache — mapping + write contract", () => {
  it("maps the sweep to exact rows (PlayDataID moment_id, salePrice-first ask, uppercased tier, name fallbacks, no-name dropped, flow_id first-wins), purges, fires both RPCs, logs", async () => {
    fetchMock = installFetchMock([
      proxyStub({
        asc: [
          // Full row: card.title wins, salePrice 8.5 preferred over usdValue 9.
          gzNft({ flowId: "700", lrid: "G1", salePrice: "8.5", usdValue: "9", title: "Jude Bellingham", playDataId: "PD-77", tier: "legendary" }),
          // No card.title -> PlayerFirst/Last join; no PlayDataID -> moment_id null;
          // no salePrice -> usdValue ask; no Tier trait -> tier null.
          gzNft({ flowId: "701", lrid: "G2", usdValue: 2.5, title: null, firstLast: ["Robert", "Lewandowski"] }),
          // No resolvable player name at all -> dropped during mapping.
          gzNft({ flowId: "702", lrid: "G3", salePrice: "1", title: null }),
        ],
        // Duplicate flow_id 700 under a new lrid: first-wins dedup drops it.
        desc: [gzNft({ flowId: "700", lrid: "G9", salePrice: "99", title: "Jude Bellingham" })],
      }),
    ])
    const spy = install({
      editions: { data: [{ id: "uuid-pd77", external_id: "PD-77" }], error: null },
      cached_listings: { data: null, error: null },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
      "rpc:update_badge_low_ask_from_cached_listings": { data: 6, error: null },
    })

    const res = await GET(req("GET"))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
    await runDeferred()

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    const jude = upserts.find((r) => r.flow_id === "700")
    expect(jude).toMatchObject({
      id: "G1", // first-wins: the asc-sweep listing, not the desc dup
      flow_id: "700",
      moment_id: "PD-77",
      player_name: "Jude Bellingham",
      team_name: "Real Madrid", // MatchHighlightedTeam variant
      set_name: "Opening Day",
      series_name: "Series 2 (2023-24)",
      tier: "LEGENDARY",
      serial_number: 12,
      circulation_count: 199, // card.max fallback (no editions infoList)
      ask_price: 8.5, // salePrice preferred over usdValue
      fmv: 14,
      source: "flowty",
      buy_url:
        "https://www.flowty.io/asset/0x87ca73a41bb50ad5/Golazos/NFT/700?listingResourceID=G1",
      listing_resource_id: "G1",
      storefront_address: "0xsellerGZ",
      is_locked: false,
      listed_at: new Date(LISTED_TS_MS).toISOString(),
      collection_id: GZ_COLLECTION,
    })
    expect(jude).not.toHaveProperty("edition_external_id")
    const lewa = upserts.find((r) => r.flow_id === "701")
    expect(lewa).toMatchObject({
      player_name: "Robert Lewandowski",
      moment_id: null,
      ask_price: 2.5,
      tier: null,
    })

    // Purge AFTER upsert with the function-top threshold.
    expect(spy.deletes).toHaveLength(1)
    const purge = spy.deletes[0]
    expect(purge.table).toBe("cached_listings")
    expect(findFilter(purge, "eq", "collection_id")?.args[1]).toBe(GZ_COLLECTION)
    expect(findFilter(purge, "eq", "source")?.args[1]).toBe("flowty")
    const threshold = findFilter(purge, "lt", "cached_at")?.args[1] as string
    for (const row of upserts) {
      expect(Date.parse(threshold)).toBeLessThanOrEqual(Date.parse(String(row.cached_at)))
    }

    // Chained FMV regen + Golazos-specific badge low_ask backfill (compound-key).
    expect(spy.rpcCalls.find((c) => c.name === "fmv_from_cached_listings")?.args).toEqual({
      p_collection_id: GZ_COLLECTION,
    })
    expect(
      spy.rpcCalls.find((c) => c.name === "update_badge_low_ask_from_cached_listings")?.args,
    ).toEqual({ p_collection_id: GZ_COLLECTION })

    const log = terminalLog(spy)
    expect(log).toMatchObject({
      p_pipeline: "golazos-listing-cache",
      p_rows_found: 2, // mapped rows, not raw fetch count
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: "laliga_golazos",
    })
    expect(log?.p_extra).toMatchObject({
      total_fetched: 4,
      editions_mapped: 1,
      fmv_rpc_called: true,
      badge_low_ask_updated: 6,
    })
  })
})

describe("golazos-listing-cache — degradation + fatal honesty", () => {
  it("a full Flowty outage writes nothing, PRESERVES the prior cache (no purge), and logs the run as FAILED — not ok", async () => {
    fetchMock = installFetchMock([proxyStub({}, { allFail: true })])
    const spy = install({
      "rpc:fmv_from_cached_listings": { data: null, error: null },
      "rpc:update_badge_low_ask_from_cached_listings": { data: 0, error: null },
    })

    await GET(req("GET"))
    await runDeferred()

    // Fixed sweep walk: 10 offsets x 2 sorts, failures continue instead of break.
    expect(fetchMock.calls).toHaveLength(20)
    expect(spy.writes.cached_listings ?? []).toHaveLength(0)
    expect(spy.deletes).toHaveLength(0)
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
    fetchMock = installFetchMock([
      proxyStub(
        { asc: [gzNft({ flowId: "700", lrid: "G1", salePrice: "3", title: "Jude" })] },
        { pageErrorAtOffset: 150 },
      ),
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: null, count: 1 },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
      "rpc:update_badge_low_ask_from_cached_listings": { data: 0, error: null },
    })

    await GET(req("GET"))
    await runDeferred()

    // The run DID write — which is exactly why `upserted > 0` alone could not
    // protect it. The rows that lived on the page that 500'd are absent from
    // this run, and the old purge deleted precisely those.
    expect((spy.writes.cached_listings ?? []).length).toBeGreaterThan(0)
    expect(spy.deletes).toHaveLength(0)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: false })
    expect(String(log?.p_error)).toContain("sweep incomplete")
    expect(log?.p_extra).toMatchObject({ sweep_complete: false, page_errors: 2 })
  })

  it("an upsert batch error counts rows as skipped and never purges", async () => {
    fetchMock = installFetchMock([
      proxyStub({ asc: [gzNft({ flowId: "700", lrid: "G1", salePrice: "3", title: "Jude" })] }),
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: { message: "boom" } },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
      "rpc:update_badge_low_ask_from_cached_listings": { data: 0, error: null },
    })

    await GET(req("GET"))
    await runDeferred()

    expect(spy.deletes).toHaveLength(0)
    expect(terminalLog(spy)).toMatchObject({
      p_rows_found: 1,
      p_rows_written: 0,
      p_rows_skipped: 1,
      p_ok: true,
    })
  })

  it("fatal (upsert THROWS) -> log_pipeline_run records ok=false with the error", async () => {
    fetchMock = installFetchMock([
      proxyStub({ asc: [gzNft({ flowId: "700", lrid: "G1", salePrice: "3", title: "Jude" })] }),
    ])
    const spy = install(
      { editions: { data: [], error: null } },
      { failWrites: ["cached_listings"] },
    )

    await GET(req("GET"))
    await runDeferred()

    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_pipeline: "golazos-listing-cache", p_ok: false })
    expect(String(log?.p_error)).toContain("forced cached_listings upsert failure")
  })
})

describe("golazos-listing-cache — auth + verb aliasing", () => {
  it("401s without the token; POST aliases to GET and defers via after()", async () => {
    install({})
    expect((await GET(req("GET", null))).status).toBe(401)
    expect((await POST(req("POST", null))).status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)

    fetchMock = installFetchMock([proxyStub({ asc: [], desc: [] })])
    const res = await POST(req("POST"))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
    expect(state.afterCbs).toHaveLength(1)
  })
})
