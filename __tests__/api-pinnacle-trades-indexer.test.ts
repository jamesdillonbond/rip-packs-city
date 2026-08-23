import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"

// Drive of GET/POST /api/cron/pinnacle-trades-indexer — the Disney Pinnacle
// TRADE walker, the third Pinnacle transaction type after the storefront sale
// and the primary mint. Pinned contracts:
//   - dual secret: INGEST_SECRET_TOKEN or Vercel's CRON_SECRET; fails CLOSED
//     when both are unset, so an unconfigured deploy cannot be walked in;
//   - reads BOTH Pinnacle event streams (Withdraw + Deposit) for each range;
//   - writes only the bidirectional two-wallet swaps into pinnacle_trade_events;
//   - a storefront-shaped move (one sender, one receiver, one Pin) is NOT
//     written, and a mint (deposit with no withdraw) is NOT written;
//   - the tx-shape census ships in pipeline_runs.extra on EVERY tick;
//   - a cursor-read error 500s; a chunk failure holds the cursor.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

process.env.INGEST_SECRET_TOKEN = "trades-indexer-token"
process.env.CRON_SECRET = "vercel-cron-secret"
const { GET, POST } = await import("@/app/api/cron/pinnacle-trades-indexer/route")

const WITHDRAW = "A.edf9df96c92f4595.Pinnacle.Withdraw"
const DEPOSIT = "A.edf9df96c92f4595.Pinnacle.Deposit"
const SEALED = 1300
const CURSOR_START = 1000
const A = "0x23dde701491082ad"
const B = "0xf3494b5641de2837"

/** One Pinnacle Withdraw/Deposit event, encoded the way Flow REST serves it. */
function moveEvent(kind: "withdraw" | "deposit", txId: string, nftId: string, address: string) {
  const id = kind === "withdraw" ? WITHDRAW : DEPOSIT
  const fieldName = kind === "withdraw" ? "from" : "to"
  return {
    type: id,
    transaction_id: txId,
    event_index: 0,
    payload: Buffer.from(
      JSON.stringify({
        type: "Event",
        value: {
          id,
          fields: [
            { name: "id", value: { type: "UInt64", value: nftId } },
            {
              name: fieldName,
              value: { type: "Optional", value: { type: "Address", value: address } },
            },
          ],
        },
      }),
    ).toString("base64"),
  }
}

function block(height: number, events: unknown[]) {
  return {
    block_id: "b".repeat(64),
    block_height: String(height),
    block_timestamp: "2026-08-22T20:00:00Z",
    events,
  }
}

function flowStubs(opts: {
  withdraws?: unknown[]
  deposits?: unknown[]
  sealedHeight?: number
  sealedStatus?: number
  withdrawStatus?: number
}): FetchStub[] {
  return [
    {
      match: (url) => url.includes("/v1/blocks?height=sealed"),
      respond: () =>
        opts.sealedStatus
          ? { status: opts.sealedStatus, ok: false, text: "boom" }
          : { json: [{ header: { height: String(opts.sealedHeight ?? SEALED) } }] },
    },
    {
      match: (url) => url.includes("Pinnacle.Withdraw"),
      respond: () =>
        opts.withdrawStatus
          ? { status: opts.withdrawStatus, ok: false, text: "boom" }
          : { json: opts.withdraws ?? [] },
    },
    jsonRoute("Pinnacle.Deposit", opts.deposits ?? []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(qs = "?range=250", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/cron/pinnacle-trades-indexer${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer trades-indexer-token" }),
  })
}

const cursorFixture = { data: { last_processed_block: CURSOR_START }, error: null }

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "trades-indexer-token"
  process.env.CRON_SECRET = "vercel-cron-secret"
})

/** A two-wallet bidirectional swap: A→B and B→A inside one transaction. */
function tradeBlocks() {
  return {
    withdraws: [block(1100, [moveEvent("withdraw", "tx-trade", "n1", A)]),
                block(1101, [moveEvent("withdraw", "tx-trade", "n2", B)])],
    deposits: [block(1100, [moveEvent("deposit", "tx-trade", "n1", B)]),
               block(1101, [moveEvent("deposit", "tx-trade", "n2", A)])],
  }
}

