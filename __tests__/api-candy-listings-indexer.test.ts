import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of GET/POST /api/candy-listings-indexer — the Candy (Solana / Magic
// Eden) secondary-LISTINGS (ask) indexer. The sweep runs inside after(). We mock
// the two Solana seams (@/lib/chains/solana/das solUsd, @/lib/chains/solana/normalize
// consts + candyMeSymbolReady) so the ME-listings -> wmc/edition resolution ->
// candy_listings upsert -> deactivation ladder runs unmodified. Pinned:
//   - auth: no token -> 401, defers nothing;
//   - discovery gate: while candyMeSymbolReady() is false the route 202s
//     discovery_pending and logs skip_reason WITHOUT running after();
//   - happy ask: exact candy_listings row (USD from price*rate, is_active true,
//     edition resolved via wmc->editions), sweep_complete true (a short page ends
//     the sweep so deactivation runs), log ok=true with found/upserted=1;
//   - skips: a price<=0 listing is dropped before any wmc lookup, and a non-Candy
//     mint (wmc miss) is dropped — neither is found/upserted;
//   - a fatal ME listings error logs ok=false with the HTTP message.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  ready: true,
  rate: 150 as number | null,
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
vi.mock("@/lib/chains/solana/das", () => ({
  solUsd: async () => state.rate,
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_ME_SYMBOL: "candy-mlb-icons",
  CANDY_MLB_SLUG: "candy_mlb",
  CANDY_MLB_UUID: "209ade70-32c5-4470-bc7c-4793d660f713",
  candyMeSymbolReady: () => state.ready,
}))

process.env.INGEST_SECRET_TOKEN = "candy-token"
const { GET, POST } = await import("@/app/api/candy-listings-indexer/route")

const CANDY_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"

interface MeListing {
  pdaAddress?: string
  tokenMint?: string
  seller?: string
  auctionHouse?: string
  price?: number
  tokenSize?: number
  expiry?: number
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/candy-listings-indexer", {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer candy-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function logRun(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "candy-token"
  state.afterCbs.length = 0
  state.ready = true
  state.rate = 150
})

describe("candy-listings-indexer — discovery gate + auth", () => {
  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/candy-listings-indexer", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("202s discovery_pending (no after() sweep) while the ME symbol is not ready", async () => {
    state.ready = false
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: false, skipped: "discovery_pending", collection: "candy_mlb" })
    expect(state.afterCbs).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "candy_mlb" })
    expect((log?.p_extra as Record<string, unknown>).skip_reason).toBe("discovery_pending")
  })
})

