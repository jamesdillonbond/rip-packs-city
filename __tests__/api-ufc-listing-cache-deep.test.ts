import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"
import { recordDeletes, findFilter } from "./helpers/delete-recorder"

// Deep-drive of /api/ufc-listing-cache — the UFC Strike Flowty ingest. UFC hits
// api2.flowty.io DIRECTLY (Origin header required, no proxy) and — unlike the
// TS/AllDay/Golazos siblings — uses DELETE-FIRST replace semantics: the whole
// UFC slice of cached_listings is wiped before the upserts, unconditionally.
// Pins:
//   - request contract (Origin: https://www.flowty.io, offset pagination) and
//     the three stop conditions (short page, no-new-flow_ids, reportedTotal);
//   - row contract: tier INFERRED from circulation (no tier trait upstream),
//     slugified edition name + max as external/moment id, serial from
//     editions.infoList, fmv always null (no LiveToken for UFC);
//   - editions-enrichment merge: Flowty wins player_name (catchphrase moments),
//     editions wins set/team/series + thumbnail fill;
//   - delete-first ordering (a failed wipe aborts BEFORE any upsert) and the
//     unconditional wipe on an empty sweep (divergence from the sibling routes'
//     preserve-on-outage behavior — pinned as-is);
//   - log_pipeline_run accounting incl. the fatal path.

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

process.env.INGEST_SECRET_TOKEN = "ufc-cache-token"

const { GET } = await import("@/app/api/ufc-listing-cache/route")

const UFC_COLLECTION = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const LISTED_TS_MS = 1789000000000
const PAGE_LIMIT = 24

function ufcNft(opts: {
  flowId: string
  lrid: string
  name?: string | null
  serial?: number | null
  max?: number | null
  fighter?: string | null
  salePrice?: string | number | null
  usdValue?: string | number | null
  image?: string | null
}) {
  return {
    id: opts.flowId,
    card: {
      title: undefined,
      max: opts.max ?? null,
      num: null,
      images: opts.image ? [{ url: opts.image }] : [],
    },
    nftView: {
      traits: {
        traits: opts.fighter ? [{ name: "ATHLETE 1", value: opts.fighter }] : [],
      },
      editions: {
        infoList: [{ name: opts.name ?? "", number: opts.serial ?? null, max: opts.max ?? null }],
      },
    },
    orders: [
      {
        state: "LISTED",
        listingResourceID: opts.lrid,
        salePrice: opts.salePrice,
        usdValue: opts.usdValue,
        storefrontAddress: "0xsellerUFC",
        blockTimestamp: LISTED_TS_MS,
      },
    ],
  }
}

