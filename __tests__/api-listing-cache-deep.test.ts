import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"
import { recordDeletes, findFilter, type RecordedDelete } from "./helpers/delete-recorder"

// Deep-drive of POST /api/listing-cache — the TopShot (multi-collection) Flowty
// listing-cache ingest. LIVE production ingest (the Flowty API outlived the
// marketplace frontend and feeds cached_listings + ASK FMV today), so this pins
// the real ingest body, not fixture echo:
//   - flowty-proxy fan-out (pagesToFetch pages, offset-keyed), mapFlowtyListing
//     row contract (flowty-<flowId>-<lrid> id, discount vs LiveToken blended FMV,
//     series-name mapping, tier uppercasing, ms blockTimestamp -> listed_at ISO);
//   - upsert-then-conditional-purge: purge is .lt("cached_at", <function-top
//     startedAt>) scoped to (source=flowty, collection_id), runs ONLY when at
//     least one row upserted — a fully-failed sweep preserves the prior cache;
//   - chunk-error fallback: a failed 25-row chunk retries row-by-row and the
//     pipeline_runs row reports honest inserted/error accounting (ok=false);
//   - wallet-verification resolver RPC fired once per sweep;
//   - flowty-empty early exit preserves cache + still chains to the next
//     collection; fatal path 500s, pages Sentry with route/collection tags, and
//     still writes an ok=false pipeline_runs row.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  flowtyEnabled: true,
  chainCalls: [] as Array<{ path: string; chain: boolean }>,
  sentryTags: [] as Array<Record<string, string>>,
  captured: [] as unknown[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@sentry/nextjs", () => ({
  withScope: (cb: (scope: { setTag: (k: string, v: string) => void }) => void) => {
    const tags: Record<string, string> = {}
    cb({ setTag: (k: string, v: string) => void (tags[k] = v) })
    state.sentryTags.push(tags)
  },
  captureException: (e: unknown) => void state.captured.push(e),
}))
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async (path: string, chain: boolean) =>
    void state.chainCalls.push({ path, chain }),
}))
vi.mock("@/lib/flowty-flags", () => ({
  isFlowtyIngestEnabled: () => state.flowtyEnabled,
}))

// Module throws at import without FLOWTY_PROXY_TOKEN; env must precede the import.
process.env.FLOWTY_PROXY_TOKEN = "flowty-proxy-token"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role"

const { POST } = await import("@/app/api/listing-cache/route")

const TS_COLLECTION = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const LISTED_TS_MS = 1789000000000

// ── Flowty raw-NFT fixtures (proxy payload shape) ───────────────────────────
const lillardNft = {
  id: 555001,
  nftView: {
    uuid: "uuid-moment-1",
    traits: [
      { name: "SeriesNumber", value: "7" },
      { name: "Tier", value: "Rare" },
      { name: "TeamAtMoment", value: "Portland Trail Blazers" },
      { name: "SetName", value: "Metallic Gold LE" },
      { name: "Locked", value: "false" },
    ],
  },
  card: { title: "Damian Lillard", num: "23", max: "749", images: [{ url: "https://img/dame.png" }] },
  valuations: { blended: { usdValue: "20" } },
  orders: [
    {
      state: "LISTED",
      salePrice: "15",
      listingResourceID: 987654,
      storefrontAddress: "0xseller01",
      blockTimestamp: LISTED_TS_MS, // Flowty blockTimestamp is in MILLISECONDS
    },
  ],
}

// Valid but FMV-less (no valuations, no tier/series traits) — the honest-null row.
const simonsNft = {
  id: 555002,
  nftView: { uuid: "uuid-moment-2", traits: [] },
  card: { title: "Anfernee Simons", num: "5", max: "100", images: [] },
  orders: [{ state: "LISTED", salePrice: "4.5", listingResourceID: 111222 }],
}

// Filtered during mapping: not LISTED / no orders / zero price / no player name.
const soldNft = { ...lillardNft, id: 555003, orders: [{ state: "SOLD", salePrice: "9", listingResourceID: 1 }] }
const orderlessNft = { ...lillardNft, id: 555004, orders: [] }
const freeNft = { ...lillardNft, id: 555005, orders: [{ state: "LISTED", salePrice: "0", listingResourceID: 2 }] }
const namelessNft = {
  id: 555006,
  nftView: { uuid: "uuid-moment-6", traits: [] },
  card: { num: "1", max: "10", images: [] },
  orders: [{ state: "LISTED", salePrice: "3", listingResourceID: 3 }],
}

