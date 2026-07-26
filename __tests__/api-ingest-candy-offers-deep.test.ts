import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/ingest/candy-offers — the Candy (Solana / Magic Eden)
// standing-offer sweep. The sweep runs inside after(). We mock the Solana seams
// (solUsd, candyMeSymbolReady) so the activities → bidder-union → offers_made →
// candy-mint-gate → upsert → deactivate ladder runs unmodified. Pinned:
//   - discovery-gate: while candyMeSymbolReady() is false the route 202s
//     discovery_pending and never schedules the sweep;
//   - happy sweep: exact `candy_offers` upsert row (SOL + USD from rate, expiry
//     unix→ISO, buyer, edition resolved wmc.edition_key → editions.external_id),
//     non-Candy offers from the same wallet filtered by the wmc-miss gate;
//   - bidder union: a buyer present only on an ACTIVE stored offer (aged out of
//     the activities window) is still re-swept via offers_made;
//   - partial-sweep safety: any per-bidder offers_made failure SKIPS the
//     stale-offer deactivation (an absence could be a fetch artifact) while the
//     expiry-based deactivation still runs;
//   - a fatal ME activities error logs ok=false.

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
const { POST } = await import("@/app/api/ingest/candy-offers/route")

const CANDY_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"
// Recent bid so the 45-day activities lookback floor never trips in tests.
const RECENT = Math.floor(Date.now() / 1000) - 3600

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/ingest/candy-offers", {
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

describe("candy-offers — discovery gate + auth", () => {
  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/ingest/candy-offers", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("202s discovery_pending (no after() sweep) while the ME symbol is a TODO", async () => {
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

describe("candy-offers — sweep ladder", () => {
  it("upserts an exact candy_offers row for a Candy-mint offer and filters non-Candy offers via the wmc gate", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", [
        { signature: "sb1", type: "bid", buyer: "bidder1", blockTime: RECENT },
        // a listing event never contributes a bidder
        { signature: "sl1", type: "list", buyer: "lister", blockTime: RECENT },
      ]),
      jsonRoute("/offers_made", [
        { pdaAddress: "pdaA", tokenMint: "mintCandy", auctionHouse: "AH1", price: 0.0035, tokenSize: 1, expiry: 1900000000 },
        // wmc-miss → not a Candy mint → filtered, never counted
        { pdaAddress: "pdaX", tokenMint: "mintOther", price: 2.5, expiry: 0 },
      ]),
    ])
    const spy = install({
      candy_offers: [
        { data: [], error: null }, // active-buyer union read (empty)
        { data: null, error: null }, // upsert
        { data: [{ pda_address: "pdaGone" }], error: null }, // stale deactivate
        { data: [], error: null }, // expiry deactivate
      ],
      wallet_moments_cache: [
        { data: [{ edition_key: "aaron-judge" }], error: null }, // mintCandy hit
        { data: [], error: null }, // mintOther miss
      ],
      editions: { data: [{ id: "ed-judge" }], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const upserts = (spy.writes.candy_offers ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      pda_address: "pdaA",
      token_mint: "mintCandy",
      edition_id: "ed-judge",
      collection_id: CANDY_UUID,
      buyer: "bidder1",
      auction_house: "AH1",
      price_sol: 0.0035,
      price_usd: 0.53, // 0.0035 * 150, 2dp
      token_size: 1,
      expiry: new Date(1900000000 * 1000).toISOString(),
      is_active: true,
    })
    // first_seen_at must be omitted so the upsert preserves it on conflict.
    expect("first_seen_at" in upserts[0]).toBe(false)

    // Complete sweep → BOTH deactivation updates ran (stale + expired).
    const updates = (spy.writes.candy_offers ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(2)

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 1, p_rows_skipped: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.bidders_discovered).toBe(1)
    expect(extra.bidders_swept).toBe(1)
    expect(extra.bidder_fetch_errors).toBe(0)
    expect(extra.deactivated).toBe(1) // pdaGone from the stale pass
    expect(extra.sol_usd).toBe(150)
  })

  it("re-sweeps a buyer known only from an ACTIVE stored offer (aged out of the activities window)", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", []), // no recent bid events at all
      jsonRoute("/offers_made", []),
    ])
    install({
      candy_offers: [
        { data: [{ buyer: "storedBidder" }], error: null }, // active-buyer union
        { data: [], error: null }, // stale deactivate
        { data: [], error: null }, // expiry deactivate
      ],
    })

    await POST(req())
    await runDeferred()

    const offerCalls = fetchMock.calls.filter((c) => c.url.includes("/offers_made"))
    expect(offerCalls).toHaveLength(1)
    expect(offerCalls[0].url).toContain("/wallets/storedBidder/offers_made")
  })

  it("skips stale-offer deactivation on ANY per-bidder fetch failure (partial-sweep safety); expiry pass still runs", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", [{ signature: "s", type: "bid", buyer: "bidderErr", blockTime: RECENT }]),
      jsonRoute("/offers_made", { error: "boom" }, { status: 500, ok: false }),
    ])
    const spy = install({
      candy_offers: [
        { data: [], error: null }, // active-buyer union
        { data: [], error: null }, // expiry deactivate (the ONLY update expected)
      ],
    })

    await POST(req())
    await runDeferred()

    const updates = (spy.writes.candy_offers ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(1) // stale pass gated off, expiry pass ran
    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    expect((log?.p_extra as Record<string, unknown>).bidder_fetch_errors).toBe(1)
  })

  it("a fatal ME activities error logs ok=false with the message", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/activities", { error: "rate limited" }, { status: 429, ok: false }),
    ])
    const spy = install({})

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("HTTP 429")
  })
})

// ---------------------------------------------------------------------------
// Bidder-cap truncation (added 2026-07-26).
//
// MAX_BIDDERS is a lambda guard, but at 40 it bound BELOW the real bidder
// population: from 2026-07-25 06:50Z every tick logged bidders_truncated=true,
// and because deactivation is (correctly) skipped on a partial sweep, NOTHING
// was deactivated for ~42h — 6 of 17 "active" offers had not been re-verified
// since. The cap is now 250; a truncated tick must also report ok=false so the
// freeze can never again hide behind a healthy-looking offers_upserted count.
// ---------------------------------------------------------------------------
describe("candy-offers-indexer — truncation is a degraded run", () => {
  it("reports ok=false and skips deactivation when the bidder cap truncates the sweep", async () => {
    const buyers = Array.from({ length: 251 }, (_, i) => ({ buyer: `bidder${i}` }))
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
    const spy = install({
      candy_offers: [{ data: buyers, error: null }, { data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toMatch(/truncated/i)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.bidders_truncated).toBe(true)
    expect(extra.bidders_discovered).toBe(251)
    expect(extra.bidders_swept).toBe(250)
  })

  it("a bidder population under the cap sweeps clean and stays ok=true", async () => {
    const buyers = Array.from({ length: 60 }, (_, i) => ({ buyer: `bidder${i}` }))
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
    const spy = install({
      candy_offers: [{ data: buyers, error: null }, { data: [] }, { data: [] }],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    const extra = log?.p_extra as Record<string, unknown>
    // 60 discovered is exactly the population that was truncating at the old
    // cap of 40 on 2026-07-26.
    expect(extra.bidders_truncated).toBe(false)
    expect(extra.bidders_swept).toBe(60)
  })
})
