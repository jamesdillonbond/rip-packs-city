import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { installFetchMock, jsonRoute } from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock } from "./helpers/flow-cdc-fixture"

// POST /api/admin/backfill-topshot-offers — the one-shot history walk that
// recovers Top Shot offers the live indexer dropped because they were created
// AND completed inside one tick (fixed forward 2026-10-10).
// Contracts pinned:
//   - an offer completed in range whose creation was seen (incl. in the
//     LOOKBACK before `start`) and that is ABSENT from `offers` is inserted with
//     its terminal status, the COMPLETION block ts and (filled) the fill tx;
//   - never an "open" row (created in range, not completed → not written);
//   - never an overwrite (already-present offer not written; ON CONFLICT DO
//     NOTHING on the insert);
//   - an HTTP error on an event read holds the cursor and logs ok:false.

type Op = { table: string; method: string; rows?: unknown; options?: unknown; filters: Array<[string, unknown[]]> }

const state = vi.hoisted(() => ({
  ops: [] as Op[],
  present: [] as string[],
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
}))

function builder(table: string) {
  const op: Op = { table, method: "select", filters: [] }
  state.ops.push(op)
  const resolve = () => {
    if (table === "event_cursor" && op.method === "select") return { data: { last_processed_block: 1000 }, error: null }
    if (table === "topshot_edition_aliases") return { data: [], error: null }
    if (table === "editions") return { data: [{ external_id: "8:133", id: "uuid-8133" }], error: null }
    if (table === "moments") return { data: [], error: null }
    if (table === "offers" && op.method === "select") return { data: state.present.map((offer_id) => ({ offer_id })), error: null }
    if (table === "offers" && op.method === "upsert") return { data: op.rows, error: null }
    return { data: null, error: null }
  }
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "is", "order", "range", "limit", "gte", "lte"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "select" && op.method === "select") return b
      op.filters.push([m, a])
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
  b.single = async () => resolve()
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

process.env.INGEST_SECRET_TOKEN = "bf-token"
const { POST } = await import("@/app/api/admin/backfill-topshot-offers/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_NFT = "A.0b2a3299cc857e29.TopShot.NFT"
const OFFERER = "0xbd94cade097e50ac"
const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"

const paramsDict = (entries: Record<string, string>) => ({
  type: "Dictionary",
  value: Object.entries(entries).map(([k, v]) => ({ key: cdc.string(k), value: cdc.string(v) })),
})

function avail(offerId: string, height: number) {
  return eventBlock({
    height,
    txId: `c${offerId}`.padEnd(64, "0"),
    eventType: OFFER_AVAILABLE,
    payload: cdcEvent(OFFER_AVAILABLE, {
      offerAddress: { type: "Address", value: OFFERER },
      offerId: cdc.uint64(offerId),
      nftType: cdc.nftType(TS_NFT),
      offerAmount: cdc.ufix64("4.00000000"),
      offerParamsString: paramsDict({ _type: "TopShotEdition", setId: "8", playId: "133" }),
    }),
  })
}

function completed(offerId: string, height: number, purchased: boolean) {
  return {
    ...eventBlock({
      height,
      txId: `f${offerId}`.padEnd(64, "0"),
      eventType: OFFER_COMPLETED,
      payload: cdcEvent(OFFER_COMPLETED, {
        purchased: cdc.bool(purchased),
        acceptingAddress: cdc.optionalNull(),
        offerAddress: { type: "Address", value: OFFERER },
        offerId: cdc.uint64(offerId),
        nftType: cdc.nftType(TS_NFT),
        offerAmount: cdc.ufix64("4.00000000"),
        offerType: cdc.string("x"),
        offerParamsString: paramsDict({}),
        nftId: cdc.optionalNull(),
      }),
    }),
    block_timestamp: "2026-07-17T12:05:00Z",
  }
}

function req(): NextRequest {
  return new NextRequest("https://t/api/admin/backfill-topshot-offers", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer bf-token" }),
  })
}

const offerUpserts = () => state.ops.filter((o) => o.table === "offers" && o.method === "upsert")
const cursorWrites = () => state.ops.filter((o) => o.table === "event_cursor" && o.method === "upsert")

let fetchMock: ReturnType<typeof installFetchMock> | null = null
beforeEach(() => {
  state.ops = []
  state.present = []
  state.rpc = []
})
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})

describe("backfill-topshot-offers", () => {
  it("inserts only ABSENT offers completed in range, with terminal status — never open, never an overwrite", async () => {
    // cursor 1000, sealed 1250 → range 1001-1250; lookback reaches back to 0.
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
      // 701: created in the LOOKBACK, filled in range, absent  → inserted (filled)
      // 702: created in range, cancelled in range, absent      → inserted (cancelled)
      // 703: created in range, still open                      → NOT written
      // 704: created + filled in range but ALREADY PRESENT     → NOT written
      jsonRoute("OfferAvailable", [avail("701", 900), avail("702", 1100), avail("703", 1110), avail("704", 1120)]),
      jsonRoute("OfferCompleted", [completed("701", 1200, true), completed("702", 1201, false), completed("704", 1202, true)]),
    ])
    state.present = ["704"]

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, inserted: 2, inserted_filled: 1, inserted_cancelled: 1, already_present: 1, cursor_after: "1250" })

    const ups = offerUpserts()
    expect(ups).toHaveLength(1)
    expect(ups[0].options).toMatchObject({ onConflict: "offer_id", ignoreDuplicates: true })
    const rows = ups[0].rows as Array<Record<string, unknown>>
    expect(rows.map((r) => r.offer_id).sort()).toEqual(["701", "702"])
    expect(rows.some((r) => r.status === "open")).toBe(false)
    expect(rows.some((r) => r.offer_id === "703" || r.offer_id === "704")).toBe(false)
    expect(rows.find((r) => r.offer_id === "701")).toMatchObject({
      collection_id: TS,
      edition_id: "uuid-8133",
      buyer_address: OFFERER,
      offer_type: "edition",
      source: "onchain_backfill",
      offer_amount_usd: 4,
      status: "filled",
      created_at: "2026-07-17T12:00:00Z",
      resolved_at: "2026-07-17T12:05:00Z",
      fill_tx_hash: "f701".padEnd(64, "0"),
    })
    expect(rows.find((r) => r.offer_id === "702")).toMatchObject({ status: "cancelled", fill_tx_hash: null })
    expect(cursorWrites()[0]?.rows).toMatchObject({ last_processed_block: 1250 })
  })

  it("an HTTP error on an event read holds the cursor, writes nothing, and logs ok:false", async () => {
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
      jsonRoute("OfferAvailable", [], { status: 503 }),
      jsonRoute("OfferCompleted", []),
    ])
    const res = await POST(req())
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/HTTP 503/)
    expect(body.cursor_after).toBeNull()
    expect(offerUpserts()).toHaveLength(0)
    expect(cursorWrites()).toHaveLength(0)
    const log = state.rpc.find((r) => r.name === "log_pipeline_run")
    expect(log?.args).toMatchObject({ p_pipeline: "backfill-topshot-offers", p_ok: false })
  })

  it("rejects a missing token", async () => {
    const res = await POST(new NextRequest("https://t/api/admin/backfill-topshot-offers", { method: "POST" }))
    expect(res.status).toBe(401)
  })
})