/** flowty-proxy stub: offset 0 serves `nfts`, every other page is empty. */
function proxyStub(nfts: unknown[]): FetchStub {
  return {
    match: (url) => url.includes("flowty-proxy"),
    respond: (_url, init) => {
      const parsed = JSON.parse(String(init?.body))
      return { json: { nfts: parsed?.payload?.offset === 0 ? nfts : [] } }
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

function req(query = "collection=nba-top-shot"): NextRequest {
  return new NextRequest(`https://t/api/listing-cache?${query}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ingest-token" }),
  })
}

function pipelineRow(spy: { writes: Record<string, Array<{ rows: Record<string, unknown>[] }>> }) {
  return spy.writes.pipeline_runs?.flatMap((w) => w.rows).at(-1)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-token"
  state.flowtyEnabled = true
  state.chainCalls.length = 0
  state.sentryTags.length = 0
  state.captured.length = 0
})

describe("listing-cache — TopShot Flowty ingest happy path", () => {
  it("maps raw Flowty NFTs to the exact cached_listings contract, purges stale rows AFTER upsert with the function-top threshold, fires the verify resolver, logs ok, chains onward", async () => {
    fetchMock = installFetchMock([
      proxyStub([lillardNft, simonsNft, soldNft, orderlessNft, freeNft, namelessNft]),
    ])
    const spy = install({
      cached_listings: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
      "rpc:resolve_wallet_verification_challenges": { data: [{}, {}], error: null },
    })

    const res = await POST(req("collection=nba-top-shot&chain=true"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      collection: "nba-top-shot",
      fetched: 6, // raw NFTs, pre-filter
      mapped: 2, // SOLD / orderless / $0 / nameless all dropped in mapping
      cached: 2,
      errors: 0,
    })
    // TopShot config fans out 12 proxy pages.
    expect(fetchMock.calls.filter((c) => c.url.includes("flowty-proxy"))).toHaveLength(12)

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    const dame = upserts.find((r) => r.flow_id === "555001")
    expect(dame).toMatchObject({
      id: "flowty-555001-987654",
      flow_id: "555001",
      moment_id: "uuid-moment-1", // TopShot keys moment_id from nftView.uuid
      player_name: "Damian Lillard",
      team_name: "Portland Trail Blazers",
      set_name: "Metallic Gold LE",
      series_name: "Series 2024-25", // seriesNum 7 through the config map
      tier: "RARE", // uppercased
      serial_number: 23,
      circulation_count: 749,
      ask_price: 15,
      fmv: 20,
      adjusted_fmv: 20,
      discount: 25, // (20-15)/20 * 100
      confidence: "HIGH",
      source: "flowty",
      collection_id: TS_COLLECTION,
      buy_url:
        "https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/555001?listingResourceID=987654",
      thumbnail_url: "https://img/dame.png",
      listing_resource_id: "987654",
      storefront_address: "0xseller01",
      is_locked: false,
      listed_at: new Date(LISTED_TS_MS).toISOString(), // ms blockTimestamp -> ISO
    })
    // No LiveToken valuation -> honest nulls, defaults for missing traits.
    const simons = upserts.find((r) => r.flow_id === "555002")
    expect(simons).toMatchObject({
      fmv: null,
      adjusted_fmv: null,
      discount: null,
      confidence: null,
      tier: "COMMON",
      series_name: "",
      ask_price: 4.5,
    })

    // Purge AFTER upsert: scoped to (source=flowty, TS collection), threshold =
    // the function-top startedAt — strictly earlier than every freshly written
    // row's cached_at, so the purge can never eat what this run just wrote.
    expect(spy.deletes).toHaveLength(1)
    const purge = spy.deletes[0] as RecordedDelete
    expect(purge.table).toBe("cached_listings")
    expect(findFilter(purge, "eq", "source")?.args[1]).toBe("flowty")
    expect(findFilter(purge, "eq", "collection_id")?.args[1]).toBe(TS_COLLECTION)
    const threshold = findFilter(purge, "lt", "cached_at")?.args[1] as string
    expect(Date.parse(threshold)).not.toBeNaN()
    for (const row of upserts) {
      expect(Date.parse(threshold)).toBeLessThanOrEqual(Date.parse(String(row.cached_at)))
    }

    // Wallet-verification fallback resolver fires once per sweep.
    expect(spy.rpcCalls.map((c) => c.name)).toContain("resolve_wallet_verification_challenges")

    const run = pipelineRow(spy)
    expect(run).toMatchObject({
      pipeline: "topshot-listing-cache-v2",
      collection_slug: "nba-top-shot",
      rows_found: 6,
      rows_written: 2,
      ok: true,
      error: null,
      extra: { mapped: 2, insert_errors: 0 },
    })

    // chain=true + chainNext -> fires the AllDay leg.
    expect(state.chainCalls).toEqual([
      { path: "/api/listing-cache?collection=nfl-all-day", chain: true },
    ])
  })
})

describe("listing-cache — upsert error degradation", () => {
  it("falls back to row-by-row on a failed chunk, keeps honest inserted/error accounting, still purges (inserted > 0), logs ok=false", async () => {
    fetchMock = installFetchMock([proxyStub([lillardNft, simonsNft])])
    const spy = install({
      // Sequence: chunk upsert errors -> row0 errors -> row1 ok -> purge delete ok.
      cached_listings: [
        { data: null, error: { message: "chunk exploded" } },
        { data: null, error: { message: "row is bad" } },
        { data: null, error: null },
        { data: null, error: null },
      ],
      pipeline_runs: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, cached: 1, errors: 1, mapped: 2 })

    // One good row got through -> the stale purge still runs.
    expect(spy.deletes).toHaveLength(1)

    const run = pipelineRow(spy)
    expect(run).toMatchObject({
      pipeline: "topshot-listing-cache-v2",
      rows_found: 2,
      rows_written: 1,
      ok: false,
      error: "1 insert chunk error(s)",
      extra: { mapped: 2, insert_errors: 1 },
    })
  })

  it("REGRESSION: one page of the parallel fan-out failing skips the purge — a partial book never drives a delete", async () => {
    // Offset 0 lands with real rows; a LATER page 500s. The pages are fetched
    // in parallel and flattened, so a failed page contributes zero rows exactly
    // like a legitimately empty one — `inserted > 0` is satisfied while the run
    // holds a book missing a page, and the old purge deleted precisely the
    // listings that page would have refreshed.
    fetchMock = installFetchMock([
      {
        match: (url: string) => url.includes("flowty-proxy"),
        respond: (_url: string, init?: RequestInit) => {
          const parsed = JSON.parse(String(init?.body))
          const offset = parsed?.payload?.offset as number
          if (offset === 0) return { json: { nfts: [lillardNft, simonsNft] } }
          return offset === 100
            ? { status: 500, text: "flowty down" }
            : { json: { nfts: [] } }
        },
      } as never,
    ])
    const spy = install({
      cached_listings: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    // The run DID write — which is exactly why `inserted > 0` alone could not
    // protect it.
    expect(body).toMatchObject({ ok: false, sweepComplete: false, pageErrors: 1 })
    expect(body.cached).toBeGreaterThan(0)
    expect(spy.deletes).toHaveLength(0)

    const run = pipelineRow(spy)
    expect(run).toMatchObject({ ok: false, extra: { sweep_complete: false, page_errors: 1 } })
    expect(String((run as Record<string, unknown>)?.error)).toContain("sweep incomplete")
  })

  it("NO-CHANGE CONTROL: an all-pages-succeed sweep still purges — the guard suppresses a delete only on truncation", async () => {
    // Without this, a route that simply never purged again would satisfy the
    // regression above.
    fetchMock = installFetchMock([proxyStub([lillardNft, simonsNft])])
    const spy = install({
      cached_listings: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })

    // ⓘ Asserts ONLY properties that hold both before and after this change, on
    // purpose: a control that goes red against the pre-fix route is testing the
    // fix, not controlling it. Its job is to stay green forever and go red if
    // someone ever "fixes" a truncation report by suppressing the purge outright.
    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ ok: true })
    expect(spy.deletes).toHaveLength(1)
    expect(pipelineRow(spy)).toMatchObject({ ok: true, error: null })
  })

  it("REGRESSION: a total Flowty outage is logged as UNREADABLE, not as an empty marketplace", async () => {
    // Zero rows from a failed read and zero rows from an empty book are the same
    // array. Reporting the first as `reason: "flowty_empty", ok: true` publishes
    // a failed read as a fact about the market.
    fetchMock = installFetchMock([
      {
        match: (url: string) => url.includes("flowty-proxy"),
        respond: () => ({ status: 503, text: "flowty down" }),
      } as never,
    ])
    const spy = install({ pipeline_runs: { data: null, error: null } })

    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ ok: false, sweepComplete: false })
    expect(spy.deletes).toHaveLength(0)
    const run = pipelineRow(spy)
    expect(run).toMatchObject({ ok: false, extra: { reason: "flowty_unreadable" } })
    expect(String((run as Record<string, unknown>)?.error)).toContain("not an empty marketplace")
  })

  it("NO-CHANGE CONTROL: a genuinely empty book is still reported as flowty_empty and ok", async () => {
    // The other direction. Without it, "never call an empty result empty" would
    // satisfy the outage regression above.
    fetchMock = installFetchMock([proxyStub([])])
    const spy = install({ pipeline_runs: { data: null, error: null } })

    // Green in both worlds by design — see the note on the control above.
    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ ok: true })
    expect(pipelineRow(spy)).toMatchObject({
      ok: true,
      error: null,
      extra: { reason: "flowty_empty" },
    })
  })

  it("skips the stale purge entirely when zero rows upserted — a failed sweep preserves the prior cache", async () => {
    fetchMock = installFetchMock([proxyStub([lillardNft, simonsNft])])
    const spy = install({
      // Every upsert (chunk + both single-row retries) fails.
      cached_listings: { data: null, error: { message: "db down" } },
      pipeline_runs: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, cached: 0, errors: 1 })
    // THE safety contract: no purge when nothing landed.
    expect(spy.deletes).toHaveLength(0)
    expect(pipelineRow(spy)).toMatchObject({ rows_written: 0, ok: false })
  })
})

describe("listing-cache — empty result + control flow", () => {
  it("Flowty returning 0 rows preserves the existing cache, logs reason=flowty_empty, and still chains to the next collection", async () => {
    fetchMock = installFetchMock([proxyStub([])])
    const spy = install({ pipeline_runs: { data: null, error: null } })

    const res = await POST(req("collection=nba-top-shot&chain=true"))
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      message: "Flowty returned 0 - preserving existing cache",
      collection: "nba-top-shot",
      cached: 0,
    })
    expect(spy.writes.cached_listings ?? []).toHaveLength(0)
    expect(spy.deletes).toHaveLength(0)
    expect(pipelineRow(spy)).toMatchObject({
      rows_found: 0,
      rows_written: 0,
      ok: true,
      extra: { reason: "flowty_empty", pages: 12 },
    })
    expect(state.chainCalls).toEqual([
      { path: "/api/listing-cache?collection=nfl-all-day", chain: true },
    ])
  })

  it("fatal (upsert throws) -> 500 ok=false, Sentry paged with route+collection tags, ok=false pipeline_runs row with fatal marker", async () => {
    fetchMock = installFetchMock([proxyStub([lillardNft])])
    const spy = install(
      { pipeline_runs: { data: null, error: null } },
      { failWrites: ["cached_listings"] },
    )

    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("forced cached_listings upsert failure")

    expect(state.captured).toHaveLength(1)
    expect(state.sentryTags[0]).toEqual({ route: "listing-cache", collection: "nba-top-shot" })

    const run = pipelineRow(spy)
    expect(run).toMatchObject({
      pipeline: "topshot-listing-cache-v2",
      ok: false,
      rows_found: 0,
      rows_written: 0,
      extra: { fatal: true },
    })
    expect(String(run?.error)).toContain("forced cached_listings upsert failure")
  })

  it("401s without the ingest token and never touches Flowty", async () => {
    fetchMock = installFetchMock([proxyStub([lillardNft])])
    install({})
    const res = await POST(
      new NextRequest("https://t/api/listing-cache?collection=nba-top-shot", { method: "POST" }),
    )
    expect(res.status).toBe(401)
    expect(fetchMock.calls).toHaveLength(0)
    expect(state.chainCalls).toHaveLength(0)
  })
})
