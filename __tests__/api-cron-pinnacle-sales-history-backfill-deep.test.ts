import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock, V2_DAPPER_LISTING_COMPLETED } from "./helpers/flow-cdc-fixture"

// Deep-drive of /api/cron/pinnacle-sales-history-backfill — the ON-CHAIN
// Pinnacle walker (single V2 Dapper source; Pinnacle was never on Flowty).
// Pinned contracts (incl. sibling drift):
//   - writes PINNACLE_SALES (render-keyed world), NOT the shared `sales` table,
//     and there is NO unmapped_sales lane: an unresolved nft still inserts with
//     edition_id NULL (counted in extra.unresolved_editions) — DRIFT vs every
//     other walker in this family;
//   - row contract: id=`${tx}_${nft}` (the dedup PK), sale_price_usd parsed
//     inline, serial_number null, source='on-chain-history-backfill' (the
//     one-DELETE revert tag), buyer=commissionReceiver, seller null;
//   - nftID -> edition_key ladder is pinnacle_nft_map first, wmc second;
//   - upsert(ignoreDuplicates) counts the whole batch as written on success —
//     dupes only surface as rowsSkipped via the 23505 arm;
//   - the resolve-buyers chain fires after EVERY non-dryRun run, even fatal
//     ones; dryRun writes/logs/chains nothing;
//   - first-init bisect failure logs ok=false and 200s (soft park).

const state = vi.hoisted(() => ({
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async (path: string, chain: boolean) =>
    void state.chained.push({ path, chain }),
}))

process.env.INGEST_SECRET_TOKEN = "pinnacle-history-token"
const { POST } = await import("@/app/api/cron/pinnacle-sales-history-backfill/route")

const PINNACLE_NFT = "A.edf9df96c92f4595.Pinnacle.NFT"
const CURSOR_ID = "pinnacle_sales_backfill"
const SPORK_FLOOR = 137_390_146
const CEILING = 145_000_000
const START = CEILING - 250

function pinnacleSale(
  nftId: string,
  price: string,
  txId: string,
  height: number,
  opts: { commission?: string; typeID?: string; purchased?: boolean } = {},
) {
  return eventBlock({
    height,
    txId,
    eventType: V2_DAPPER_LISTING_COMPLETED,
    payload: cdcEvent(V2_DAPPER_LISTING_COMPLETED, {
      listingResourceID: cdc.uint64(9400 + (Number(nftId) % 1000)),
      storefrontResourceID: cdc.uint64(1),
      purchased: cdc.bool(opts.purchased ?? true),
      nftType: cdc.nftType(opts.typeID ?? PINNACLE_NFT),
      nftID: cdc.uint64(nftId),
      salePrice: cdc.ufix64(price),
      commissionReceiver: opts.commission
        ? { type: "Optional", value: { type: "Address", value: opts.commission } }
        : cdc.optionalNull(),
    }),
  })
}

function flowStubs(opts: {
  events?: unknown[]
  sealedStatus?: number
  eventsHttp?: { status: number; text: string }
}): FetchStub[] {
  return [
    {
      match: (url) => url.includes("/v1/blocks?height=sealed"),
      respond: () =>
        opts.sealedStatus
          ? { status: opts.sealedStatus, ok: false, text: "boom" }
          : { json: [{ header: { height: String(SPORK_FLOOR + 1) } }] },
    },
    jsonRoute("/v1/blocks?height=", [{ header: { timestamp: "2026-05-01T00:00:00Z" } }]),
    opts.eventsHttp
      ? {
          match: (url: string) => url.includes("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"),
          respond: () => ({ status: opts.eventsHttp!.status, ok: false, text: opts.eventsHttp!.text }),
        }
      : jsonRoute("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", opts.events ?? []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(qs = "?range=250", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/cron/pinnacle-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer pinnacle-history-token" }),
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

const cursorFixture = { data: { last_processed_block: CEILING }, error: null }

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "pinnacle-history-token"
  delete process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.chained.length = 0
})

describe("pinnacle-sales-history-backfill — control paths", () => {
  it("401s without any token; the kill-switch (via the CRON ?token= lane) logs an honest ok run and chains nothing", async () => {
    const spy = install({})
    expect((await POST(req("?range=250", {}))).status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)

    process.env.CRON_SECRET = "vercel-cron-secret"
    process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res = await POST(req("?range=250&token=vercel-cron-secret", {}))
    expect(await res.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "disney_pinnacle" })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
    expect(state.chained).toHaveLength(0)
  })

  it("self-throttles on platform saturation and logs the skip", async () => {
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 17 } as never,
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "saturation", recent_fails: 17 })
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).skipped).toBe("saturation")
    expect(state.chained).toHaveLength(0)
  })

  it("a first-init bisect FAILURE logs ok=false and returns 200 bisect_failed without chaining", async () => {
    fetchMock = installFetchMock(flowStubs({ sealedStatus: 500 }))
    const spy = install({ event_cursor: { data: null, error: null } })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, error: "bisect_failed" })
    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toMatch(/^bisect_failed: /)
    expect(state.chained).toHaveLength(0)
  })
})

