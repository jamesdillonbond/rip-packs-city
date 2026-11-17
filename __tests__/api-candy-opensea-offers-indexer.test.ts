import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/candy-opensea-offers-indexer. Pinned promises:
//   - missing key -> ok=false naming the cause;
//   - an item bid for a Candy card is written venue 'opensea' with its Solana
//     identity (pda_address = order_state, venue_order_id = svm_order.id);
//   - a collection/trait offer (no mint) is counted, never written;
//   - a bid whose order_state is a Magic Eden pda is the same bid — skipped;
//   - retirement only on a terminal get-order status.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/solana/das", () => ({ solUsd: async () => 150 }))

const { POST } = await import("@/app/api/candy-opensea-offers-indexer/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
const req = () =>
  new NextRequest("https://t/api/candy-opensea-offers-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer candy-token" }),
  })
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}
const logRun = (c: RecordedRpcCall[]) => c.filter((x) => x.name === "log_pipeline_run").at(-1)?.args

function bid(o: { mint?: string; state: string; lamports?: number }) {
  return {
    chain: "solana",
    protocol_address: "OSprog",
    protocol: "opensea_solana",
    status: "ACTIVE",
    remaining_quantity: 1,
    asset: o.mint ? { identifier: o.mint, contract: "C" } : null,
    criteria: o.mint ? null : { collection: { slug: "candy-os" } },
    svm_order: { id: `sig:${o.state}`, order_state: o.state, creation_signature: "sig", maker: "BidderX" },
    price: { currency: "SOL", decimals: 9, value: String(o.lamports ?? 100_000_000) },
  }
}

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
  process.env.CANDY_MLB_OPENSEA_SLUG = "candy-os"
  state.afterCbs.length = 0
})

describe("candy-opensea-offers-indexer", () => {
  it("missing key -> ok=false naming the cause", async () => {
    delete process.env.OPENSEA_API_KEY
    const spy = install({})
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ accepted: false, skipped: "opensea_key_missing" })
    expect(String(logRun(spy.rpcCalls)?.p_error)).toContain("OPENSEA_API_KEY not set")
  })

  it("writes a Candy item bid; counts a collection offer; skips the bid Magic Eden already holds", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/offers/collection/candy-os/all", {
        offers: [bid({ mint: "mintA", state: "stA" }), bid({ state: "stColl" }), bid({ mint: "mintB", state: "stME" })],
        next: null,
      }),
      orderRoute({}),
    ])
    const spy = install({
      wallet_moments_cache: {
        data: [
          { moment_id: "mintA", edition_key: "k1" },
          { moment_id: "mintB", edition_key: "k1" },
        ],
        error: null,
      },
      editions: { data: [{ id: "ed1", external_id: "k1" }], error: null },
      // ME pda read -> upsert -> stale read
      candy_offers: [{ data: [{ pda_address: "stME" }], error: null }, { error: null }, { data: [], error: null }],
    })
    await POST(req())
    await runDeferred()

    const ups = (spy.writes.candy_offers ?? []).filter((w) => w.method === "upsert")
    expect(ups).toHaveLength(1)
    expect(ups[0].rows).toEqual([
      expect.objectContaining({
        pda_address: "stA",
        token_mint: "mintA",
        edition_id: "ed1",
        buyer: "BidderX",
        price_sol: 0.1,
        price_usd: 15,
        venue: "opensea",
        venue_order_id: "sig:stA",
        is_active: true,
      }),
    ])
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({ collection_offers: 1, matched_me_pda: 1, offers_upserted: 1, sweep_complete: true })
  })

  it("retires a stale OpenSea bid only on a terminal status", async () => {
    fetchMock = installFetchMock([
      jsonRoute("/offers/collection/candy-os/all", { offers: [], next: null }),
      orderRoute({ "sig:gone": "FULFILLED", "sig:live": "ACTIVE" }),
    ])
    const spy = install({
      candy_offers: [
        {
          data: [
            { pda_address: "gone", venue_order_id: "sig:gone", auction_house: "OSprog" },
            { pda_address: "live", venue_order_id: "sig:live", auction_house: "OSprog" },
            { pda_address: "lost", venue_order_id: "sig:lost", auction_house: "OSprog" },
          ],
          error: null,
        },
        { data: [{ pda_address: "gone" }], error: null },
      ],
    })
    await POST(req())
    await runDeferred()
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({ retire_candidates: 3, status_checked: 2, status_unknown: 1, status_terminal: 1, retired: 1 })
  })
})
