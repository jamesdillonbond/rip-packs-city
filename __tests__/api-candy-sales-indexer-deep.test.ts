import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/candy-sales-indexer — the Candy (Solana / Magic Eden)
// secondary-sales indexer. The scan runs inside after(). We mock the two Solana
// seams (@/lib/chains/solana/das getAsset/solUsd, @/lib/chains/solana/normalize
// candyMeSymbolReady/editionKeyFromAsset/normalizeSerial) so the ME activities
// -> DAS -> edition-resolution -> `sales` write ladder runs unmodified. Pinned:
//   - discovery-gate: while candyMeSymbolReady() is false the route 202s
//     discovery_pending and logs skip_reason WITHOUT running after();
//   - happy sale: exact `sales` row (USD from price*rate, currency SOL,
//     marketplace magic_eden, source solana_das, tx_hash=signature, serial);
//   - incremental cursor: an activity at/under the high-water sold_at stops the
//     walk (reachedKnown) and is not counted;
//   - honest skip accounting: non-sale types filtered (not found), null rate /
//     zero price / DAS throw / key|serial null / edition-not-ingested all count
//     as `skipped`, never written; cursorAfter tracks the newest SALE seen even
//     when it is skipped;
//   - a 23505 batch retries row-by-row: a genuine dupe stays unwritten, but a
//     NEW sale co-batched with a dupe still lands (regression: the whole batch
//     used to be dropped on any single 23505); a fatal ME error logs ok=false.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  ready: true,
  rate: 150 as number | null,
  assets: {} as Record<string, { key: string; serial: number | null; pack?: boolean }>,
  assetThrows: new Set<string>(),
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
  getAsset: async (mint: string) => {
    if (state.assetThrows.has(mint)) throw new Error("DAS getAsset boom")
    return { id: mint, ...state.assets[mint] }
  },
  solUsd: async () => state.rate,
  solUsdOn: async () => state.rate,
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

const CANDY_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"

interface Act {
  signature: string
  type: string
  tokenMint?: string
  buyer?: string | null
  seller?: string | null
  price?: number
  blockTime?: number
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/candy-sales-indexer", {
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
  state.assets = {}
  state.assetThrows = new Set()
})

describe("candy-sales-indexer — discovery gate + auth", () => {
  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/candy-sales-indexer", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("202s discovery_pending (no after() sweep) while the ME symbol is a TODO", async () => {
    state.ready = false
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: false, skipped: "discovery_pending", collection: "candy_mlb" })
    // The discovery-skip logs its own run and never schedules the sweep.
    expect(state.afterCbs).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "candy_mlb" })
    expect((log?.p_extra as Record<string, unknown>).skip_reason).toBe("discovery_pending")
  })
})

describe("candy-sales-indexer — the Magic Eden walk is time-bounded", () => {
  // 🚨 WHY. `fetch()` has NO default timeout, and this route runs inside
  // `after()` with maxDuration 300 — so an upstream holding the connection open
  // consumes the whole budget, and a maxDuration kill writes NO terminal
  // pipeline_runs row, making the outage invisible. Measured on the sibling
  // /api/candy-listings-indexer 2026-08-27 (15 heartbeats, ONE terminal row in
  // 48h, PUBLIC board 44h stale). This route is the MOST exposed caller of the
  // pattern: it is the one already observed taking Cloudflare 1015 rate-limits
  // (HTTP 429) from Vercel against this same host.
  //
  // ⚠ Asserted on the REQUEST INIT, not the source text — a source grep would be
  // satisfied by the comment you are reading.
  it("passes an abort signal on every Magic Eden request", async () => {
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
    install({ sales: [{ data: [], error: null }] })

    await POST(req())
    await runDeferred()

    const meCalls = fetchMock.calls.filter((c) => /magiceden\.dev/.test(c.url))
    // Not vacuous: with no ME calls the filter below asserts nothing.
    expect(meCalls.length).toBeGreaterThan(0)
    const unbounded = meCalls.filter((c) => !c.init?.signal).map((c) => c.url)
    expect(
      unbounded,
      "every Magic Eden request must carry an AbortSignal — an unbounded one " +
        "consumes the whole 300s lambda budget and the tick dies unlogged",
    ).toEqual([])
  })
})

