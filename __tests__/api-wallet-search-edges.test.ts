import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// The wallet-search legs the sibling deep test doesn't reach — all of them
// "quietly wrong" failure modes rather than loud ones:
//
//   - the LEAGUE FILTER, which intersects the on-chain id set with wmc rows.
//     It pages with .range() because PostgREST clamps a bare .limit() at 1,000
//     and a whale can own more than that in one league — a clamp here hides
//     moments the collector actually owns. On a page error the filter must be
//     abandoned entirely (show everything) rather than render a false-empty
//     wallet from a transient DB blip.
//   - the FMV play_id_onchain FALLBACK for numeric edition keys that don't
//     match a UUID-format editions.external_id, including its re-application of
//     the same >$10K sanity ceiling as the primary lookup (a fallback that
//     skipped the ceiling would be a hole straight through it).
//   - the SALES-BACKFILL second pass: moments whose GQL carried no
//     lastPurchasePrice get cost basis from the most recent sale of that
//     nft_id, written as source=sales_backfill and never clobbering an
//     existing row (ignoreDuplicates).
//   - the AllDay owned-ids path, the non-Top-Shot collection dispatches, the
//     acquisition-stats arms, and the request-schema 400s.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as number[],
  metadataById: {} as Record<string, Record<string, string>>,
  gqlById: {} as Record<string, unknown>,
  ownedIdsError: null as Error | null,
}))

// wallet-search defers the Golazos backfill trigger with after() (2026-10-10);
// outside a request scope the real one throws, so run it on a microtask.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => unknown) => { void Promise.resolve().then(fn).catch(() => {}) } }
})
vi.mock("@/lib/cache", () => ({
  getOrSetCache: (_key: string, _ttl: number, fn: () => unknown) => fn(),
}))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (arg: unknown, t: unknown) => unknown[] }) => {
      if (opts.cadence.includes("getIDs")) {
        if (state.ownedIdsError) throw state.ownedIdsError
        return state.ownedIds
      }
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
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: { id: string }) =>
    state.gqlById[vars.id] ?? { getMintedMoment: { data: null } },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => ({ found: false }),
}))

const { POST } = await import("@/app/api/wallet-search/route")

const WALLET = "0xbd94cade097e50ac"
const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const post = (body: Record<string, unknown>) =>
  new NextRequest("https://t/api/wallet-search", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })

function momentMeta(serial: string): Record<string, string> {
  return { player: "Damian Lillard", team: "POR", setName: "Base Set", series: "5", serial, mint: "15000", playID: "45", setID: "3" }
}

