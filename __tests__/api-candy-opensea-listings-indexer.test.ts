import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/candy-opensea-listings-indexer — the Candy (Solana) ask feed
// from OPENSEA, beside the Magic Eden sweep. The sweep runs inside after().
// Pinned (each is a promise the route header makes):
//   - auth: no token -> 401, defers nothing;
//   - a MISSING OPENSEA_API_KEY is logged ok=false naming the misconfiguration —
//     never a clean "0 listings" run;
//   - Solana identity: pda_address = svm_order.order_state, venue_order_id =
//     svm_order.id, venue = 'opensea', price from lamports (decimals 9);
//   - DEDUP: an ask for a mint that already has an ACTIVE Magic Eden row is NOT
//     written (OpenSea aggregates other venues; one live ask per 1-of-1);
//   - a non-ACTIVE listing, a non-Candy mint and an unknown currency are dropped
//     and COUNTED, never written;
//   - retirement is EVIDENCE-based: only a terminal get-order status retires a
//     row; a failed lookup retires nothing;
//   - slug discovery adopts a slug only from an NFT whose identifier IS a
//     holder's Candy mint, and a miss fails the run loudly.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  rate: 150 as number | null,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/solana/das", () => ({
  solUsd: async () => state.rate,
}))

const { GET, POST } = await import("@/app/api/candy-opensea-listings-indexer/route")
const { osPrice } = await import("@/lib/chains/solana/opensea")

const CANDY_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"
const PROGRAM = "OSprogram111"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/candy-opensea-listings-indexer", {
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

function osListing(o: {
  mint: string
  state: string
  lamports?: number
  currency?: string
  decimals?: number
  status?: string
  maker?: string
}) {
  return {
    chain: "solana",
    protocol_address: PROGRAM,
    protocol: "opensea_solana",
    status: o.status ?? "ACTIVE",
    remaining_quantity: 1,
    asset: { identifier: o.mint, contract: "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n" },
    svm_order: { id: `sig-${o.state}:${o.state}`, order_state: o.state, creation_signature: `sig-${o.state}`, maker: o.maker ?? "SellerWallet1" },
    price: { current: { currency: o.currency ?? "SOL", decimals: o.decimals ?? 9, value: String(o.lamports ?? 500_000_000) } },
  }
}

/** Get-order stub answering per order id; anything not in `statuses` 404s. */
function orderRoute(statuses: Record<string, string>): FetchStub {
  return {
    match: (url) => url.includes("/orders/chain/solana/protocol/"),
    respond: (url) => {
      const id = decodeURIComponent(url.split("/").at(-1) ?? "")
      return id in statuses ? { json: { order: { status: statuses[id] } } } : { status: 404, json: {} }
    },
  }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "candy-token"
  process.env.OPENSEA_API_KEY = "os-key"
  process.env.CANDY_MLB_OPENSEA_SLUG = "candy-mlb-os"
  state.afterCbs.length = 0
  state.rate = 150
})

describe("candy-opensea-listings-indexer — auth + key", () => {
  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await GET(new NextRequest("https://t/api/candy-opensea-listings-indexer"))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("a missing OPENSEA_API_KEY is logged ok=false with the cause — not a clean empty run", async () => {
    delete process.env.OPENSEA_API_KEY
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: false, skipped: "opensea_key_missing" })
    expect(state.afterCbs).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false, p_rows_found: 0, p_collection_slug: "candy_mlb" })
    expect(String(log?.p_error)).toContain("OPENSEA_API_KEY not set")
    expect((log?.p_extra as Record<string, unknown>).skip_reason).toBe("opensea_key_missing")
  })
})