describe("candy-sales-indexer — ingest ladder", () => {
  it("writes an exact USD `sales` row for a resolvable ME sale + logs cursor accounting", async () => {
    const acts: Act[] = [
      { signature: "sigA", type: "buyNow", tokenMint: "mintA", buyer: "0xbuy", seller: "0xsel", price: 0.1, blockTime: 1_700_000_100 },
      // "list" is a listing, not a sale — never counted in `found`.
      { signature: "sigL", type: "list", tokenMint: "mintL", price: 5, blockTime: 1_700_000_050 },
    ]
    state.assets = { mintA: { key: "mlb-icons:trout", serial: 12 } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [
        { data: [{ sold_at: "2023-06-01T00:00:00Z" }], error: null }, // high-water read (older than the sale)
        { data: null, error: null }, // insert
      ],
      editions: { data: [{ id: "ed-trout" }], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "ed-trout",
      collection_id: CANDY_UUID,
      collection: "candy_mlb",
      nft_id: "mintA",
      serial_number: 12,
      price_usd: 15, // 0.1 SOL * 150
      price_native: 0.1,
      currency: "SOL",
      marketplace: "magic_eden",
      source: "solana_das",
      transaction_hash: "sigA",
      buyer_address: "0xbuy",
      seller_address: "0xsel",
    })
    expect(typeof saleRows[0].id).toBe("string")
    expect(saleRows[0].sold_at).toBe(new Date(1_700_000_100 * 1000).toISOString())

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 1, // the "list" activity excluded
      p_rows_written: 1,
      p_rows_skipped: 0,
      p_cursor_before: "2023-06-01T00:00:00.000Z",
      p_cursor_after: new Date(1_700_000_100 * 1000).toISOString(),
    })
    expect((log?.p_extra as Record<string, unknown>).asset_fetches).toBe(1)
    expect((log?.p_extra as Record<string, unknown>).sol_usd).toBe(150)
  })

  it("stops at the incremental high-water mark (reachedKnown), not counting older sales", async () => {
    const acts: Act[] = [
      { signature: "sigNew", type: "buyNow", tokenMint: "mintNew", price: 0.2, blockTime: 1_700_000_500 },
      // at/under the high-water sold_at -> reachedKnown, skipped from `found`.
      { signature: "sigOld", type: "buyNow", tokenMint: "mintOld", price: 0.2, blockTime: 1_700_000_100 },
    ]
    state.assets = { mintNew: { key: "mlb-icons:judge", serial: 3 } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const cutoffIso = new Date(1_700_000_200 * 1000).toISOString()
    const spy = install({
      sales: [{ data: [{ sold_at: cutoffIso }], error: null }, { data: null, error: null }],
      editions: { data: [{ id: "ed-judge" }], error: null },
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 1 })
    expect((spy.writes.sales ?? []).flatMap((w) => w.rows).map((r) => r.nft_id)).toEqual(["mintNew"])
  })

  it("counts every degradation as skipped (null rate, zero price, DAS throw, edition-not-ingested), never written; cursorAfter still tracks the newest sale", async () => {
    const acts: Act[] = [
      { signature: "s1", type: "buyNow", tokenMint: "m1", price: 0, blockTime: 1_700_000_400 }, // zero price
      { signature: "s2", type: "buyNow", tokenMint: "m2", price: 0.1, blockTime: 1_700_000_300 }, // DAS throws
      { signature: "s3", type: "buyNow", tokenMint: "m3", price: 0.1, blockTime: 1_700_000_200 }, // edition not ingested
      { signature: "s4", type: "buyNow", tokenMint: "m4", price: 0.1, blockTime: 1_700_000_100 }, // key/serial null
    ]
    state.assetThrows = new Set(["m2"])
    state.assets = {
      m3: { key: "mlb-icons:missing", serial: 5 },
      m4: { key: "", serial: null },
    }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [{ data: [], error: null }, { data: null, error: null }],
      editions: { data: [], error: null }, // m3 edition lookup miss
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 4, p_rows_written: 0, p_rows_skipped: 4 })
    // cursorAfter is set before the skip checks -> newest SALE blockTime.
    expect(log?.p_cursor_after).toBe(new Date(1_700_000_400 * 1000).toISOString())
  })

  it("null SOL rate skips every found sale (rate gate)", async () => {
    state.rate = null
    const acts: Act[] = [
      { signature: "sr", type: "acceptBid", tokenMint: "mr", price: 0.3, blockTime: 1_700_000_100 },
    ]
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({ sales: [{ data: [], error: null }] })

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
    expect((log?.p_extra as Record<string, unknown>).sol_usd).toBeNull()
  })

  it("a genuine 23505 dupe stays unwritten after the row-by-row retry (ok=true)", async () => {
    const acts: Act[] = [
      { signature: "sdup", type: "buyNow", tokenMint: "mdup", price: 0.1, blockTime: 1_700_000_600 },
    ]
    state.assets = { mdup: { key: "mlb-icons:soto", serial: 9 } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [
        { data: [], error: null }, // high-water read
        // batch insert 23505; the per-row retry re-hits it (last entry repeats)
        { error: { code: "23505", message: "dupe tx" } },
      ],
      editions: { data: [{ id: "ed-soto" }], error: null },
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 0 })
  })

  it("recovers NEW sales co-batched with a 23505 dupe via the row-by-row retry", async () => {
    // Two sales in one batch: the first collides on transaction_hash (23505),
    // the second is genuinely new. A batch insert is all-or-nothing, so the old
    // code dropped BOTH; the fix must retry row-by-row and still land the new one.
    const acts: Act[] = [
      { signature: "sdup", type: "buyNow", tokenMint: "mdup", price: 0.1, blockTime: 1_700_000_600 },
      { signature: "snew", type: "buyNow", tokenMint: "mnew", price: 0.2, blockTime: 1_700_000_550 },
    ]
    state.assets = {
      mdup: { key: "mlb-icons:soto", serial: 9 },
      mnew: { key: "mlb-icons:acuna", serial: 4 },
    }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [
        { data: [], error: null }, // high-water read
        { error: { code: "23505", message: "dupe tx" } }, // batch insert fails on the dupe
        { error: { code: "23505", message: "dupe tx" } }, // per-row: the dupe, skipped
        { data: null, error: null }, // per-row: the NEW sale, lands
      ],
      editions: [
        { data: [{ id: "ed-soto" }], error: null },
        { data: [{ id: "ed-acuna" }], error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    // Both are sales; only the new one is written (the dupe is skipped per-row).
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 1 })
  })

  it("a fatal ME activities error logs ok=false with the message", async () => {
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", { error: "rate limited" }, { status: 429, ok: false })])
    const spy = install({ sales: [{ data: [], error: null }] })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("ME activities HTTP 429")
  })
})