function momentGql(flowId: string, serial: string, over: Record<string, unknown> = {}) {
  return {
    getMintedMoment: {
      data: {
        flowId,
        flowSerialNumber: serial,
        tier: "TIER_COMMON",
        forSale: true,
        price: "12.5",
        lastPurchasePrice: "8",
        isLocked: false,
        createdAt: "2026-01-01T00:00:00Z",
        badges: [],
        set: { id: "3", leagues: ["NBA"] },
        play: { id: "45", stats: { jerseyNumber: "0" } },
        topshotScore: { score: 100 },
        ...over,
      },
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

/** editions reads in order: [0] batch upsert ack, [1] key resolve, [2] the
 *  play_id_onchain fallback, [3+] the wmc canonical-key lookup. */
function baseFixtures(over: Fixtures = {}): Fixtures {
  return {
    collections: { data: { id: TS_UUID }, error: null },
    editions: [
      { data: null, error: null },
      { data: [{ id: "uuid-ed-1", external_id: "3:45" }], error: null },
    ],
    cached_listings: { data: [], error: null },
    "rpc:get_editions_latest_fmv_wide": { data: [], error: null },
    wallet_moments_cache: { data: [], error: null },
    moment_acquisitions: { data: null, error: null },
    sales: { data: [], error: null },
    "rpc:get_wallet_acquisition_data_scoped": { data: [], error: null },
    "rpc:get_acquisition_stats": { data: [], error: null },
    ...over,
  }
}

/** Let the route's fire-and-forget tails run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.ownedIds = [101, 102]
  state.metadataById = { "101": momentMeta("5"), "102": momentMeta("777") }
  state.gqlById = { "101": momentGql("flow-101", "5"), "102": momentGql("flow-102", "777") }
  state.ownedIdsError = null
})

describe("wallet-search — a wallet we CANNOT read must not be told to retry", () => {
  // ⛔ Measured in production 2026-09-14: the unpaginated getIDs() blows Flow's
  // per-script computation limit on a large enough collection (Top Shot used
  // 100,134 and All Day 217,993 against a limit of 100,000). That ceiling is a
  // property of the wallet's SIZE and the script, so it is DETERMINISTIC — and
  // the old copy said "Please try again", inviting a retry that can never
  // succeed. The wallet the error named has zero rows in wallet_moments_cache
  // across every collection: it is invisible to the platform, permanently.
  //
  // ⭐ The plumbing was already honest (500 + an explicit error, never a silent
  // empty wallet). The CLAIM was the defect, which is why this asserts the
  // WORDING and not the status code.
  const computationLimit = () =>
    new Error(
      "Invalid Flow argument: ... [Error Code: 1110] computation error: " +
        "[Error Code: 1110] computation limit exceeded (used: 100134, limit: 100000)",
    )

  it("says WE cannot read it in one pass, and does not promise a retry will help", async () => {
    install(baseFixtures())
    state.ownedIdsError = computationLimit()

    const res = await POST(post({ input: WALLET }))
    const body = await res.json()

    // Still a loud failure — never an empty wallet.
    expect(res.status).toBe(500)
    expect(body.rows).toEqual([])
    expect(body.summary.totalMoments).toBe(0)

    // ⭐ Assert the ABSENCE of the false claim, not merely the presence of copy.
    expect(String(body.error)).not.toMatch(/please try again/i)
    expect(String(body.error)).toMatch(/could not read this wallet|one pass/i)
    // ⛔ And it must NOT assert a CAUSE. "too many moments" was the first version
    // of this copy and is measurably false: a 39,955-moment wallet succeeds while
    // the failing one goes through TopShotShardedCollection. Size is not the trigger.
    expect(String(body.error)).not.toMatch(/too many moments|too large|too big/i)
    expect(String(body.error)).toMatch(/retrying will not help/i)
  })

  it("still says 'try again' for an ordinary transient failure — the control", async () => {
    // Without this, the test above would pass just as well if the route had been
    // changed to print the new message for EVERY failure, which would swap one
    // false claim for another.
    install(baseFixtures())
    state.ownedIdsError = new Error("socket hang up")

    const body = await (await POST(post({ input: WALLET }))).json()
    expect(String(body.error)).toMatch(/please try again/i)
    expect(String(body.error)).not.toMatch(/retrying will not help/i)
  })

  it("logs the known computation-limit case as ONE warn line, not the multi-KB trace as an error (#138)", async () => {
    // 2026-11-03: #138 closed by decision (no mega-wallet id source); the full Flow trace logged as
    // an ERROR kept a permanent, already-triaged group at the top of every runtime-error read.
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      install(baseFixtures())
      state.ownedIdsError = computationLimit()
      const res = await POST(post({ input: WALLET }))
      expect(res.status).toBe(500)
      const errLines = err.mock.calls.map((c) => c.join(" "))
      expect(errLines.some((l) => /fetch owned IDs|computation limit/i.test(l))).toBe(false)
      const warnLines = warn.mock.calls.map((c) => c.join(" "))
      expect(warnLines.some((l) => /computation limit/i.test(l) && /#138/.test(l))).toBe(true)
      // the warn carries no trace payload
      expect(warnLines.join(" ")).not.toMatch(/used: 100134/)
    } finally {
      err.mockRestore()
      warn.mockRestore()
    }
  })

  it("every OTHER owned-id failure still logs its full detail as an error — the control", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      install(baseFixtures())
      state.ownedIdsError = new Error("socket hang up")
      await POST(post({ input: WALLET }))
      const errLines = err.mock.calls.map((c) => c.join(" "))
      expect(errLines.some((l) => /fetch owned IDs/.test(l) && /socket hang up/.test(l))).toBe(true)
    } finally {
      err.mockRestore()
    }
  })
})

describe("wallet-search — request dispatch", () => {
  it("400s a body with no input and a body that fails the schema", async () => {
    install(baseFixtures())
    expect((await POST(post({}))).status).toBe(400)
    const res = await POST(post({ input: WALLET, limit: -5 }))
    expect(res.status).toBe(400)
    expect((await res.json()).rows).toEqual([])
  })

  it("redirects UFC to its own scan route and serves Golazos from wmc (no stale 'coming soon')", async () => {
    install(baseFixtures())
    const ufc = await POST(post({ input: WALLET, collection: "ufc" }))
    expect(ufc.status).toBe(400)
    expect((await ufc.json()).redirect).toBe("/api/ufc-wallet-scan")

    // Golazos now reads wallet_moments_cache via get_wallet_moments_with_fmv
    // (empty under the base fixture's default rpc result) rather than returning
    // the old "coming soon" stub.
    const gol = await POST(post({ input: WALLET, collection: "laliga-golazos" }))
    expect(gol.status).toBe(200)
    const body = await gol.json()
    expect(Array.isArray(body.rows)).toBe(true)
    expect(JSON.stringify(body)).not.toContain("coming soon")
  })

  it("walks the AllDay collection through its own owned-ids script", async () => {
    install(baseFixtures())
    const res = await POST(post({ input: WALLET, collection: "nfl-all-day" }))
    expect(res.status).toBe(200)
    expect((await res.json()).summary.totalMoments).toBe(2)
  })
})

describe("wallet-search — league filter", () => {
  it("intersects the on-chain ids with the wmc league rows", async () => {
    install(
      baseFixtures({
        wallet_moments_cache: {
          data: [{ moment_id: "101", league: "NBA" }, { moment_id: "102", league: "WNBA" }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(1)
    expect(body.rows.map((r: { momentId: string }) => r.momentId)).toEqual(["101"])
  })

  // 2026-10-31: the walk read only `league = <pill>` rows, so an owned moment
  // with NO classified wmc row (a never-walked wallet; this route caches only the
  // page it served) was dropped, and a first search answered "0 NBA moments".
  // Absence of a row is not membership of the other league.
  it("does not answer 0 for a wallet whose owned moments have no classified wmc row", async () => {
    install(baseFixtures({ wallet_moments_cache: { data: [], error: null } }))
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).not.toBe(0)
    expect(body.summary.totalMoments).toBe(2) // unfiltered, like a read error
  })

  it("skips the filter when even ONE owned moment is unclassified (never a partial-filtered wallet)", async () => {
    install(baseFixtures({ wallet_moments_cache: { data: [{ moment_id: "101", league: "WNBA" }], error: null } }))
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(2)
  })

  it("still filters to 0 when every owned moment is classified into the OTHER league — the control", async () => {
    // Without this the two tests above would pass just as well if the filter
    // had been switched off entirely.
    install(
      baseFixtures({
        wallet_moments_cache: {
          data: [{ moment_id: "101", league: "WNBA" }, { moment_id: "102", league: "WNBA" }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(0)
  })

  it("runs the metadata fill for the wallet after caching its rows, so they get a league", async () => {
    const spy = install(baseFixtures({ "rpc:backfill_wmc_metadata_from_editions": { data: 2, error: null } }))
    await POST(post({ input: WALLET }))
    await flush()
    await flush()
    const calls = spy.rpcCalls.filter((c) => c.name === "backfill_wmc_metadata_from_editions")
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual({ p_wallet_address: WALLET, p_collection_id: TS_UUID })
  })

  // 2026-10-31: a wallet whose wmc rows cover fewer moments than it owns (a
  // search caches only its page) queues the Top Shot walk — capped, and never
  // on an unreadable count.
  describe("Top Shot backfill trigger", () => {
    const dispatches = (f: ReturnType<typeof vi.fn>) =>
      f.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith("/api/wallet-backfill"))
    const run = async (wmcCount: { count?: number | null; error?: unknown }) => {
      process.env.INGEST_SECRET_TOKEN = "t"
      const fetchSpy = vi.fn(async () => new Response("{}"))
      vi.stubGlobal("fetch", fetchSpy)
      try {
        install(baseFixtures({ wallet_moments_cache: [{ data: null, error: null, ...wmcCount }, { data: [], error: null }] }))
        await POST(post({ input: WALLET }))
        for (let i = 0; i < 5; i++) await flush()
        return { fetchSpy }
      } finally {
        vi.unstubAllGlobals()
        delete process.env.INGEST_SECRET_TOKEN
      }
    }

    it("dispatches the walk for a wallet the cache covers only partly", async () => {
      const { fetchSpy } = await run({ count: 1 }) // owns 2
      const d = dispatches(fetchSpy)
      expect(d).toHaveLength(1)
      expect(JSON.parse((d[0][1] as RequestInit).body as string)).toEqual({ wallet: WALLET })
    })

    it("control: a fully cached wallet dispatches nothing", async () => {
      expect(dispatches((await run({ count: 2 })).fetchSpy)).toHaveLength(0)
    })

    it("an unreadable wmc count dispatches nothing (fail closed)", async () => {
      expect(dispatches((await run({ error: { message: "timeout" } })).fetchSpy)).toHaveLength(0)
      expect(dispatches((await run({ count: null })).fetchSpy)).toHaveLength(0)
    })
  })

  it("pages past the PostgREST 1000-row clamp instead of truncating the allowed set", async () => {
    // A full first page forces a second .range() window; without paging the
    // second page's moment would be filtered out of a wallet that owns it.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ moment_id: String(900000 + i), league: "NBA" }))
    const spy = install(
      baseFixtures({
        wallet_moments_cache: [
          { data: page1, error: null },
          { data: [{ moment_id: "101", league: "WNBA" }, { moment_id: "102", league: "NBA" }], error: null },
          { data: [], error: null },
        ],
      }),
    )
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(1)
    expect(body.rows[0].momentId).toBe("102")
    expect(spy).toBeTruthy()
  })

  // 2026-10-10: the 60,000-row ceiling sits below the largest Top Shot wallet
  // (61,512). Leaving the walk with every page full made `allowed` a PREFIX,
  // and filtering on it hid owned moments. That exit now skips the filter.
  it("abandons the filter when the league walk hits its read ceiling (never a prefix-filtered wallet)", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ moment_id: String(800000 + i) }))
    install(baseFixtures({ wallet_moments_cache: { data: fullPage, error: null } }))
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(2) // unfiltered, not 0
  })

  it("abandons the filter on a page error rather than showing a false-empty wallet", async () => {
    install(baseFixtures({ wallet_moments_cache: { data: null, error: { message: "wmc timeout" } } }))
    const body = await (await POST(post({ input: WALLET, league: "NBA" }))).json()
    expect(body.summary.totalMoments).toBe(2) // unfiltered
  })
})

describe("wallet-search — FMV fallback + ceiling", () => {
  // RE-PINNED 2026-11-07: the fallback matches (set, play), never play alone — the
  // fixture now carries the edition's set id, as every Top Shot edition with a
  // play id does (0 without one, read 11-07).
  it("resolves FMV through play_id_onchain when the numeric edition key does not match", async () => {
    install(
      baseFixtures({
        editions: [
          { data: null, error: null }, // batch upsert
          { data: [], error: null }, // key resolve finds nothing
          { data: [{ id: "uuid-fb", set_id_onchain: 3, play_id_onchain: 45 }], error: null }, // fallback
        ],
        "rpc:get_editions_latest_fmv_wide": {
          data: [{ edition_id: "uuid-fb", fmv_usd: 33.25, confidence: "MEDIUM", sales_count_30d: 2, computed_at: "2026-07-20T00:00:00Z" }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmv).toBe(33.25)
    expect(body.rows[0].marketConfidence).toBe("medium")
  })

  // 2026-11-07 review: the play-only fallback kept whichever row came LAST for a
  // play id — another SET's (306 Top Shot plays span sets) or another
  // collection's edition — and wrote its FMV into the cache.
  it("⛔ the fallback never prices a moment from ANOTHER set's edition that shares its play id", async () => {
    install(
      baseFixtures({
        editions: [
          { data: null, error: null },
          { data: [], error: null },
          { data: [{ id: "uuid-other-set", set_id_onchain: 99, play_id_onchain: 45 }], error: null },
        ],
        "rpc:get_editions_latest_fmv_wide": {
          data: [{ edition_id: "uuid-other-set", fmv_usd: 77, confidence: "HIGH", sales_count_30d: 9, computed_at: "2026-07-20T00:00:00Z" }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmv).not.toBe(77)
  })

  it("a FAILED edition-resolve read marks the rows fmvReadFailed (never a silent null that nulls the cache)", async () => {
    install(
      baseFixtures({
        editions: [
          { data: null, error: null },
          { data: null, error: { message: "canceling statement due to statement timeout" } },
          { data: [], error: null },
        ],
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmvReadFailed).toBe(true)
  })

  it("an UPPERCASE address is case-folded — one wallet, one set of cache rows (2026-11-07 review)", async () => {
    install(baseFixtures())
    const body = await (await POST(post({ input: WALLET.toUpperCase().replace("0X", "0x") }))).json()
    expect(body.walletAddress).toBe(WALLET)
  })

  it("totalTssPoints is null, not a measured 0, when no row carries a TSS figure (2026-11-07 review)", async () => {
    install(baseFixtures())
    state.gqlById = {} // every row degraded → no measured TSS
    const body = await (await POST(post({ input: WALLET }))).json()
    const measured = (body.rows as Array<{ tssPoints?: number | null }>).filter((r) => typeof r.tssPoints === "number")
    expect(measured).toHaveLength(0) // the case under test: nothing measured
    expect(body.summary.totalTssPoints).toBeNull()
  })

  it("re-applies the >$10K ceiling on the fallback path, so it is not a hole through the guard", async () => {
    install(
      baseFixtures({
        editions: [
          { data: null, error: null },
          { data: [], error: null },
          { data: [{ id: "uuid-fb", set_id_onchain: 3, play_id_onchain: 45 }], error: null },
        ],
        "rpc:get_editions_latest_fmv_wide": {
          // Over the ceiling on two sales -> discarded, exactly as the primary
          // lookup would discard it.
          data: [{ edition_id: "uuid-fb", fmv_usd: 900000, confidence: "HIGH", sales_count_30d: 2, computed_at: "2026-07-20T00:00:00Z" }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.rows[0].fmv).toBeNull()
  })

  it("keeps the wallet alive when the fallback lookup throws", async () => {
    const spy = makeInstrumentedSupabaseFixture(baseFixtures({ editions: [{ data: null, error: null }, { data: [], error: null }] }))
    const baseFrom = (spy.fixture as { from: (t: string) => unknown }).from.bind(spy.fixture)
    let editionsReads = 0
    ;(spy.fixture as { from: (t: string) => unknown }).from = (t: string) => {
      if (t !== "editions" || ++editionsReads < 3) return baseFrom(t)
      const b: unknown = new Proxy({}, {
        get: (_x, prop) => {
          if (prop === "then") {
            return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
              Promise.reject(new Error("fallback read exploded")).then(onF, onR)
          }
          return () => b
        },
      })
      return b
    }
    state.sb = spy.fixture

    const res = await POST(post({ input: WALLET }))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toHaveLength(2)
  })
})

describe("wallet-search — cost-basis tails", () => {
  it("backfills cost basis from the most recent sale when GQL carried no purchase price", async () => {
    state.gqlById = {
      "101": momentGql("flow-101", "5", { lastPurchasePrice: "0" }),
      "102": momentGql("flow-102", "777", { lastPurchasePrice: "0" }),
    }
    const spy = install(
      baseFixtures({
        sales: {
          data: [
            { nft_id: "101", price_usd: 14.5, sold_at: "2026-06-01T00:00:00Z", seller_address: "0xseller", transaction_hash: "0xtx" },
            // An older sale of the same moment must lose to the newest one.
            { nft_id: "101", price_usd: 99, sold_at: "2025-01-01T00:00:00Z", seller_address: "0xold", transaction_hash: "0xold" },
          ],
          error: null,
        },
      }),
    )

    await POST(post({ input: WALLET }))
    await flush()

    const backfill = (spy.writes.moment_acquisitions ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
      .filter((r) => r.source === "sales_backfill")
    expect(backfill).toHaveLength(1)
    expect(backfill[0]).toMatchObject({
      nft_id: "101",
      wallet: WALLET,
      buy_price: 14.5,
      seller_address: "0xseller",
      transaction_hash: "0xtx",
    })
  })

  it("caches Top Shot's on-chain Series 1 (= 0) as series_number 0, not NULL", async () => {
    // 2026-09-24: `Number(r.series) || null` wrote NULL for every Series 1
    // moment, and the metadata self-heal never filled series_number, so the
    // share card / analyzer counted them as "No series". An empty string (the
    // Cadence script's "no seriesNumber" value) still stores NULL.
    state.gqlById = { "101": momentGql("flow-101", "5"), "102": momentGql("flow-102", "6") }
    state.ownedIds = [101, 102]
    state.metadataById = {
      "101": { ...momentMeta("5"), series: "0" },
      "102": { ...momentMeta("6"), series: "" },
    }
    const spy = install(baseFixtures({ sales: { data: [], error: null } }))

    await POST(post({ input: WALLET }))
    await flush()

    const cached = (spy.writes.wallet_moments_cache ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    const byMoment = Object.fromEntries(cached.map((r) => [String(r.moment_id), r.series_number]))
    expect(byMoment["101"]).toBe(0)
    expect(byMoment["102"]).toBeNull()
  })

  it("writes nothing when there are no sales for the unpriced moments", async () => {
    state.gqlById = { "101": momentGql("flow-101", "5", { lastPurchasePrice: "0" }) }
    state.ownedIds = [101]
    state.metadataById = { "101": momentMeta("5") }
    const spy = install(baseFixtures({ sales: { data: [], error: null } }))

    await POST(post({ input: WALLET }))
    await flush()

    const backfill = (spy.writes.moment_acquisitions ?? [])
      .flatMap((w) => w.rows)
      .filter((r) => r.source === "sales_backfill")
    expect(backfill).toHaveLength(0)
  })

  it("reports acquisition stats from the RPC and degrades to null when it errors", async () => {
    install(
      baseFixtures({
        "rpc:get_acquisition_stats": {
          data: [{ breakdown: [{ method: "pack_pull", count: 3 }, { method: "not_a_method", count: 9 }], total_moments: 4, total_spent: 12, locked_count: 1 }],
          error: null,
        },
      }),
    )
    const body = await (await POST(post({ input: WALLET }))).json()
    expect(body.acquisitionStats).toMatchObject({
      pack_pull_count: 3,
      marketplace_count: 0, // an unknown method is ignored, not counted
      total_count: 4,
      locked_count: 1,
      total_spent: 12,
    })

    install(baseFixtures({ "rpc:get_acquisition_stats": { data: null, error: { message: "stats down" } } }))
    const errBody = await (await POST(post({ input: WALLET }))).json()
    expect(errBody.acquisitionStats).toBeNull()
  })
})

// 2026-11-02: a degraded read must never overwrite a cached moment.
describe("wallet-search cache write — degraded reads are not persisted over cached values", () => {
  const wmcUpserts = (spy: ReturnType<typeof install>) =>
    (spy.writes.wallet_moments_cache ?? []).filter((w) => w.method === "upsert")

  it("a moment whose enrichment FAILED is written insert-only even with a recovered set:play key", async () => {
    state.ownedIds = [101]
    state.metadataById = {} // the Flow metadata leg throws → the degraded fallback row
    state.gqlById = { "101": momentGql("flow-101", "5") } // GraphQL still yields setID/playID
    const spy = install(baseFixtures())

    await POST(post({ input: WALLET }))
    await flush()

    const ups = wmcUpserts(spy)
    const merge = ups.filter((w) => !w.options?.ignoreDuplicates).flatMap((w) => w.rows)
    const insertOnly = ups.filter((w) => w.options?.ignoreDuplicates === true).flatMap((w) => w.rows)
    expect(merge.some((r) => String(r.moment_id) === "101")).toBe(false)
    const row = insertOnly.find((r) => String(r.moment_id) === "101")
    expect(row).toBeDefined()
    // the display sentinels are never stored as names
    expect(row!.set_name).toBeNull()
    expect(row!.player_name).toBeNull()
  })

  it("when the FMV read FAILS, the merge write leaves fmv_usd out instead of writing NULL", async () => {
    const spy = install(
      baseFixtures({ "rpc:get_editions_latest_fmv_wide": { data: null, error: { message: "fmv down" } } }),
    )

    await POST(post({ input: WALLET }))
    await flush()

    const merge = wmcUpserts(spy).filter((w) => !w.options?.ignoreDuplicates).flatMap((w) => w.rows)
    expect(merge.length).toBeGreaterThan(0)
    expect(merge.every((r) => !("fmv_usd" in r))).toBe(true)
  })

  it("no-change control: a healthy FMV read still writes fmv_usd on the merge rows", async () => {
    const spy = install(baseFixtures())
    await POST(post({ input: WALLET }))
    await flush()
    const merge = wmcUpserts(spy).filter((w) => !w.options?.ignoreDuplicates).flatMap((w) => w.rows)
    expect(merge.length).toBeGreaterThan(0)
    expect(merge.every((r) => "fmv_usd" in r)).toBe(true)
  })
})