describe("candy-listings-indexer — sweep ladder", () => {
  it("upserts an exact USD candy_listings row for a resolvable Candy ask + logs a complete sweep", async () => {
    const listings: MeListing[] = [
      // price<=0 is dropped BEFORE any wmc lookup (guard branch).
      { pdaAddress: "pda0", tokenMint: "mint0", price: 0 },
      { pdaAddress: "pda1", tokenMint: "mint1", price: 0.5, seller: "0xsell", auctionHouse: "ah", tokenSize: 1, expiry: 0 },
    ]
    fetchMock = installFetchMock([jsonRoute("/listings", listings), jsonRoute("/activities", [])])
    const spy = install({
      wallet_moments_cache: { data: [{ moment_id: "mint1", edition_key: "candy-mlb:trout" }], error: null },
      editions: { data: [{ id: "ed-trout", external_id: "candy-mlb:trout" }], error: null },
      // upsert (error null) -> deactivation update (data []) -> expiry update (data []).
      candy_listings: [{ error: null }, { data: [] }, { data: [] }],
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: true, collection: "candy_mlb" })
    await runDeferred()

    const upsert = (spy.writes.candy_listings ?? []).find((w) => w.method === "upsert")
    expect(upsert?.rows).toHaveLength(1)
    expect(upsert?.rows[0]).toMatchObject({
      pda_address: "pda1",
      token_mint: "mint1",
      edition_id: "ed-trout",
      collection_id: CANDY_UUID,
      seller: "0xsell",
      auction_house: "ah",
      price_sol: 0.5,
      price_usd: 75, // 0.5 SOL * 150
      token_size: 1,
      expiry: null, // expiry 0 -> null
      is_active: true,
    })

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 1, // the price<=0 listing excluded
      p_rows_written: 1,
      p_collection_slug: "candy_mlb",
    })
    expect((log?.p_extra as Record<string, unknown>).sweep_complete).toBe(true)
    expect((log?.p_extra as Record<string, unknown>).sol_usd).toBe(150)
  })

  it("drops a non-Candy mint (wmc miss) — nothing found or upserted", async () => {
    const listings: MeListing[] = [
      { pdaAddress: "pdaX", tokenMint: "mintX", price: 1.2 },
    ]
    fetchMock = installFetchMock([jsonRoute("/listings", listings), jsonRoute("/activities", [])])
    const spy = install({
      wallet_moments_cache: { data: [], error: null }, // not a Candy mint
      candy_listings: [{ data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    expect((spy.writes.candy_listings ?? []).some((w) => w.method === "upsert")).toBe(false)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
  })

  it("a fatal ME listings error logs ok=false with the HTTP message", async () => {
    fetchMock = installFetchMock([jsonRoute("/listings", { error: "boom" }, { status: 500, ok: false }), jsonRoute("/activities", [])])
    const spy = install({})

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("ME listings HTTP 500")
  })

  it("GET is a supported entrypoint (same sweep as POST)", async () => {
    const res = await GET(new NextRequest("https://t/api/candy-listings-indexer", { method: "GET" }))
    expect(res.status).toBe(401) // no auth header -> 401, exercises the GET export
  })
})

// ---------------------------------------------------------------------------
// Evidence-based deactivation (rewritten 2026-07-27, after a live incident).
//
// The original rule was "any active row this sweep did not see is dead", which
// is only sound if the sweep is a census. Magic Eden's listings endpoint is not
// one: it answered 420 for this collection at 21:38Z, SEVEN at 00:35Z and 22 at
// 03:35Z, while the chain showed only 6 delists and 8 sales in that window. The
// 00:35Z tick deactivated 419 standing asks and collapsed candy_listing_floor
// to 7 rows. A ratio guard was tried and was ALSO not enough — after one bad
// tick the "book we already hold" that a ratio compares against is itself the
// damaged number.
//
// So a listing is only deactivated on POSITIVE evidence: an explicit `delist`
// or a fill in the activities feed, or its own expiry.
// ---------------------------------------------------------------------------
describe("candy-listings-indexer — mint resolution is BATCHED per page, not per listing", () => {
  // 🚨 WHY THIS IS PINNED. This sweep's cost is ROUND-TRIP COUNT, not query cost.
  // Each wmc probe is an Index Only Scan at ~1.4ms / 3 buffers — cheap — but
  // issued one-per-listing it became ~1,600 SEQUENTIAL Vercel→Supabase round
  // trips. Measured: every successful run on record took 375–391s against a 300s
  // maxDuration, i.e. over budget by design, which is why terminal rows were rare
  // and the PUBLIC /insights/candy-mlb board went 44 h stale.
  //
  // ⚠ Nothing else can catch a regression here. Reverting to per-listing lookups
  // keeps every other test green — the DATA is identical, only the number of
  // trips changes — so this counts the trips directly. A correctness test cannot
  // see a performance contract.
  it("issues ONE wallet_moments_cache query for a whole page of distinct mints", async () => {
    const N = 25
    const listings: MeListing[] = Array.from({ length: N }, (_, i) => ({
      pdaAddress: `pda${i}`,
      tokenMint: `mint${i}`,
      price: 1 + i,
    }))
    fetchMock = installFetchMock([jsonRoute("/listings", listings), jsonRoute("/activities", [])])
    const spy = install({
      wallet_moments_cache: { data: [], error: null }, // none are Candy cards
      candy_packs: { data: [], error: null },
      candy_listings: [{ data: [] }, { data: [] }],
    })

    // Count from() calls per table by wrapping the installed fixture.
    const fromCalls: Record<string, number> = {}
    const f = spy.fixture as { from: (t: string) => unknown }
    const baseFrom = f.from.bind(f)
    f.from = (t: string) => {
      fromCalls[t] = (fromCalls[t] ?? 0) + 1
      return baseFrom(t)
    }

    await POST(req())
    await runDeferred()

    // Not vacuous: the page really did carry N distinct mints.
    expect(listings.length).toBe(N)
    // One page → one wmc query. Per-listing resolution would make this N.
    expect(
      fromCalls["wallet_moments_cache"] ?? 0,
      `expected ONE batched wmc query for ${N} mints, got ${fromCalls["wallet_moments_cache"]} — ` +
        `resolution has regressed to per-listing round trips`,
    ).toBe(1)
    // Same contract for the sealed-pack fallback.
    expect(fromCalls["candy_packs"] ?? 0).toBeLessThanOrEqual(1)
  })
})

describe("candy-listings-indexer — every Magic Eden call is time-bounded", () => {
  // 🚨 WHY. `fetch()` has NO default timeout. Both ME calls were bare fetches, so
  // an upstream that accepts the connection and holds it open consumed the whole
  // 300s `maxDuration` — and a KILLED lambda writes no terminal `pipeline_runs`
  // row at all, so the failure was invisible and read as "the cron never fired".
  // Measured 2026-08-27: 15 invocation heartbeats in 48h, ONE terminal row, and a
  // Vercel `Task timed out after 300 seconds`, while the PUBLIC /insights/candy-mlb
  // board served asks 44 HOURS stale.
  //
  // ⚠ The property is asserted on the REQUEST INIT, not on the source text. A
  // source grep would be satisfied by the comment you are reading — this file's
  // sibling guard was enrolled in exactly that trap the same day.
  it("passes an abort signal on the listings AND activities requests", async () => {
    fetchMock = installFetchMock([jsonRoute("/listings", []), jsonRoute("/activities", [])])
    install({
      candy_listings: [{ data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    const meCalls = fetchMock.calls.filter((c) => /\/listings|\/activities/.test(c.url))
    // Not vacuous: if the sweep made no ME calls the loop below asserts nothing.
    expect(meCalls.length).toBeGreaterThan(0)
    const unbounded = meCalls.filter((c) => !c.init?.signal).map((c) => c.url)
    expect(
      unbounded,
      "every Magic Eden request must carry an AbortSignal — an unbounded one " +
        "consumes the entire 300s lambda budget and the tick dies unlogged",
    ).toEqual([])
  })

  it("the sweep still logs a terminal row when an ME call aborts", async () => {
    // The point of bounding the wait is that the failure becomes VISIBLE. An
    // abort must land in the after() catch and write ok=false — never vanish.
    fetchMock = installFetchMock([
      {
        match: (u) => /\/listings/.test(u),
        respond: () => {
          throw Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          })
        },
      },
      jsonRoute("/activities", []),
    ])
    const spy = install({ candy_listings: [{ data: [] }, { data: [] }] })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false })
    expect(String((log as Record<string, unknown>)?.p_error)).toMatch(/abort/i)
  })
})

describe("candy-listings-indexer — deactivation needs evidence, not absence", () => {
  it("does NOT deactivate an unseen ask when the feed returns nothing", async () => {
    fetchMock = installFetchMock([jsonRoute("/listings", []), jsonRoute("/activities", [])])
    const spy = install({
      candy_listings: [{ data: null, error: null, count: 426 }, { data: [] }],
      candy_pack_listings: [{ data: [] }],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    // A short answer is no longer dangerous — it just refreshes fewer prices.
    expect(log?.p_ok).toBe(true)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.raw_listings_seen).toBe(0)
    expect(extra.active_before).toBe(426)
    expect(extra.feed_looks_truncated).toBe(true)
    expect(extra.deactivated).toBe(0)
    // The only update issued is the expiry sweep — no mass-deactivation exists
    // any more, so 419 asks cannot be destroyed by one bad response.
    expect((spy.writes.candy_listings ?? []).filter((w) => w.method === "update")).toHaveLength(1)
  })

  it("DOES deactivate an ask whose mint shows a delist or a fill", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/listings", []),
      jsonRoute("/activities", [
        { type: "delist", tokenMint: "mintPulled", blockTime: 1_700_000_000 },
        { type: "buyNow", tokenMint: "mintSold", blockTime: 1_700_000_100 },
        // a bid does not end a listing
        { type: "bid", tokenMint: "mintStillListed", blockTime: 1_700_000_200 },
      ]),
    ])
    const spy = install({
      candy_listings: [
        { data: null, error: null, count: 30 }, // active-book count
        { data: [{ pda_address: "pdaPulled" }, { pda_address: "pdaSold" }] }, // evidence-based deactivate
        { data: [] }, // expiry
      ],
      candy_pack_listings: [{ data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    const extra = log?.p_extra as Record<string, unknown>
    // delist + buyNow only — the bid is not listing-ending.
    expect(extra.listing_ending_mints).toBe(2)
    expect(extra.deactivated).toBe(2)
  })

  it("deactivates NOTHING when the activities walk fails (no evidence, no action)", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/listings", [{ pdaAddress: "pda1", tokenMint: "mint1", price: 0.5 }]),
      jsonRoute("/activities", { error: "boom" }, { status: 500, ok: false }),
    ])
    const spy = install({
      wallet_moments_cache: { data: [{ moment_id: "mint1", edition_key: "candy-mlb:trout" }], error: null },
      editions: { data: [{ id: "ed-trout", external_id: "candy-mlb:trout" }], error: null },
      candy_listings: [{ error: null }, { data: null, error: null, count: 30 }, { data: [] }],
      candy_pack_listings: [{ data: [] }],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true) // the listings half still succeeded
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.listing_ending_mints).toBe(0)
    expect(extra.deactivated).toBe(0)
    // The ask it saw still lands.
    expect((spy.writes.candy_listings ?? []).some((w) => w.method === "upsert")).toBe(true)
  })
})

// Sealed-pack asks (added 2026-07-27). The wmc gate only knows CARD mints, so a
// pack ask was dropped here as "not a Candy mint" — RPC had a card floor and no
// pack floor at all, on a product whose packs trade at 3-4x retail. A wmc miss
// is now re-checked against candy_packs (filled by the daily DAS walk, so no
// extra Magic Eden call).
describe("candy-listings-indexer — sealed-pack asks", () => {
  it("captures a pack ask that the wmc card gate rejects", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/listings", [
        { pdaAddress: "pdaPack", tokenMint: "mintPack", price: 0.4, seller: "0xsell", expiry: 0 },
      ]), jsonRoute("/activities", []),
    ])
    const spy = install({
      wallet_moments_cache: { data: [], error: null }, // not a card
      candy_packs: { data: [{ token_mint: "mintPack" }], error: null }, // it IS a pack
      candy_pack_listings: [{ error: null }, { data: [] }],
      candy_listings: [{ data: null, error: null, count: 0 }, { data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    const upsert = (spy.writes.candy_pack_listings ?? []).find((w) => w.method === "upsert")
    expect(upsert?.rows).toHaveLength(1)
    expect(upsert?.rows[0]).toMatchObject({
      pda_address: "pdaPack",
      token_mint: "mintPack",
      price_sol: 0.4,
      price_usd: 60, // 0.4 SOL * 150
      is_active: true,
    })
    // A pack ask is NOT a card ask — it must never land in candy_listings.
    expect((spy.writes.candy_listings ?? []).some((w) => w.method === "upsert")).toBe(false)
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.pack_asks_upserted).toBe(1)
  })

  it("still drops a mint that is neither a card nor a pack", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/listings", [{ pdaAddress: "pdaX", tokenMint: "mintX", price: 1.2 }]), jsonRoute("/activities", []),
    ])
    const spy = install({
      wallet_moments_cache: { data: [], error: null },
      candy_packs: { data: [], error: null },
      candy_listings: [{ data: null, error: null, count: 0 }, { data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    // No pack ask upserted (the deactivation UPDATE still runs on a complete
    // sweep, which is correct — an unseen pack ask is a pulled pack ask).
    expect((spy.writes.candy_pack_listings ?? []).some((w) => w.method === "upsert")).toBe(false)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect((log?.p_extra as Record<string, unknown>).pack_asks_upserted).toBe(0)
  })
})