describe("candy-opensea-listings-indexer — sweep", () => {
  it("writes an OpenSea-native Candy ask with its Solana identity; skips ME-held, inactive, non-Candy and unpriced asks", async () => {
    const listings = [
      osListing({ mint: "mintOS", state: "stateOS", lamports: 500_000_000 }), // written
      osListing({ mint: "mintME", state: "stateME" }), // mint has an active ME ask -> skipped
      osListing({ mint: "mintOS2", state: "stateDone", status: "FULFILLED" }), // not active
      osListing({ mint: "mintJunk", state: "stateJunk" }), // not a Candy card
      osListing({ mint: "mintBonk", state: "stateBonk", currency: "BONK" }), // unknown currency
      osListing({ mint: "mintPack", state: "statePack", lamports: 300_000_000 }), // sealed pack -> pack table
    ]
    fetchMock = installFetchMock([
      jsonRoute("/listings/collection/candy-mlb-os/all", { listings, next: null }),
      // OpenSea's own item URL for the new card ask; the pack's lookup fails.
      {
        match: (url) => url.includes("/chain/solana/contract/") && url.endsWith("/nfts/mintOS"),
        respond: () => ({ json: { nft: { opensea_url: "https://opensea.io/item/solana/mintOS" } } }),
      },
      { match: (url) => url.includes("/chain/solana/contract/"), respond: () => ({ status: 500, json: {} }) },
      orderRoute({}),
    ])
    const spy = install({
      wallet_moments_cache: {
        data: [
          { moment_id: "mintOS", edition_key: "candy-mlb:trout" },
          { moment_id: "mintME", edition_key: "candy-mlb:judge" },
          { moment_id: "mintBonk", edition_key: "candy-mlb:judge" },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "ed-trout", external_id: "candy-mlb:trout" },
          { id: "ed-judge", external_id: "candy-mlb:judge" },
        ],
        error: null,
      },
      // ME active-ask read -> ME pda read -> upsert -> stale opensea read.
      // ME active-ask read -> ME pda read -> stored venue_url read -> upsert -> stale read.
      candy_listings: [
        { data: [{ token_mint: "mintME" }], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { error: null },
        { data: [], error: null },
      ],
      // "mintPack" is a sealed pack, not a card.
      candy_packs: { data: [{ token_mint: "mintPack" }], error: null },
      candy_pack_listings: { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const upserts = (spy.writes.candy_listings ?? []).filter((w) => w.method === "upsert")
    expect(upserts).toHaveLength(1)
    expect(upserts[0].options).toMatchObject({ onConflict: "pda_address" })
    expect(upserts[0].rows).toEqual([
      expect.objectContaining({
        pda_address: "stateOS",
        token_mint: "mintOS",
        edition_id: "ed-trout",
        collection_id: CANDY_UUID,
        seller: "SellerWallet1",
        auction_house: PROGRAM,
        price_sol: 0.5,
        price_usd: 75, // 0.5 SOL * 150
        token_size: 1,
        is_active: true,
        venue: "opensea",
        venue_order_id: "sig-stateOS:stateOS",
        venue_url: "https://opensea.io/item/solana/mintOS",
      }),
    ])
    // The pack ask lands in the PACK table, with no URL since its lookup failed
    // (null, never a built one) — and never in candy_listings.
    const packUps = (spy.writes.candy_pack_listings ?? []).filter((w) => w.method === "upsert")
    expect(packUps).toHaveLength(1)
    expect(packUps[0].rows).toEqual([
      expect.objectContaining({ pda_address: "statePack", token_mint: "mintPack", venue: "opensea", venue_url: null, price_sol: 0.3 }),
    ])
    expect(packUps[0].rows[0]).not.toHaveProperty("edition_id")
    // The ME-held mint must not appear in ANY write.
    expect(JSON.stringify(spy.writes.candy_listings)).not.toContain("mintME")

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 1, p_collection_slug: "candy_mlb" })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      slug: "candy-mlb-os",
      slug_discovery: "env",
      raw_listings_seen: 6,
      pack_asks_upserted: 1,
      urls_fetched: 2,
      urls_missing: 1,
      not_active: 1,
      not_candy_card: 1,
      unpriced: 1,
      skipped_me_active: 1,
      sweep_complete: true,
      retired: 0,
    })
    // The API key rides the documented header, never the URL.
    const listCall = fetchMock.calls.find((c) => c.url.includes("/listings/collection/"))
    expect((listCall?.init?.headers as Record<string, string>)["x-api-key"]).toBe("os-key")
    expect(listCall?.url).not.toContain("os-key")
  })

  it("retires a stale OpenSea row ONLY on a terminal order status; a failed lookup retires nothing", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/listings/collection/candy-mlb-os/all", { listings: [], next: null }),
      orderRoute({ "sig-gone:gone": "CANCELLED", "sig-live:live": "ACTIVE" }),
    ])
    const spy = install({
      candy_listings: [
        // stale opensea read (no reported mints, so no dedup reads / upsert run)
        {
          data: [
            { pda_address: "gone", venue_order_id: "sig-gone:gone", auction_house: PROGRAM },
            { pda_address: "live", venue_order_id: "sig-live:live", auction_house: PROGRAM },
            { pda_address: "lost", venue_order_id: "sig-lost:lost", auction_house: PROGRAM }, // 404
          ],
          error: null,
        },
        // retire update
        { data: [{ pda_address: "gone" }], error: null },
      ],
    })
    await POST(req())
    await runDeferred()

    const updates = (spy.writes.candy_listings ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(1)
    expect(updates[0].rows).toEqual([{ is_active: false }])
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({ retire_candidates: 3, status_checked: 2, status_unknown: 1, status_terminal: 1, retired: 1 })
    expect(logRun(spy.rpcCalls)).toMatchObject({ p_ok: true })
  })

  it("a failed wmc read fails the run instead of classifying real asks as not-Candy", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/listings/collection/candy-mlb-os/all", { listings: [osListing({ mint: "m1", state: "s1" })], next: null }),
    ])
    const spy = install({ wallet_moments_cache: { data: null, error: { message: "wmc boom" } } })
    await POST(req())
    await runDeferred()
    expect((spy.writes.candy_listings ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false })
    expect(String(log?.p_error)).toContain("wmc batch lookup failed: wmc boom")
  })

  it("a rejected upsert fails the run row and names the table", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/listings/collection/candy-mlb-os/all", { listings: [osListing({ mint: "m1", state: "s1" })], next: null }),
      orderRoute({}),
    ])
    const spy = install({
      wallet_moments_cache: { data: [{ moment_id: "m1", edition_key: "k1" }], error: null },
      editions: { data: [{ id: "e1", external_id: "k1" }], error: null },
      candy_listings: [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: null, error: { message: "upsert boom" } },
        { data: [], error: null },
      ],
    })
    await POST(req())
    await runDeferred()
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false, p_rows_written: 0, p_rows_skipped: 1 })
    expect(String(log?.p_error)).toContain("candy_listings upsert: upsert boom")
  })
})

