import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/candy-opensea-sales-indexer. Pinned promises:
//   - a missing OPENSEA_API_KEY is ok=false naming the cause;
//   - no complete Magic Eden run on record -> nothing processed (a Magic Eden
//     trade must never be recorded as OpenSea's);
//   - a sale whose signature is already in `sales` (any venue) is NOT re-written;
//   - a new sale is written marketplace 'opensea' / source 'opensea_api', priced
//     on its own day, and the cursor advances past the walked window;
//   - a retryable miss (edition not ingested) HOLDS the cursor before it;
//   - the event walk asks only for windows ending before the Magic Eden ceiling.

const DAY = 86_400
const ME_START_ISO = "2026-09-02T12:00:00.000Z"
const ME_CEIL = Math.floor(Date.parse(ME_START_ISO) / 1000) - 600
const AUG31 = Math.floor(Date.parse("2026-08-31T00:00:00Z") / 1000)

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  rate: 150 as number | null,
  asset: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/solana/das", () => ({
  solUsdOn: async () => state.rate,
  getAsset: async () => {
    if (!state.asset) throw new Error("das down")
    return state.asset
  },
}))

const { POST } = await import("@/app/api/candy-opensea-sales-indexer/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    pipeline_runs: { data: [{ started_at: ME_START_ISO }], error: null },
    event_cursor: { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

const req = () =>
  new NextRequest("https://t/api/candy-opensea-sales-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer candy-token" }),
  })

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}
const logRun = (c: RecordedRpcCall[]) => c.filter((x) => x.name === "log_pipeline_run").at(-1)?.args

function sale(sig: string, mint: string, tSec: number, lamports = 2_000_000_000) {
  return {
    event_type: "sale",
    event_timestamp: tSec,
    transaction: sig,
    protocol_address: "OSprog",
    payment: { quantity: String(lamports), decimals: 9, symbol: "SOL" },
    seller: "SellerA",
    buyer: "BuyerB",
    quantity: 1,
    nft: { identifier: mint },
  }
}