// ── INVOCATION HEARTBEAT ────────────────────────────────────────────────────
//
// Added 2026-08-20 alongside `lib/pipeline/heartbeat.ts`. This route HAD a
// heartbeat and no test for it, which is how its shape drifted from the other
// four copies unnoticed: it wrote through `log_pipeline_run`, whose missing
// `p_finished_at` let `duration_ms` (GENERATED from finished_at - started_at)
// publish the RPC call's own latency — measured live at up to 47,462 ms on this
// pipeline's markers.
//
// ⚠ These cases pin the row SHAPE and the fact that the marker precedes the
// work. They do NOT detect a maxDuration kill, and no vitest case can; the
// detection is a correlation query over `pipeline_runs`.
describe("candy-listings-indexer — invocation heartbeat", () => {
  const heartbeat = (spy: ReturnType<typeof install>) =>
    (spy.writes.pipeline_runs ?? [])
      .filter((w) => w.method === "insert")
      .flatMap((w) => w.rows)
      .find((r) => r.pipeline === "candy-listings-indexer-heartbeat")

  it("writes the marker under a SEPARATE pipeline name, never an extra own-name row", async () => {
    fetchMock = installFetchMock([jsonRoute("/listings", []), jsonRoute("/activities", [])])
    const spy = install({
      wallet_moments_cache: { data: [], error: null },
      candy_packs: { data: [], error: null },
      candy_listings: [{ data: null, error: null, count: 0 }, { data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    // ⚠ Load-bearing, not cosmetic: this pipeline is on
    // `pipeline_cadence_watchlist`, so a marker under the REAL name would
    // refresh `last_run` every tick and silence `detect_stalled_pipelines()` on
    // exactly the outage the marker exists to expose.
    const hb = heartbeat(spy)
    expect(hb, "no heartbeat row was written").toBeTruthy()
    expect(hb!.pipeline).not.toBe("candy-listings-indexer")
    expect(hb!.collection_slug).toBe("candy_mlb")
    expect((hb!.extra as Record<string, unknown>).phase).toBe("started")
  })

  it("leaves every rows_* column NULL and pins the duration to zero", async () => {
    fetchMock = installFetchMock([jsonRoute("/listings", []), jsonRoute("/activities", [])])
    const spy = install({
      wallet_moments_cache: { data: [], error: null },
      candy_packs: { data: [], error: null },
      candy_listings: [{ data: null, error: null, count: 0 }, { data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    const hb = heartbeat(spy)!
    // ⚠ NULL, not the column default 0. A marker measures nothing, so a 0 is a
    // number nobody read — the shape that made a live pipeline look inert in the
    // 2026-08-16 retirement sweep.
    expect(hb.rows_found).toBeNull()
    expect(hb.rows_written).toBeNull()
    expect(hb.rows_skipped).toBeNull()
    expect(hb.finished_at, "duration_ms is GENERATED from the pair").toBe(hb.started_at)
    expect(hb.ok, "a marker must not inflate v_pipeline_failure_rates").toBe(true)
  })

  it("an unauthorized request writes NO heartbeat — 'neither row' must keep meaning 'never reached'", async () => {
    const spy = install({})

    await POST(req({}))
    await runDeferred()

    // The three-state reading collapses if an unauthenticated probe can mint a
    // marker: "heartbeat only" would stop meaning "killed mid-flight".
    expect(heartbeat(spy)).toBeUndefined()
  })
})

// ── 2026-09-03: a FAILED baseline count is unknown, not zero ─────────────────
//
// supabase-js returns a timed-out count as `{ count: null, error }`. The old
// `activeBefore ?? 0` published `active_before: 0` as a fact and made
// `feed_looks_truncated` read false — a 0-baseline can never be under-fetched —
// so the one metric that says "the feed answered short" was silenced by the
// exact outage that makes a short feed likely. Sibling `ingest/candy-offers`
// carries `bookSizeUnknown` for the same shape; this was the un-swept twin.
describe("candy-listings-indexer — a failed active_before count is reported as unknown", () => {
  it("logs active_before null, feed_looks_truncated null and names the error — and still deactivates nothing", async () => {
    fetchMock = installFetchMock([jsonRoute("/listings", []), jsonRoute("/activities", [])])
    const spy = install({
      candy_listings: [
        { data: null, error: { message: "canceling statement due to statement timeout" }, count: null },
        { data: [] },
      ],
      candy_pack_listings: [{ data: [] }],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    const extra = log?.p_extra as Record<string, unknown>
    // The ABSENCE of the false claims, not merely the presence of the error field.
    expect(extra.active_before).toBeNull()
    expect(extra.active_before).not.toBe(0)
    expect(extra.feed_looks_truncated).toBeNull()
    expect(extra.feed_looks_truncated).not.toBe(false)
    expect(String(extra.active_before_error)).toContain("statement timeout")
    expect(extra.deactivated).toBe(0)
    expect((spy.writes.candy_listings ?? []).filter((w) => w.method === "update")).toHaveLength(1)
  })
})
