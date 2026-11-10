import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// 2026-11-08 — Candy's later sets (All-Star, Gold Series, Quest rewards) trade
// under their own Magic Eden symbols. Pinned here:
//   - each later set walks ITS OWN symbol against ITS OWN high-water mark
//     (candy_sales_high_water(set_id)) — a shared cursor would stop a younger
//     set's walk at the Base Series' newest sale;
//   - a mint the census already knows is resolved from wallet_moments_cache with
//     NO DAS call (a new set's ~2,000-sale backlog would otherwise burn the
//     400-call budget per tick);
//   - a later set's failed high-water read fails the run, named.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  ready: true,
  rate: 150 as number | null,
  assets: {} as Record<string, { key: string; serial: number | null; pack?: boolean }>,
  assetThrows: new Set<string>(),
  sets: [] as any[],
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/chains/solana/candy-sets", () => ({ CANDY_BASE_SET_ID: "base-set", get CANDY_SETS() { return state.sets } }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/solana/das", () => ({
  getAsset: async (mint: string) => {
    if (state.assetThrows.has(mint)) throw new Error("DAS getAsset boom")
    return { id: mint, ...state.assets[mint] }
  },
  solUsd: async () => state.rate,
  solUsdOn: async () => state.rate,
  primeSolUsdHistory: async () => 0,
  primeSolUsdFromTable: async () => ({ primed: 0, error: null }),
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_ME_SYMBOL: "candy-mlb-icons",
  CANDY_MLB_SLUG: "candy_mlb",
  CANDY_MLB_UUID: "209ade70-32c5-4470-bc7c-4793d660f713",
  candyMeSymbolReady: () => state.ready,
  editionKeyFromAsset: (asset: { key?: string }) => asset.key ?? "",
  isPack: (asset: { pack?: boolean }) => asset.pack === true,
  normalizeSerial: (asset: { serial?: number | null }) => ({ serial_number: asset.serial ?? null }),
}))

process.env.INGEST_SECRET_TOKEN = "candy-token"
const { POST } = await import("@/app/api/candy-sales-indexer/route")

interface Act { signature: string; type: string; tokenMint?: string; buyer?: string | null; seller?: string | null; price?: number; blockTime?: number }
type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
const req = () => new NextRequest("https://t/api/candy-sales-indexer", { method: "POST", headers: new Headers({ authorization: "Bearer candy-token" }) })
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}
const logRun = (c: RecordedRpcCall[]) => c.filter((x) => x.name === "log_pipeline_run").at(-1)?.args

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => { fetchMock?.restore(); fetchMock = null })
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "candy-token"
  state.afterCbs.length = 0
  state.ready = true
  state.rate = 150
  state.assets = {}
  state.assetThrows = new Set()
  state.sets = [
    { key: "base26", setId: "base-set", meSymbol: "candy-mlb-icons", editionKeyPrefix: null },
    { key: "asg26", setId: "asg-set", meSymbol: "asg-symbol", editionKeyPrefix: "asg26" },
  ]
})

describe("candy-sales-indexer — later Candy sets", () => {
  it("walks the later set's own symbol against its own high-water, and resolves a census mint with no DAS call", async () => {
    const asgActs: Act[] = [
      { signature: "sigNew", type: "buyNow", tokenMint: "asgMint", buyer: "B", seller: "S", price: 2, blockTime: 1_800_000_200 },
      { signature: "sigOld", type: "buyNow", tokenMint: "asgMint2", buyer: "B", seller: "S", price: 1, blockTime: 1_800_000_000 },
    ]
    fetchMock = installFetchMock([jsonRoute("asg-symbol", asgActs), jsonRoute("candy-mlb-icons", [{ signature: "b1", type: "list", tokenMint: "m", blockTime: 1 }])])
    const spy = install({
      sales: [{ data: [], error: null }, { data: null, error: null }],
      // 1) the Base walk's own high-water (none) 2) the set's own high-water: sigOld is
      // at/under it and must stop the walk.
      "rpc:candy_sales_high_water": [{ data: null, error: null }, { data: new Date(1_800_000_000 * 1000).toISOString(), error: null }],
      wallet_moments_cache: { data: [{ edition_key: "asg26:shohei-ohtani-rare", serial_number: 17 }], error: null },
      // 1) the set's catalog exists (count) 2) the edition lookup
      editions: [{ data: null, error: null, count: 40 }, { data: [{ id: "ed-asg" }], error: null }],
    })
    await POST(req())
    await runDeferred()

    expect(fetchMock.calls.some((c) => c.url.includes("/collections/asg-symbol/activities"))).toBe(true)
    // Each walk reads ITS OWN set's high water — the Base walk too (2026-11-08: a shared
    // max(sold_at) let a later set's newer sale skip Base sales).
    expect(spy.rpcCalls.filter((c) => c.name === "candy_sales_high_water").map((c) => c.args)).toEqual([{ p_set_id: "base-set" }, { p_set_id: "asg-set" }])
    const rows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ transaction_hash: "sigNew", edition_id: "ed-asg", serial_number: 17, price_usd: 300 })
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, any>
    expect(extra.asset_fetches).toBe(0) // census, not DAS
    expect(extra.census_resolved).toBe(1)
    expect(extra.sets.asg26).toMatchObject({ sales_found: 1, reached_known: true, error: null })
    expect(logRun(spy.rpcCalls)?.p_ok).toBe(true)
  })

  it("a failed high-water read for a later set fails the run and names the set (never walks history blind)", async () => {
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [{ signature: "x", type: "list", blockTime: 1 }])])
    const spy = install({
      sales: [{ data: [], error: null }],
      "rpc:candy_sales_high_water": [{ data: null, error: null }, { data: null, error: { message: "hw boom" } }],
      editions: [{ data: null, error: null, count: 40 }],
    })
    await POST(req())
    await runDeferred()
    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("asg26")
    expect((log?.p_extra as any).sets.asg26.error).toContain("hw boom")
    expect(fetchMock.calls.some((c) => c.url.includes("asg-symbol"))).toBe(false)
  })

  it("waits for the set's catalog: with no editions yet the walk is skipped and said so — no sales parked", async () => {
    fetchMock = installFetchMock([jsonRoute("candy-mlb-icons", [{ signature: "b1", type: "list", tokenMint: "m", blockTime: 1 }]), jsonRoute("asg-symbol", [{ signature: "s", type: "buyNow", tokenMint: "x", price: 1, blockTime: 2 }])])
    const spy = install({ sales: [{ data: [], error: null }], editions: [{ data: null, error: null, count: 0 }] })
    await POST(req())
    await runDeferred()
    const extra = logRun(spy.rpcCalls)?.p_extra as any
    expect(extra.sets.asg26.skipped).toBe("catalog_not_ingested")
    expect(fetchMock.calls.some((c) => c.url.includes("asg-symbol"))).toBe(false)
    expect(spy.rpcCalls.some((c) => c.name === "candy_park_unresolved_sale")).toBe(false)
    expect(logRun(spy.rpcCalls)?.p_ok).toBe(true)
  })
})