/** Events stub: returns `events` for the first window only, empty after. */
function eventsRoute(events: unknown[]) {
  return {
    match: (url: string) => url.includes("/events/collection/candy-os?"),
    respond: (url: string) => {
      const after = Number(new URL(url).searchParams.get("after"))
      return { json: { asset_events: after < AUG31 + 60 ? events : [], next: null } }
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
  state.rate = 150
  state.asset = null
})

describe("candy-opensea-sales-indexer", () => {
  it("missing key -> ok=false naming the cause, no sweep deferred", async () => {
    delete process.env.OPENSEA_API_KEY
    const spy = install({})
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ accepted: false, skipped: "opensea_key_missing" })
    expect(state.afterCbs).toHaveLength(0)
    expect(String(logRun(spy.rpcCalls)?.p_error)).toContain("OPENSEA_API_KEY not set")
  })

  it("no complete Magic Eden run on record -> OpenSea sales are held, never walked", async () => {
    fetchMock = installFetchMock([])
    const spy = install({ pipeline_runs: { data: [], error: null } })
    await POST(req())
    await runDeferred()
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false })
    expect((log?.p_extra as Record<string, unknown>).skip_reason).toBe("me_ceiling_unknown")
    expect(fetchMock.calls).toHaveLength(0)
    expect(spy.writes.sales).toBeUndefined()
  })

  it("writes a new OpenSea sale, skips one already recorded by signature, advances the cursor", async () => {
    fetchMock = installFetchMock([
      eventsRoute([sale("sigNew", "mintA", AUG31 + 3600), sale("sigKnown", "mintB", AUG31 + 7200)]),
    ])
    const spy = install({
      sales: [
        { data: [{ transaction_hash: "sigKnown", nft_id: "mintB" }], error: null }, // signature dedup read
        { data: null, error: null }, // insert ok
      ],
      candy_pack_sales: { data: [], error: null },
      wallet_moments_cache: {
        data: [
          { moment_id: "mintA", edition_key: "k-trout", serial_number: 12 },
          { moment_id: "mintB", edition_key: "k-judge", serial_number: 3 },
        ],
        error: null,
      },
      editions: { data: [{ id: "ed-trout" }], error: null },
    })
    await POST(req())
    await runDeferred()

    const inserts = (spy.writes.sales ?? []).filter((w) => w.method === "insert")
    expect(inserts).toHaveLength(1)
    expect(inserts[0].rows).toEqual([
      expect.objectContaining({
        nft_id: "mintA",
        edition_id: "ed-trout",
        serial_number: 12,
        price_native: 2,
        currency: "SOL",
        price_usd: 300, // 2 SOL * 150 on the sale's own day
        marketplace: "opensea",
        source: "opensea_api",
        transaction_hash: "sigNew",
        sold_at: new Date((AUG31 + 3600) * 1000).toISOString(),
      }),
    ])
    expect(JSON.stringify(spy.writes.sales)).not.toContain("sigKnown")

    // Cursor advanced past the first window.
    const cursor = (spy.writes.event_cursor ?? []).filter((w) => w.method === "upsert")
    expect(cursor[0].rows[0]).toMatchObject({ id: "candy_opensea_sales", last_processed_block: AUG31 + DAY })

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1 })
    const extra = log?.p_extra as Record<string, unknown>
    expect((extra.skip_reasons as Record<string, number>).skipped_known_signature).toBe(1)
    expect(extra.caught_up).toBe(true)

    // No window reaches past the Magic Eden ceiling.
    for (const c of fetchMock.calls) {
      expect(Number(new URL(c.url).searchParams.get("before"))).toBeLessThanOrEqual(ME_CEIL)
    }
  })

  it("an edition not yet ingested HOLDS the cursor just before that sale (retried next tick)", async () => {
    const t = AUG31 + 5000
    fetchMock = installFetchMock([eventsRoute([sale("sigHold", "mintC", t)])])
    const spy = install({
      sales: { data: [], error: null },
      candy_pack_sales: { data: [], error: null },
      wallet_moments_cache: { data: [{ moment_id: "mintC", edition_key: "k-new", serial_number: 1 }], error: null },
      editions: { data: [], error: null }, // not ingested yet
    })
    await POST(req())
    await runDeferred()
    expect((spy.writes.sales ?? []).filter((w) => w.method === "insert")).toHaveLength(0)
    const cursor = (spy.writes.event_cursor ?? []).filter((w) => w.method === "upsert")
    expect(cursor[0].rows[0]).toMatchObject({ last_processed_block: t - 1 })
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.held_by_unresolved).toBe(true)
    expect(extra.abandoned_count).toBe(0)
    expect((extra.skip_reasons as Record<string, number>).edition_not_ingested).toBe(1)
  })

  it("a cursor stuck past HOLD_MAX_DAYS passes the blocking sale, counted as abandoned with its signature", async () => {
    const t = AUG31 + 5000
    fetchMock = installFetchMock([eventsRoute([sale("sigStuck", "mintC", t)])])
    const spy = install({
      event_cursor: { data: { last_processed_block: AUG31, updated_at: new Date(Date.now() - 4 * DAY * 1000).toISOString() }, error: null },
      sales: { data: [], error: null },
      candy_pack_sales: { data: [], error: null },
      wallet_moments_cache: { data: [{ moment_id: "mintC", edition_key: "k-new", serial_number: 1 }], error: null },
      editions: { data: [], error: null },
    })
    await POST(req())
    await runDeferred()
    const extra = logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.abandoned_count).toBe(1)
    expect(extra.abandoned).toEqual([{ signature: "sigStuck", reason: "edition_not_ingested" }])
    expect(extra.held_by_unresolved).toBe(false)
  })

  it("a failed cursor read fails the run instead of rewinding to the default start", async () => {
    fetchMock = installFetchMock([])
    const spy = install({ event_cursor: { data: null, error: { message: "cursor boom" } } })
    await POST(req())
    await runDeferred()
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false })
    expect(String(log?.p_error)).toContain("cursor read failed: cursor boom")
    expect(fetchMock.calls).toHaveLength(0)
  })
})
