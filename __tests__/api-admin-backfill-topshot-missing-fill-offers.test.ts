import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { installFetchMock, jsonRoute } from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock } from "./helpers/flow-cdc-fixture"

// POST /api/admin/backfill-topshot-missing-fill-offers — recovers the offers row
// behind accepted offers that have none (sales.offer_id names an offer the indexer
// never recorded). Contracts pinned:
//   - only offers in topshot_offer_fill_missing_offers are written, as FILLED, with
//     created_at = the OfferAvailable block time, resolved_at = the fill sale's time,
//     fill_tx_hash = the fill tx; an OfferAvailable outside the set is ignored;
//   - insert-only (ON CONFLICT DO NOTHING);
//   - an offer the catalog cannot place takes the fill sale's edition (+ serial for
//     a serial offer);
//   - an HTTP error holds the cursor and logs ok:false.

type Op = { table: string; method: string; rows?: unknown; options?: unknown; filters: Array<[string, unknown[]]> }

const state = vi.hoisted(() => ({
  ops: [] as Op[],
  missing: [] as Array<Record<string, unknown>>,
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
}))

function builder(table: string) {
  const op: Op = { table, method: "select", filters: [] }
  state.ops.push(op)
  const resolve = () => {
    if (table === "event_cursor" && op.method === "select") return { data: { last_processed_block: 1000 }, error: null }
    if (table === "topshot_offer_fill_missing_offers") return { data: state.missing, error: null }
    if (table === "topshot_edition_aliases") return { data: [], error: null }
    if (table === "editions") return { data: [{ external_id: "8:133", id: "uuid-8133" }], error: null }
    if (table === "offers" && op.method === "upsert") return { data: op.rows, error: null }
    return { data: [], error: null }
  }
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "is", "not", "order", "limit"]) {
    b[m] = (...a: unknown[]) => {
      if (!(m === "select" && op.method === "select")) op.filters.push([m, a])
      return b
    }
  }
  b.upsert = (rows: unknown, options: unknown) => {
    op.method = "upsert"
    op.rows = rows
    op.options = options
    return b
  }
  b.maybeSingle = async () => resolve()
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad)
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpc.push({ name, args })
      return { data: null, error: null }
    },
  },
}))

process.env.INGEST_SECRET_TOKEN = "mf-token"
const { POST } = await import("@/app/api/admin/backfill-topshot-missing-fill-offers/route")

const TS_NFT = "A.0b2a3299cc857e29.TopShot.NFT"
const OFFERER = "0xbd94cade097e50ac"
const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"

const paramsDict = (entries: Record<string, string>) => ({
  type: "Dictionary",
  value: Object.entries(entries).map(([k, v]) => ({ key: cdc.string(k), value: cdc.string(v) })),
})

function avail(offerId: string, params: Record<string, string>) {
  return eventBlock({
    height: 1100,
    txId: `c${offerId}`.padEnd(64, "0"),
    eventType: OFFER_AVAILABLE,
    payload: cdcEvent(OFFER_AVAILABLE, {
      offerAddress: { type: "Address", value: OFFERER },
      offerId: cdc.uint64(offerId),
      nftType: cdc.nftType(TS_NFT),
      offerAmount: cdc.ufix64("4.00000000"),
      offerParamsString: paramsDict(params),
    }),
  })
}

const req = (headers: Record<string, string> = { authorization: "Bearer mf-token" }) =>
  new NextRequest("https://t/api/admin/backfill-topshot-missing-fill-offers", { method: "POST", headers: new Headers(headers) })

const offerUpserts = () => state.ops.filter((o) => o.table === "offers" && o.method === "upsert")
const cursorWrites = () => state.ops.filter((o) => o.table === "event_cursor" && o.method === "upsert")

let fetchMock: ReturnType<typeof installFetchMock> | null = null
beforeEach(() => {
  state.ops = []
  state.missing = []
  state.rpc = []
})
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})

describe("backfill-topshot-missing-fill-offers", () => {
  it("writes only offers in the missing set, as filled, with creation + fill times; the sale's edition places a serial offer the catalog can't", async () => {
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
      jsonRoute("OfferAvailable", [
        avail("801", { _type: "TopShotEdition", setId: "8", playId: "133" }), // missing → via catalog
        avail("802", { _type: "NFT", nftId: "999" }), // missing → via fill sale
        avail("803", { _type: "TopShotEdition", setId: "8", playId: "133" }), // NOT missing → ignored
      ]),
    ])
    state.missing = [
      { offer_id: "801", fill_tx: "f801", sold_at: "2026-07-20T00:00:00Z", edition_id: "uuid-sale-801", serial_number: 11 },
      { offer_id: "802", fill_tx: "f802", sold_at: "2026-07-21T00:00:00Z", edition_id: "uuid-sale-802", serial_number: 22 },
    ]

    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ ok: true, matched_missing: 2, inserted: 2, resolved_via_fill_sale: 1, unresolved: 0, cursor_after: "1250" })

    const up = offerUpserts()
    expect(up).toHaveLength(1)
    expect(up[0].options).toMatchObject({ onConflict: "offer_id", ignoreDuplicates: true })
    const rows = up[0].rows as Array<Record<string, unknown>>
    expect(rows.map((r) => r.offer_id).sort()).toEqual(["801", "802"])
    expect(rows.find((r) => r.offer_id === "801")).toMatchObject({
      status: "filled",
      edition_id: "uuid-8133",
      serial_number: null,
      created_at: "2026-07-17T12:00:00Z",
      resolved_at: "2026-07-20T00:00:00Z",
      fill_tx_hash: "f801",
      buyer_address: OFFERER,
      offer_amount_usd: 4,
      source: "onchain_backfill",
    })
    expect(rows.find((r) => r.offer_id === "802")).toMatchObject({ edition_id: "uuid-sale-802", serial_number: 22, offer_type: "serial" })
    expect(cursorWrites()[0]?.rows).toMatchObject({ last_processed_block: 1250 })
  })

  it("an HTTP error holds the cursor, writes nothing, and logs ok:false", async () => {
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
      jsonRoute("OfferAvailable", [], { status: 500 }),
    ])
    const body = await (await POST(req())).json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/HTTP 500/)
    expect(offerUpserts()).toHaveLength(0)
    expect(cursorWrites()).toHaveLength(0)
    expect(state.rpc.find((r) => r.name === "log_pipeline_run")?.args).toMatchObject({ p_ok: false })
  })

  it("rejects a missing token", async () => {
    expect((await POST(req({}))).status).toBe(401)
  })
})