describe("pinnacle-sales-history-backfill — scan + write", () => {
  it("ingests Pinnacle sales into pinnacle_sales (map + wmc ladder, unresolved row kept with NULL edition), advances the cursor, chains resolve-buyers", async () => {
    const txA = "1".repeat(64)
    const txB = "2".repeat(64)
    const txC = "3".repeat(64)
    fetchMock = installFetchMock(
      flowStubs({
        events: [
          pinnacleSale("111", "4.00000000", txA, CEILING - 200, { commission: "0xaaaaaaaaaaaaaaaa" }),
          pinnacleSale("222", "6.50000000", txB, CEILING - 150),
          pinnacleSale("333", "2.00000000", txC, CEILING - 140, { commission: "0xbbbbbbbbbbbbbbbb" }),
          // A TopShot type + an unpurchased listing: filtered before accounting.
          pinnacleSale("998", "1.00000000", "8".repeat(64), CEILING - 130, { typeID: "A.0b2a3299cc857e29.TopShot.NFT" }),
          pinnacleSale("997", "1.00000000", "9".repeat(64), CEILING - 129, { purchased: false }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      pinnacle_nft_map: { data: [{ nft_id: "111", edition_key: "RC1:Standard:1" }], error: null },
      wallet_moments_cache: { data: [{ moment_id: "222", edition_key: "RC2:Chaser:2" }], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    const rows = (spy.writes.pinnacle_sales ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.nft_id === "111")).toEqual({
      id: `${txA}_111`, // the `${tx}_${nft}` PK convention
      edition_id: "RC1:Standard:1", // resolved via pinnacle_nft_map (rung 1)
      nft_id: "111",
      sale_price_usd: 4,
      serial_number: null,
      sold_at: "2026-07-17T12:00:00Z",
      source: "on-chain-history-backfill",
      buyer_address: "0xaaaaaaaaaaaaaaaa",
      seller_address: null,
    })
    expect(rows.find((r) => r.nft_id === "222")).toMatchObject({
      edition_id: "RC2:Chaser:2", // resolved via the wmc fallback (rung 2)
      buyer_address: null,
    })
    // The unresolved sale is STILL WRITTEN (null edition) — no unmapped_sales
    // lane exists in the pinnacle world; the resolver chain picks it up.
    expect(rows.find((r) => r.nft_id === "333")).toMatchObject({
      id: `${txC}_333`,
      edition_id: null,
      sale_price_usd: 2,
      buyer_address: "0xbbbbbbbbbbbbbbbb",
    })
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    expect(spy.writes.sales ?? []).toHaveLength(0)

    const cursorUpsert = (spy.writes.event_cursor ?? []).find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ id: CURSOR_ID, last_processed_block: START })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 3,
      p_rows_written: 3,
      p_rows_skipped: 0,
      p_cursor_before: String(CEILING),
      p_cursor_after: String(START),
      p_collection_slug: "disney_pinnacle",
    })
    expect(log?.p_extra).toMatchObject({
      scanned: `${START}-${CEILING - 1}`,
      ceiling: CEILING,
      blocks: 250,
      unresolved_editions: 1,
      below_floor: false,
      raw: 5,
      pinnacleIn: 3,
    })
    expect(state.chained).toEqual([{ path: "/api/pinnacle/resolve-buyers", chain: true }])
    expect(await res.json()).toMatchObject({
      ok: true,
      found: 3,
      sales_written: 3,
      duped: 0,
      next_ceiling: START,
    })
  })

  it("a whole-batch 23505 counts the batch as duped, never as written", async () => {
    fetchMock = installFetchMock(
      flowStubs({
        events: [pinnacleSale("444", "3.00000000", "4".repeat(64), CEILING - 120)],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      pinnacle_nft_map: { data: [{ nft_id: "444", edition_key: "RC3:Standard:1" }], error: null },
      pinnacle_sales: { error: { code: "23505", message: "duplicate key value" } },
    })

    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, found: 1, sales_written: 0, duped: 1 })
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_rows_written: 0, p_rows_skipped: 1 })
  })

  it("a fatal error mid-run logs ok=false, STILL chains resolve-buyers, and 500s", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({ event_cursor: cursorFixture }, { failWrites: ["event_cursor"] })

    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("event_cursor")
    // The chain is unconditional on non-dryRun exits — partial writes get drained.
    expect(state.chained).toEqual([{ path: "/api/pinnacle/resolve-buyers", chain: true }])
  })
})

