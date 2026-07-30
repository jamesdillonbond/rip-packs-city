import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
} from "./helpers/route-harness"

// Step 6b of GET /api/cache-refresh — the NON-TopShot fmv_usd denorm, plus the
// TopShot-only GQL enrichment helper's degradation arms. Both were previously
// undriven (the sibling deep test only exercises the nba-top-shot slug, which
// skips 6b entirely).
//
// Why 6b matters: wallet-search is the usual FMV writer for TS+AllDay, but it
// isn't always called for the non-TS collections, so brand-new wmc rows would
// otherwise keep a NULL fmv_usd forever. The block joins editions.external_id ↔
// wmc.edition_key, takes the NEWEST fmv_current row per edition, and applies a
// defensive $10K ceiling — anything above it is dropped UNLESS the snapshot is
// HIGH confidence with sales_count_30d >= 3 (the guard against the known LaLiga /
// AllDay FMV pipeline outliers). A regression that dropped the ceiling would
// publish a five-figure FMV onto a collector's wallet page off one thin sale.
//
// AllDay's edition key is `meta.playID || meta.setID` (NOT the TopShot
// "setID:playID" pair), so these fixtures key on playID.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as string[],
  metadataById: {} as Record<string, Record<string, string>>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (arg: unknown, t: unknown) => unknown[] }) => {
      if (opts.cadence.includes("getIDs")) return state.ownedIds
      const collected: string[] = []
      opts.args?.(((v: unknown) => {
        collected.push(String(v))
        return v
      }) as never, {} as never)
      const meta = state.metadataById[collected[1]]
      if (!meta) throw new Error("no nft")
      return meta
    },
  },
}))

const { GET } = await import("@/app/api/cache-refresh/route")

const WALLET = "0xbd94cade097e50ac"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

/** Same as install(), but every read of `table` REJECTS — the lever for 6b's
 *  non-fatal catch (a failed FMV lookup must never fail the whole refresh). */
function installThrowingOn(fixtures: Fixtures, table: string) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  const base = (spy.fixture as { from: (t: string) => unknown }).from.bind(spy.fixture)
  ;(spy.fixture as { from: (t: string) => unknown }).from = (t: string) => {
    if (t !== table) return base(t)
    const b: unknown = new Proxy(
      {},
      {
        get: (_x, prop) => {
          if (prop === "then") {
            return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
              Promise.reject(new Error(`${table} read exploded`)).then(onF, onR)
          }
          return () => b
        },
      },
    )
    return b
  }
  state.sb = spy.fixture
  return spy
}

function req(qs: string): NextRequest {
  return new NextRequest(`https://t/api/cache-refresh${qs}`, { method: "GET" })
}

/** AllDay on-chain metadata for one moment, keyed on the edition key we want. */
function allDayMeta(playId: string, serial: string) {
  return { player: "P", setName: "S", series: "1", serial, playID: playId, setID: "ignored", tier: "COMMON" }
}

/** The fmv_usd values Step 6b actually wrote, in order. */
function fmvWrites(spy: ReturnType<typeof install>) {
  return (spy.writes.wallet_moments_cache ?? [])
    .filter((w) => w.method === "update")
    .flatMap((w) => w.rows)
    .filter((r) => "fmv_usd" in r)
    .map((r) => r.fmv_usd)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.ownedIds = []
  state.metadataById = {}
})