// ---------------------------------------------------------------------------
// Dead letter + upstream-fault detection (added 2026-07-26).
//
// The cursor is max(sold_at), so a sale the walk SEES but cannot write is only
// re-offered while it is still the newest thing — the next successful write
// steps the cursor over it and it is lost. Measured over the first 25 runs:
// 359 found / 322 written / 37 skipped, all under ok=true. These pin the park →
// drain → close ladder that replaces the silent drop, plus the empty-feed guard.
// ---------------------------------------------------------------------------
describe("candy-sales-indexer — dead letter", () => {
  it("parks an unwritable sale instead of dropping it, and counts it", async () => {
    const acts: Act[] = [
      { signature: "sMiss", type: "buyNow", tokenMint: "mMiss", buyer: "b1", seller: "s1", price: 0.4, blockTime: 1_700_000_900 },
    ]
    state.assets = { mMiss: { key: "mlb-icons:notyet", serial: 9 } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [{ data: [], error: null }],
      editions: { data: [], error: null }, // edition not ingested yet
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const park = spy.rpcCalls.find((c) => c.name === "candy_park_unresolved_sale")
    expect(park?.args).toMatchObject({
      p_signature: "sMiss",
      p_token_mint: "mMiss",
      p_price_sol: 0.4,
      p_buyer: "b1",
      p_seller: "s1",
      p_skip_reason: "edition_not_ingested",
    })
    expect(park?.args?.p_block_time).toBe(new Date(1_700_000_900 * 1000).toISOString())
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
    expect((log?.p_extra as Record<string, unknown>).parked).toBe(1)
  })

  // price_usd is price*rate ROUNDED to cents, so the `price <= 0` gate upstream does
  // NOT stop a positive-but-dust SOL amount from landing as 0.00. One such row reached
  // `sales` live on 2026-07-23: 0.00000100 SOL (~$0.000076). `sales` carries no
  // CHECK (price_usd > 0), so nothing downstream would have caught it either, and a $0
  // sale drags every average computed over that edition. Candy is the live writer and
  // is about to flip public, so this guard is load-bearing.
  it("rejects a dust sale whose USD price rounds to 0.00, and closes it out terminally", async () => {
    const acts: Act[] = [
      // 0.000001 SOL * 150 = $0.00015 -> toFixed(2) -> "0.00". Positive in SOL, zero in USD.
      { signature: "sDust", type: "buyNow", tokenMint: "mDust", buyer: "bd", seller: "sd", price: 0.000001, blockTime: 1_700_000_800 },
    ]
    state.assets = { mDust: { key: "mlb-icons:trout", serial: 7 } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [{ data: [], error: null }],
      editions: { data: [{ id: "ed-trout" }], error: null },
      candy_sales_unresolved: [
        { data: null, error: null }, // the terminal close-out UPDATE
        { data: [], error: null }, // drain read (nothing else parked)
        { data: null, error: null, count: 0 }, // open-backlog count
      ],
    })

    await POST(req())
    await runDeferred()

    // The row must never reach `sales`.
    expect((spy.writes.sales ?? []).flatMap((w) => w.rows)).toHaveLength(0)

    const park = spy.rpcCalls.find((c) => c.name === "candy_park_unresolved_sale")
    expect(park?.args).toMatchObject({ p_signature: "sDust", p_skip_reason: "dust_price_rounds_to_zero" })

    // Terminal, not retried: dust can never become non-dust, so leaving it open would
    // burn drain budget every tick until attempts hit MAX_PARK_ATTEMPTS.
    const closes = (spy.writes.candy_sales_unresolved ?? []).flatMap((w) => w.rows)
    expect(closes.some((r: any) => r.resolution === "dust_price_rounds_to_zero" && r.resolved_at)).toBe(true)

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
    // Short-circuits before the DAS lookup, so it costs no asset budget.
    expect((log?.p_extra as Record<string, unknown>).asset_fetches).toBe(0)
  })

  it("drains a parked sale on a later tick and closes it out as written", async () => {
    // A non-sale activity keeps the feed non-empty (so the upstream-fault guard
    // stays quiet) while contributing nothing to `found`.
    const acts: Act[] = [{ signature: "sBid", type: "bid", tokenMint: "mBid", price: 0.01, blockTime: 1_700_001_000 }]
    state.assets = { mOld: { key: "mlb-icons:judge", serial: 44 } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [{ data: [], error: null }, { data: null, error: null }],
      editions: { data: [{ id: "ed-judge" }], error: null },
      candy_sales_unresolved: [
        {
          data: [
            {
              signature: "sOld",
              token_mint: "mOld",
              block_time: "2026-07-24T00:00:00.000Z",
              price_sol: 0.2,
              buyer: "bOld",
              seller: "sOld2",
            },
          ],
          error: null,
        },
        { data: null, error: null }, // the close-out UPDATE
        { data: null, error: null, count: 0 }, // the open-backlog count
      ],
    })

    await POST(req())
    await runDeferred()

    // The recovered sale lands with its ORIGINAL sold_at, so it can never move
    // the high-water cursor forward.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      nft_id: "mOld",
      edition_id: "ed-judge",
      serial_number: 44,
      price_usd: 30, // 0.2 SOL * 150
      transaction_hash: "sOld",
      sold_at: "2026-07-24T00:00:00.000Z",
    })
    const close = (spy.writes.candy_sales_unresolved ?? []).find((w) => w.method === "update")
    expect(close?.rows[0]).toMatchObject({ resolution: "written" })
    const log = logRun(spy.rpcCalls)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.drain_attempted).toBe(1)
    expect(extra.drain_resolved).toBe(1)
    expect(log?.p_rows_written).toBe(1)
  })

  it("closes a drained row that collides on transaction_hash rather than retrying it forever", async () => {
    const acts: Act[] = [{ signature: "sBid", type: "bid", tokenMint: "mBid", price: 0.01, blockTime: 1_700_001_000 }]
    state.assets = { mDupe: { key: "mlb-icons:judge", serial: 7 } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [{ data: [], error: null }, { data: null, error: { code: "23505", message: "dupe" } }],
      editions: { data: [{ id: "ed-judge" }], error: null },
      candy_sales_unresolved: [
        {
          data: [{ signature: "sDupe", token_mint: "mDupe", block_time: "2026-07-24T00:00:00.000Z", price_sol: 0.2 }],
          error: null,
        },
        { data: null, error: null },
        { data: null, error: null, count: 0 },
      ],
    })

    await POST(req())
    await runDeferred()

    const close = (spy.writes.candy_sales_unresolved ?? []).find((w) => w.method === "update")
    expect(close?.rows[0]).toMatchObject({ resolution: "duplicate_tx_hash" })
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.drain_attempted).toBe(1)
    expect(extra.drain_resolved).toBe(0) // nothing new landed
  })

  it("reports ok=false when ME returns an entirely empty activities feed", async () => {
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", [])])
    const spy = install({ sales: [{ data: [], error: null }] })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toMatch(/empty|0 rows/i)
    expect((log?.p_extra as Record<string, unknown>).activities_seen).toBe(0)
  })
})