describe("pinnacle-sales-history-backfill — the two non-2xx cases are not the same", () => {
  // ⚠ This route had no execution coverage for either case when its
  // `fetchEventRange` was fixed on 2026-08-21, which is exactly why it is added
  // here rather than left to the source guard: the source guard can tell you a
  // `throw` is present, not that the cursor stayed put.
  //
  // This cron walks history BACKWARD and then moves the cursor DOWN to `start`.
  // So an unread window ends up ABOVE the cursor, and nothing ever comes back
  // for it — there is no tailing indexer behind a history backfill.

  it("stops honestly at the spork floor: below_floor surfaced, run ok, cursor still advances", async () => {
    fetchMock = installFetchMock(
      flowStubs({ eventsHttp: { status: 404, text: "start height 1 is less than the spork root block height" } }),
    )
    const spy = install({ event_cursor: cursorFixture })
    const res = await POST(req())
    expect(res.status).toBe(200)
    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_ok).toBe(true)
    expect((log.p_extra as Record<string, unknown>).below_floor).toBe(true)
    // The floor is a real answer, so the backward walk continues past it.
    expect((spy.writes.event_cursor ?? []).length).toBeGreaterThan(0)
  })

  it("holds the cursor on a 500 and reports where it actually is", async () => {
    fetchMock = installFetchMock(flowStubs({ eventsHttp: { status: 500, text: "upstream boom" } }))
    const spy = install({ event_cursor: cursorFixture })
    const res = await POST(req())
    expect(res.status).toBe(500)
    // ⚠ Assert the ABSENCE of a cursor write. A value assertion passes if the
    // write merely moves somewhere else unexpected.
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error ?? "")).toMatch(/500/)
    // …and the logged cursor is the one that is really stored, not the one the
    // tick intended to write.
    expect(log.p_cursor_after).toBe(log.p_cursor_before)
  })
})

describe("pinnacle-sales-history-backfill — dryRun probe", () => {
  it("samples the scan but writes NOTHING, logs nothing, chains nothing", async () => {
    fetchMock = installFetchMock(
      flowStubs({
        events: [pinnacleSale("555", "9.00000000", "5".repeat(64), CEILING - 110, { commission: "0xcccccccccccccccc" })],
      }),
    )
    const spy = install({})

    const res = await POST(req(`?dryRun=true&range=250&ceiling=${CEILING}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "dryRun",
      scanned: `${START}-${CEILING - 1}`,
      ceiling: CEILING,
      found: 1,
      belowFloor: false,
    })
    expect(body.sample[0]).toMatchObject({ nft: "555", price: "9.00000000", buyer: "0xcccccccccccccccc" })
    expect(Object.keys(spy.writes)).toHaveLength(0)
    expect(spy.rpcCalls).toHaveLength(0)
    expect(state.chained).toHaveLength(0)
  })
})
