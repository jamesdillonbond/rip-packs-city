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
      wallet_moments_cache: { data: [{ edition_key: "candy-mlb:trout" }], error: null },
      editions: { data: [{ id: "ed-trout" }], error: null },
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
      wallet_moments_cache: { data: [{ edition_key: "candy-mlb:trout" }], error: null },
      editions: { data: [{ id: "ed-trout" }], error: null },
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