// Sealed-pack sales (added 2026-07-27). The ME collection mixes Item Type=Pack
// assets with the ICONs; a pack is not an edition, so a pack sale can never
// resolve. Before the dead letter these were counted `skipped` and dropped —
// the first three rows the dead letter caught in production were all packs
// trading at 0.39-0.45 SOL (~$30-34) against $10 retail, i.e. real market
// signal RPC was discarding. They are now recorded and closed in one pass so
// they never consume drain budget.
describe("candy-sales-indexer — sealed-pack sales", () => {
  it("records a pack sale and closes it out instead of retrying it forever", async () => {
    const acts: Act[] = [
      { signature: "sPack", type: "buyNow", tokenMint: "mPack", price: 0.45, blockTime: 1_700_002_000 },
    ]
    state.assets = { mPack: { key: "", serial: null, pack: true } }
    fetchMock = installFetchMock([jsonRoute("magiceden.dev", acts)])
    const spy = install({
      sales: [{ data: [], error: null }],
      candy_sales_unresolved: [{ data: [], error: null }, { data: null, error: null, count: 0 }],
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const park = spy.rpcCalls.find((c) => c.name === "candy_park_unresolved_sale")
    expect(park?.args).toMatchObject({ p_signature: "sPack", p_skip_reason: "pack_asset" })
    // The price is RECORDED even though it can never be a `sales` row.
    const packSale = (spy.writes.candy_pack_sales ?? []).flatMap((w) => w.rows)
    expect(packSale).toHaveLength(1)
    expect(packSale[0]).toMatchObject({
      transaction_hash: "sPack",
      token_mint: "mPack",
      price_sol: 0.45,
      price_usd: 67.5, // 0.45 SOL * 150
      sold_at: new Date(1_700_002_000 * 1000).toISOString(),
    })
    const close = (spy.writes.candy_sales_unresolved ?? []).find((w) => w.method === "update")
    expect(close?.rows[0]).toMatchObject({ resolution: "pack_asset" })
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.pack_sales_seen).toBe(1)
    // Closed rows are excluded from the drain selector, so a pack can never
    // consume the per-tick asset budget again.
    expect(extra.drain_attempted).toBe(0)
  })
})