describe("candy-opensea-listings-indexer — slug discovery", () => {
  beforeEach(() => {
    delete process.env.CANDY_MLB_OPENSEA_SLUG
  })

  it("adopts the slug of an NFT whose identifier is one of the holder's Candy mints (not the wallet's other collections)", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/chain/solana/account/HolderA/nfts", {
        nfts: [
          { identifier: "notCandy", collection: "some-other-collection", opensea_url: "https://opensea.io/x" },
          { identifier: "candyMint1", collection: "candy-mlb-real", opensea_url: "https://opensea.io/sample" },
        ],
        next: null,
      }),
      jsonRoute("/listings/collection/candy-mlb-real/all", { listings: [], next: null }),
    ])
    const spy = install({
      wallet_moments_cache: [
        { data: [{ wallet_address: "HolderA" }], error: null },
        { data: [{ moment_id: "candyMint1" }], error: null },
      ],
      candy_listings: { data: [], error: null },
    })
    await POST(req())
    await runDeferred()
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({ slug: "candy-mlb-real", slug_discovery: "holder_match", sample_opensea_url: "https://opensea.io/sample" })
  })

  it("no matching NFT -> ok=false slug_not_found, and the listings feed is never read", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/chain/solana/account/HolderA/nfts", {
        nfts: [{ identifier: "notCandy", collection: "some-other-collection" }],
        next: null,
      }),
    ])
    const spy = install({
      wallet_moments_cache: [
        { data: [{ wallet_address: "HolderA" }], error: null },
        { data: [{ moment_id: "candyMint1" }], error: null },
      ],
    })
    await POST(req())
    await runDeferred()
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false })
    expect((log?.p_extra as Record<string, unknown>).skip_reason).toBe("slug_not_found")
    expect(fetchMock.calls.some((c) => c.url.includes("/listings/"))).toBe(false)
  })
})

describe("osPrice", () => {
  it("SOL from lamports, USDC at face, anything else refused", () => {
    expect(osPrice({ currency: "SOL", decimals: 9, value: "2500000000" }, 100)).toEqual({ sol: 2.5, usd: 250 })
    expect(osPrice({ currency: "USDC", decimals: 6, value: "12340000" }, 100)).toEqual({ sol: 0.1234, usd: 12.34 })
    expect(osPrice({ currency: "SOL", decimals: 9, value: "1000000000" }, null)).toEqual({ sol: 1, usd: null })
    expect(osPrice({ currency: "BONK", decimals: 5, value: "100" }, 100)).toBeNull()
    expect(osPrice({ currency: "SOL", decimals: 9, value: "0" }, 100)).toBeNull()
    expect(osPrice(undefined, 100)).toBeNull()
  })
})