/** Direct api2.flowty.io stub keyed by request offset. */
function flowtyStub(
  pagesByOffset: Record<number, unknown[]>,
  opts: { total?: number; status?: number } = {},
): FetchStub {
  return {
    match: (url) => url.includes("api2.flowty.io"),
    respond: (_url, init) => {
      if (opts.status) return { status: opts.status, text: "flowty down" }
      const parsed = JSON.parse(String(init?.body))
      return { json: { nfts: pagesByOffset[parsed?.offset as number] ?? [], total: opts.total } }
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

function req(token: string | null = "ufc-cache-token"): NextRequest {
  return new NextRequest("https://t/api/ufc-listing-cache", {
    method: "GET",
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

describe("ufc-listing-cache — mapping, enrichment, replace semantics", () => {
  it("slugified external ids, inferred tiers, Flowty-wins player vs editions-wins set/series enrichment, delete-first wipe scoped to the UFC collection only, fmv rpc, ok log", async () => {
    fetchMock = installFetchMock([
      flowtyStub({
        0: [
          // Catchphrase moment: editions.player_name is the catchphrase itself —
          // the ATHLETE 1 trait must win.
          ufcNft({
            flowId: "15677001",
            lrid: "U1",
            name: "My Balls Was Hot",
            serial: 42,
            max: 750,
            fighter: "Max Holloway",
            salePrice: "12",
            image: "https://img/ufc1.png",
          }),
          // No fighter trait -> editions fills player_name; no card image ->
          // editions thumbnail fills; no salePrice -> usdValue ask.
          ufcNft({
            flowId: "15677002",
            lrid: "U2",
            name: "Adesanya Strikes",
            serial: 3,
            max: 5,
            usdValue: 1000,
          }),
          // No edition name anywhere -> dropped during mapping.
          ufcNft({ flowId: "15677003", lrid: "U3", name: "", salePrice: "1" }),
        ],
      }),
    ])
    const spy = install({
      editions: {
        data: [
          {
            id: "ed-u1",
            external_id: "MY-BALLS-WAS-HOT-750",
            player_name: "My Balls Was Hot", // the catchphrase-as-player defect
            set_name: "Fight Night",
            team_name: null,
            series: 1,
            thumbnail_url: "https://ed/1.png",
          },
          {
            id: "ed-u2",
            external_id: "ADESANYA-STRIKES-5",
            player_name: "Israel Adesanya",
            set_name: "Main Event",
            team_name: "Middleweight",
            series: 0,
            thumbnail_url: "https://ed/2.png",
          },
        ],
        error: null,
      },
      cached_listings: { data: null, error: null },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
    })

    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
    await runDeferred()

    // Direct Flowty call carries the required Origin header (no proxy for UFC).
    const headers = fetchMock.calls[0]?.init?.headers as Record<string, string>
    expect(headers.Origin).toBe("https://www.flowty.io")
    expect(fetchMock.calls[0]?.url).toContain("api2.flowty.io/collection/0x329feb3ab062d289/UFC_NFT")

    // DELETE-FIRST replace: full UFC wipe (collection filter ONLY — no source,
    // no cached_at threshold; this route replaces, it doesn't purge-stale).
    expect(spy.deletes).toHaveLength(1)
    const wipe = spy.deletes[0]
    expect(wipe.table).toBe("cached_listings")
    expect(findFilter(wipe, "eq", "collection_id")?.args[1]).toBe(UFC_COLLECTION)
    expect(wipe.filters).toHaveLength(1)

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    const holloway = upserts.find((r) => r.flow_id === "15677001")
    expect(holloway).toMatchObject({
      id: "U1",
      moment_id: "MY-BALLS-WAS-HOT-750", // slugify(name) + "-" + max
      player_name: "Max Holloway", // Flowty wins over the catchphrase
      set_name: "Fight Night", // editions wins
      team_name: null,
      series_name: "Series 1", // editions.series
      tier: "CHALLENGER", // inferred: 100 <= 750 <= 999
      serial_number: 42,
      circulation_count: 750,
      ask_price: 12,
      fmv: null, // UFC has no LiveToken FMV — always null
      source: "flowty",
      buy_url:
        "https://www.flowty.io/asset/0x329feb3ab062d289/UFC_NFT/NFT/15677001?listingResourceID=U1",
      thumbnail_url: "https://img/ufc1.png", // card image wins when present
      listing_resource_id: "U1",
      storefront_address: "0xsellerUFC",
      listed_at: new Date(LISTED_TS_MS).toISOString(),
      collection_id: UFC_COLLECTION,
    })
    expect(holloway).not.toHaveProperty("edition_external_id")
    const adesanya = upserts.find((r) => r.flow_id === "15677002")
    expect(adesanya).toMatchObject({
      player_name: "Israel Adesanya", // filled from editions (no fighter trait)
      set_name: "Main Event",
      team_name: "Middleweight",
      series_name: "Series 0",
      tier: "ULTIMATE", // circ 5 <= 10
      ask_price: 1000, // usdValue fallback
      thumbnail_url: "https://ed/2.png", // editions thumbnail fill
    })

    expect(spy.rpcCalls.find((c) => c.name === "fmv_from_cached_listings")?.args).toEqual({
      p_collection_id: UFC_COLLECTION,
    })
    const log = terminalLog(spy)
    expect(log).toMatchObject({
      p_pipeline: "ufc-listing-cache",
      p_rows_found: 2,
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: "ufc",
    })
    expect(log?.p_extra).toMatchObject({
      total_fetched: 3,
      editions_mapped: 2,
      fmv_rpc_called: true,
    })
  })

  it("infers the full tier ladder from circulation (ULTIMATE/CHAMPION/CHALLENGER/CONTENDER/FANDOM) and drops the max suffix when circulation is unknown", async () => {
    fetchMock = installFetchMock([
      flowtyStub({
        0: [
          ufcNft({ flowId: "1", lrid: "T1", name: "A", max: 10, salePrice: 1 }),
          ufcNft({ flowId: "2", lrid: "T2", name: "B", max: 99, salePrice: 1 }),
          ufcNft({ flowId: "3", lrid: "T3", name: "C", max: 999, salePrice: 1 }),
          ufcNft({ flowId: "4", lrid: "T4", name: "D", max: 25000, salePrice: 1 }),
          ufcNft({ flowId: "5", lrid: "T5", name: "E", max: null, salePrice: 1 }),
        ],
      }),
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: null },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
    })

    await GET(req())
    await runDeferred()

    const upserts = (spy.writes.cached_listings ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    const byFlow = new Map(upserts.map((r) => [r.flow_id, r]))
    expect(byFlow.get("1")).toMatchObject({ tier: "ULTIMATE", moment_id: "A-10" })
    expect(byFlow.get("2")).toMatchObject({ tier: "CHAMPION", moment_id: "B-99" })
    expect(byFlow.get("3")).toMatchObject({ tier: "CHALLENGER", moment_id: "C-999" })
    expect(byFlow.get("4")).toMatchObject({ tier: "CONTENDER", moment_id: "D-25000" })
    // Unknown circulation: FANDOM tier + slug WITHOUT the -max suffix.
    expect(byFlow.get("5")).toMatchObject({ tier: "FANDOM", moment_id: "E", circulation_count: null })
  })

  it("paginates by PAGE_LIMIT and stops when a full page yields no NEW flow_ids (dedup guard)", async () => {
    const fullPage = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      ufcNft({ flowId: `f${i}`, lrid: `L${i}`, name: `Fight ${i}`, max: 500, salePrice: 2 }),
    )
    fetchMock = installFetchMock([
      // Offset 24 returns the SAME page — seenFlowIds stops growing -> break.
      flowtyStub({ 0: fullPage, 24: fullPage }, { total: 100 }),
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: null },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
    })

    await GET(req())
    await runDeferred()

    expect(fetchMock.calls).toHaveLength(2)
    const offsets = fetchMock.calls.map((c) => JSON.parse(String(c.init?.body)).offset)
    expect(offsets).toEqual([0, 24])
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_rows_found: PAGE_LIMIT, p_rows_written: PAGE_LIMIT })
    expect((log?.p_extra as Record<string, unknown>).total_fetched).toBe(PAGE_LIMIT * 2)
  })
})

describe("ufc-listing-cache — failure paths + auth", () => {
  it("a failed wipe ABORTS before any upsert (delete-first ordering) and logs ok=false", async () => {
    fetchMock = installFetchMock([
      flowtyStub({ 0: [ufcNft({ flowId: "1", lrid: "U1", name: "A", max: 10, salePrice: 1 })] }),
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: { message: "table locked" } },
    })

    await GET(req())
    await runDeferred()

    // The wipe error throws BEFORE the upsert loop — nothing was written.
    expect(spy.deletes).toHaveLength(1)
    expect(spy.writes.cached_listings ?? []).toHaveLength(0)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: false, p_rows_written: 0 })
    expect(String(log?.p_error)).toContain("delete failed: table locked")
  })

  // INVERTED 2026-08-25. This test used to READ: "a total Flowty outage still
  // wipes the UFC slice (unconditional replace — pinned divergence from the
  // preserve-on-outage siblings)". That divergence was a defect, not a design:
  // this route replaces its WHOLE slice rather than purging by `cached_at`, so
  // one failed page-0 fetch deleted every UFC listing, upserted none, and logged
  // `ok: true`. Per CLAUDE.md a test pinning the defect it was named to prevent
  // gets INVERTED, never deleted — the assertions below are the same three
  // observations with the opposite expectation.
  it("a total Flowty outage PRESERVES the UFC slice (the replace is gated on a complete sweep) and logs the run as FAILED", async () => {
    fetchMock = installFetchMock([flowtyStub({}, { status: 500 })])
    const spy = install({
      cached_listings: { data: null, error: null },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
    })

    await GET(req())
    await runDeferred()

    expect(fetchMock.calls).toHaveLength(1) // first page fails -> loop breaks
    expect(spy.deletes).toHaveLength(0) // the wipe NO LONGER runs on 0 fetched rows
    expect(spy.writes.cached_listings ?? []).toHaveLength(0)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: false, p_rows_found: 0, p_rows_written: 0 })
    expect(String(log?.p_error)).toContain("sweep incomplete")
    expect(log?.p_extra).toMatchObject({ sweep_complete: false, page_errors: 1 })
  })

  it("REGRESSION: a full page 0 followed by a failing page 1 upserts its rows but SKIPS the wipe", async () => {
    // A full page forces the walk on; page 1 then fails. The run holds a real,
    // non-empty, INCOMPLETE book — and on THIS route the un-gated replace would
    // have deleted the whole slice and written back only the part it had read.
    const page0: Record<string, unknown> = {}
    page0[0] = Array.from({ length: 24 }, (_, i) =>
      ufcNft({ flowId: String(500 + i), lrid: `U${500 + i}`, name: `F${i}`, max: 10, salePrice: 1 }),
    )
    let call = 0
    fetchMock = installFetchMock([
      {
        match: (url: string) => url.includes("api2.flowty.io"),
        respond: () => {
          call++
          return call === 1
            ? { json: { nfts: (page0 as Record<number, unknown[]>)[0] } }
            : { status: 500, text: "flowty down" }
        },
      } as never,
    ])
    const spy = install({
      editions: { data: [], error: null },
      cached_listings: { data: null, error: null, count: 24 },
      "rpc:fmv_from_cached_listings": { data: null, error: null },
    })

    await GET(req())
    await runDeferred()

    expect((spy.writes.cached_listings ?? []).length).toBeGreaterThan(0)
    expect(spy.deletes).toHaveLength(0)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: false })
    expect(String(log?.p_error)).toContain("sweep incomplete")
    expect(log?.p_extra).toMatchObject({ sweep_complete: false, page_errors: 1 })
  })

  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await GET(req(null))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