describe("cache-refresh Step 6b — non-TopShot fmv_usd denorm", () => {
  // Four fresh AllDay moments, one per FMV outcome. wmc fixtures: the first read
  // is the cached-id diff (empty -> all four are new); every later call is a
  // write ack (the fixture repeats its last entry once exhausted).
  const WMC_ALL_NEW: Fixtures[string] = [
    { data: [], error: null },
    { data: null, error: null },
  ]

  beforeEach(() => {
    state.ownedIds = ["201", "202", "203", "204"]
    state.metadataById = {
      "201": allDayMeta("K-LOW", "1"),
      "202": allDayMeta("K-HIGH-OK", "2"),
      "203": allDayMeta("K-HIGH-DROP", "3"),
      "204": allDayMeta("K-NOSNAP", "4"),
    }
  })

  it("writes the newest snapshot's FMV and enforces the $10K ceiling in both directions", async () => {
    const spy = install({
      wallet_moments_cache: WMC_ALL_NEW,
      moment_acquisitions: { data: [], error: null },
      editions: {
        data: [
          { id: "ed-low", external_id: "K-LOW" },
          { id: "ed-ok", external_id: "K-HIGH-OK" },
          { id: "ed-drop", external_id: "K-HIGH-DROP" },
          { id: "ed-nosnap", external_id: "K-NOSNAP" },
        ],
        error: null,
      },
      // Already ordered computed_at DESC, as the route requests it.
      fmv_current: {
        data: [
          { edition_id: "ed-low", fmv_usd: 25, confidence: "MEDIUM", sales_count_30d: 1 },
          // Older row for the SAME edition — first-seen must win.
          { edition_id: "ed-low", fmv_usd: 999, confidence: "HIGH", sales_count_30d: 40 },
          // Over the ceiling but well-supported -> allowed through.
          { edition_id: "ed-ok", fmv_usd: 15000, confidence: "HIGH", sales_count_30d: 4 },
          // Over the ceiling on ONE sale -> dropped, however confident.
          { edition_id: "ed-drop", fmv_usd: 15000, confidence: "HIGH", sales_count_30d: 1 },
        ],
        error: null,
      },
    })

    const res = await GET(req(`?wallet=${WALLET}&collection=nfl-all-day`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, total_on_chain: 4, enriched: 4 })

    // Only the two survivors are written; the thin five-figure outlier and the
    // edition with no snapshot at all are left NULL rather than guessed at.
    expect(fmvWrites(spy)).toEqual([25, 15000])
  })

  it("accepts a lowercase confidence over the ceiling (the comparison is case-insensitive)", async () => {
    const spy = install({
      wallet_moments_cache: WMC_ALL_NEW,
      moment_acquisitions: { data: [], error: null },
      editions: { data: [{ id: "ed-ok", external_id: "K-HIGH-OK" }], error: null },
      fmv_current: {
        data: [{ edition_id: "ed-ok", fmv_usd: 12000, confidence: "high", sales_count_30d: 3 }],
        error: null,
      },
    })

    await GET(req(`?wallet=${WALLET}&collection=nfl-all-day`))
    expect(fmvWrites(spy)).toEqual([12000])
  })

  it("skips a snapshot whose fmv_usd is null or non-finite rather than writing garbage", async () => {
    const spy = install({
      wallet_moments_cache: WMC_ALL_NEW,
      moment_acquisitions: { data: [], error: null },
      editions: {
        data: [
          { id: "ed-null", external_id: "K-LOW" },
          { id: "ed-nan", external_id: "K-HIGH-OK" },
        ],
        error: null,
      },
      fmv_current: {
        data: [
          { edition_id: "ed-null", fmv_usd: null, confidence: "HIGH", sales_count_30d: 9 },
          { edition_id: "ed-nan", fmv_usd: "not-a-number", confidence: "HIGH", sales_count_30d: 9 },
        ],
        error: null,
      },
    })

    await GET(req(`?wallet=${WALLET}&collection=nfl-all-day`))
    expect(fmvWrites(spy)).toEqual([])
  })

  it("a failed FMV lookup is non-fatal — the refresh still reports its enrichment", async () => {
    const spy = installThrowingOn(
      {
        wallet_moments_cache: WMC_ALL_NEW,
        moment_acquisitions: { data: [], error: null },
        fmv_current: { data: [], error: null },
      },
      "editions",
    )

    const res = await GET(req(`?wallet=${WALLET}&collection=nfl-all-day`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, enriched: 4 })
    expect(fmvWrites(spy)).toEqual([])
  })

  it("skips Step 6b entirely when no enrichment landed (every wmc update errored)", async () => {
    const spy = install({
      // Diff read, then every enrichment update fails -> enrichedKeysById stays empty.
      wallet_moments_cache: [
        { data: [], error: null },
        { data: null, error: { message: "wmc update rejected" } },
      ],
      moment_acquisitions: { data: [], error: null },
      editions: { data: [{ id: "ed-low", external_id: "K-LOW" }], error: null },
      fmv_current: {
        data: [{ edition_id: "ed-low", fmv_usd: 25, confidence: "HIGH", sales_count_30d: 9 }],
        error: null,
      },
    })

    const res = await GET(req(`?wallet=${WALLET}&collection=nfl-all-day`))
    expect((await res.json()).enriched).toBe(0)
    expect(fmvWrites(spy)).toEqual([])
  })

  it("does NOT run for Top Shot — that collection's FMV is owned by wallet-search", async () => {
    fetchMock = installFetchMock([
      jsonRoute("public-api.nbatopshot.com", {
        data: { getMintedMoment: { data: { flowId: "201", tier: "COMMON", isLocked: false } } },
      }),
    ])
    const spy = install({
      wallet_moments_cache: WMC_ALL_NEW,
      moment_acquisitions: { data: [], error: null },
      editions: { data: [], error: null },
      fmv_current: {
        data: [{ edition_id: "ed-low", fmv_usd: 25, confidence: "HIGH", sales_count_30d: 9 }],
        error: null,
      },
    })

    const res = await GET(req(`?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    expect(fmvWrites(spy)).toEqual([])
  })
})

describe("cache-refresh — TopShot GQL enrichment degradation", () => {
  // fetchMomentGql failures must never fail the refresh: the moment still gets
  // its on-chain metadata, just without the isLocked / tier overlay.
  beforeEach(() => {
    state.ownedIds = ["301"]
    state.metadataById = {
      "301": { player: "P", setName: "S", series: "5", serial: "7", playID: "45", setID: "3", tier: "" },
    }
  })

  const wmcNew: Fixtures[string] = [
    { data: [], error: null },
    { data: null, error: null },
  ]

  function lockedFlag(spy: ReturnType<typeof install>) {
    return (spy.writes.wallet_moments_cache ?? [])
      .filter((w) => w.method === "update")
      .flatMap((w) => w.rows)
      .find((r) => "edition_key" in r)?.is_locked
  }

  it("treats a non-2xx GQL response as no overlay", async () => {
    fetchMock = installFetchMock([
      jsonRoute("public-api.nbatopshot.com", { error: "upstream" }, { status: 503 }),
    ])
    const spy = install({
      wallet_moments_cache: wmcNew,
      moment_acquisitions: { data: [], error: null },
      editions: { data: [], error: null },
    })
    expect((await (await GET(req(`?wallet=${WALLET}`))).json()).enriched).toBe(1)
    expect(lockedFlag(spy)).toBe(false)
  })

  it("treats a 200 with an empty getMintedMoment as no overlay", async () => {
    fetchMock = installFetchMock([
      jsonRoute("public-api.nbatopshot.com", { data: { getMintedMoment: null } }),
    ])
    const spy = install({
      wallet_moments_cache: wmcNew,
      moment_acquisitions: { data: [], error: null },
      editions: { data: [], error: null },
    })
    expect((await (await GET(req(`?wallet=${WALLET}`))).json()).enriched).toBe(1)
    expect(lockedFlag(spy)).toBe(false)
  })

  it("treats a thrown fetch as no overlay", async () => {
    fetchMock = installFetchMock([]) // unmatched -> the harness throws
    const spy = install({
      wallet_moments_cache: wmcNew,
      moment_acquisitions: { data: [], error: null },
      editions: { data: [], error: null },
    })
    expect((await (await GET(req(`?wallet=${WALLET}`))).json()).enriched).toBe(1)
    expect(lockedFlag(spy)).toBe(false)
  })
})