describe("pinnacle-trades-indexer — auth", () => {
  it("401s without a token and does no DB work", async () => {
    const spy = install({})
    const res = await POST(new NextRequest("https://t/api/cron/pinnacle-trades-indexer", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(Object.keys(spy.writes)).toHaveLength(0)
  })

  it("accepts Vercel's CRON_SECRET as well as the ingest token", async () => {
    // The route is scheduled from vercel.json, which injects CRON_SECRET. A
    // single-secret gate would 401 every tick — and a 401 writes NO
    // pipeline_runs row, so it reads exactly like "never scheduled".
    fetchMock = installFetchMock(flowStubs({ sealedHeight: CURSOR_START }))
    install({ event_cursor: cursorFixture })
    const res = await GET(req("?range=250", { authorization: "Bearer vercel-cron-secret" }))
    expect(res.status).toBe(200)
  })

  it("fails CLOSED when both secrets are unset — an empty presented token matches nothing", async () => {
    process.env.INGEST_SECRET_TOKEN = ""
    process.env.CRON_SECRET = ""
    vi.resetModules()
    const fresh = await import("@/app/api/cron/pinnacle-trades-indexer/route")
    install({ event_cursor: cursorFixture })
    const res = await fresh.POST(
      new NextRequest("https://t/api/cron/pinnacle-trades-indexer?token=", { method: "POST" }),
    )
    expect(res.status).toBe(401)
  })
})

describe("pinnacle-trades-indexer — what it writes", () => {
  it("writes one row per Pin for a two-wallet bidirectional swap, both directions", async () => {
    fetchMock = installFetchMock(flowStubs(tradeBlocks()))
    const spy = install({ event_cursor: cursorFixture, pinnacle_nft_map: { data: [], error: null } })
    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, tradeTxs: 1, pinsTraded: 2 })

    const written = (spy.writes.pinnacle_trade_events ?? []).flatMap((w: any) =>
      Array.isArray(w.rows) ? w.rows : [w.rows],
    )
    expect(written).toHaveLength(2)
    expect(written.map((r: any) => [r.from_wallet, r.to_wallet]).sort()).toEqual([
      [A, B],
      [B, A],
    ])
    // pins_in_trade is trade SIZE — both legs are ONE trade of two Pins.
    expect(written.every((r: any) => r.pins_in_trade === 2)).toBe(true)
    expect(written.every((r: any) => r.source === "on-chain")).toBe(true)
    // Unresolved edition is written as NULL, never dropped and never guessed.
    expect(written.every((r: any) => r.edition_id === null)).toBe(true)
  })

  it("does NOT write a storefront-shaped move (one sender, one receiver, one Pin)", async () => {
    fetchMock = installFetchMock(
      flowStubs({
        withdraws: [block(1100, [moveEvent("withdraw", "tx-sale", "n1", A)])],
        deposits: [block(1100, [moveEvent("deposit", "tx-sale", "n1", B)])],
      }),
    )
    const spy = install({ event_cursor: cursorFixture })
    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ ok: true, tradeTxs: 0, pinsTraded: 0 })
    expect(spy.writes.pinnacle_trade_events ?? []).toHaveLength(0)
    expect(body.txShapes.sale_or_one_way).toBe(1)
  })

  it("does NOT write a mint — a deposit with no withdraw", async () => {
    fetchMock = installFetchMock(
      flowStubs({ deposits: [block(1100, [moveEvent("deposit", "tx-mint", "n1", A)])] }),
    )
    const spy = install({ event_cursor: cursorFixture })
    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ tradeTxs: 0, pinsTraded: 0 })
    expect(spy.writes.pinnacle_trade_events ?? []).toHaveLength(0)
    expect(body.txShapes.mint_or_deposit_only).toBe(1)
  })

  it("resolves edition_id from pinnacle_nft_map when the Pin is mapped", async () => {
    fetchMock = installFetchMock(flowStubs(tradeBlocks()))
    const spy = install({
      event_cursor: cursorFixture,
      pinnacle_nft_map: { data: [{ nft_id: "n1", edition_key: "ed-n1" }], error: null },
    })
    await POST(req())
    const written = (spy.writes.pinnacle_trade_events ?? []).flatMap((w: any) =>
      Array.isArray(w.rows) ? w.rows : [w.rows],
    )
    const byNft = Object.fromEntries(written.map((r: any) => [r.nft_id, r.edition_id]))
    expect(byNft.n1).toBe("ed-n1")
    expect(byNft.n2).toBeNull()
  })
})

describe("pinnacle-trades-indexer — observability and control paths", () => {
  it("ships the tx-shape census on an EMPTY tick, so a shape change cannot read as a quiet week", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({ event_cursor: cursorFixture })
    await POST(req())
    const logged = spy.rpcCalls.filter((c) => c.name === "log_pipeline_run")
    expect(logged).toHaveLength(1)
    const extra = (logged[0].args as any)!.p_extra
    expect(extra.phase).toBe("no_trades")
    expect(extra.tx_shapes).toEqual({
      trade: 0,
      sale_or_one_way: 0,
      mint_or_deposit_only: 0,
      unclassified: 0,
    })
  })

  it("500s 'Failed to read cursor' on a cursor-read error and writes nothing", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({ event_cursor: { data: null, error: { message: "denied" } } })
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to read cursor")
    expect(spy.writes.pinnacle_trade_events ?? []).toHaveLength(0)
  })

  it("an 'up to date' tick still logs ok, because the watchlist keys on SILENCE", async () => {
    fetchMock = installFetchMock(flowStubs({ sealedHeight: CURSOR_START }))
    const spy = install({ event_cursor: cursorFixture })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, message: "already up to date" })
    const logged = spy.rpcCalls.filter((c) => c.name === "log_pipeline_run")
    expect(logged).toHaveLength(1)
    expect((logged[0].args as any)!.p_ok).toBe(true)
  })

  it("a failed event-range fetch marks the run partial rather than reporting a clean scan", async () => {
    fetchMock = installFetchMock(flowStubs({ withdrawStatus: 503 }))
    const spy = install({ event_cursor: cursorFixture })
    const res = await POST(req())
    expect(res.status).toBe(200)
    const logged = spy.rpcCalls.filter((c) => c.name === "log_pipeline_run")
    const extra = (logged[0].args as any)!.p_extra
    expect(extra.partial_scan).toBe(true)
    expect(extra.first_failed_chunk).toBe(CURSOR_START + 1)
    // ⚠ blocks_scanned must report what was READ. A failed first chunk read none.
    expect(extra.blocks_scanned).toBe(0)
  })

  it("a fatal sealed-height failure 500s and logs ok:false", async () => {
    fetchMock = installFetchMock(flowStubs({ sealedStatus: 500 }))
    const spy = install({ event_cursor: cursorFixture })
    const res = await POST(req())
    expect(res.status).toBe(500)
    const logged = spy.rpcCalls.filter((c) => c.name === "log_pipeline_run")
    expect((logged[0].args as any)!.p_ok).toBe(false)
  })
})
