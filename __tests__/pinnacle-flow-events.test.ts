// Unit tests for lib/pinnacle/flow-events.ts — the Flow REST event decoder for
// completed Pinnacle sales. Covers the Cadence-event-payload → CompletedSale
// mapping (field extraction, Pinnacle-NFT-type filter, price/height parsing),
// the sealed-block-height parse, the ingest chunk loop, and the guard/error
// branches (!ok, thrown fetch, missing fields, upsert error). global fetch is
// stubbed with controlled Flow REST payloads; supabase is a hand-rolled stub.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchCompletedPinnacleSales,
  getCurrentBlockHeight,
  ingestPinnacleSalesEvents,
} from "@/lib/pinnacle/flow-events"

const PINNACLE_TYPE = "A.edf9df96c92f4595.Pinnacle.NFT"
const LISTING_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"

function field(name: string, value: string) {
  return { name, value: { type: "String", value } }
}

function pinnacleEvent(overrides: {
  fields?: { name: string; value: { type: string; value: string } }[]
  transaction_id?: string
} = {}) {
  return {
    type: LISTING_EVENT,
    transaction_id: overrides.transaction_id ?? "tx1",
    transaction_index: "0",
    event_index: "0",
    payload: {
      type: "Event",
      value: {
        id: "evt",
        fields: overrides.fields ?? [
          field("nftType", PINNACLE_TYPE),
          field("nftID", "555"),
          field("salePrice", "12.50"),
          field("buyer", "0xbuyer"),
          field("storefrontAddress", "0xseller"),
        ],
      },
    },
  }
}

function block(events: any[], overrides: Partial<{ block_height: string; block_timestamp: string }> = {}) {
  return {
    block_id: "b1",
    block_height: overrides.block_height ?? "100",
    block_timestamp: overrides.block_timestamp ?? "2026-07-01T00:00:00Z",
    events,
  }
}

function okJson(payload: any) {
  return { ok: true, status: 200, json: async () => payload, text: async () => "" }
}

afterEach(() => vi.unstubAllGlobals())

describe("fetchCompletedPinnacleSales", () => {
  it("decodes a Pinnacle sale from the event payload with correct field mapping", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([block([pinnacleEvent()])])))
    const sales = await fetchCompletedPinnacleSales(1, 100)
    expect(sales).toEqual([
      {
        nftId: "555",
        price: 12.5,
        buyerAddress: "0xbuyer",
        sellerAddress: "0xseller",
        blockHeight: 100,
        blockTimestamp: "2026-07-01T00:00:00Z",
        transactionId: "tx1",
      },
    ])
  })

  it("passes start/end height into the Flow events URL", async () => {
    const fetchMock = vi.fn(async () => okJson([]))
    vi.stubGlobal("fetch", fetchMock)
    await fetchCompletedPinnacleSales(500, 750)
    const url = (fetchMock.mock.calls[0] as any[])[0] as string
    expect(url).toContain(`type=${LISTING_EVENT}`)
    expect(url).toContain("start_height=500")
    expect(url).toContain("end_height=750")
  })

  it("skips non-Pinnacle NFT-type events", async () => {
    const other = pinnacleEvent({
      fields: [field("nftType", "A.1234.TopShot.NFT"), field("nftID", "1")],
    })
    vi.stubGlobal("fetch", vi.fn(async () => okJson([block([other])])))
    expect(await fetchCompletedPinnacleSales(1, 100)).toEqual([])
  })

  it("skips events with no payload fields", async () => {
    const noFields = { ...pinnacleEvent(), payload: { type: "Event", value: { id: "x", fields: null } } }
    vi.stubGlobal("fetch", vi.fn(async () => okJson([block([noFields as any])])))
    expect(await fetchCompletedPinnacleSales(1, 100)).toEqual([])
  })

  it("falls back nftId→nftID and seller→storefrontAddress, defaults missing price/buyer", async () => {
    // nftId (camel) present, no salePrice, no buyer, seller present (not storefrontAddress)
    const ev = pinnacleEvent({
      fields: [
        field("nftType", PINNACLE_TYPE),
        field("nftId", "42"),
        field("seller", "0xseller2"),
      ],
    })
    vi.stubGlobal("fetch", vi.fn(async () => okJson([block([ev])])))
    const [sale] = await fetchCompletedPinnacleSales(1, 100)
    expect(sale.nftId).toBe("42")
    expect(sale.price).toBe(0)
    expect(sale.buyerAddress).toBe("")
    expect(sale.sellerAddress).toBe("0xseller2")
  })

  it("throws on a non-ok response including the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, json: async () => [], text: async () => "rate limited" }))
    )
    await expect(fetchCompletedPinnacleSales(1, 100)).rejects.toThrow(/429/)
  })

  it("aggregates sales across multiple blocks/events", async () => {
    const payload = [
      block([pinnacleEvent({ transaction_id: "txA" })], { block_height: "100" }),
      block([pinnacleEvent({ transaction_id: "txB" })], { block_height: "101" }),
    ]
    vi.stubGlobal("fetch", vi.fn(async () => okJson(payload)))
    const sales = await fetchCompletedPinnacleSales(1, 200)
    expect(sales.map((s) => s.transactionId)).toEqual(["txA", "txB"])
    expect(sales.map((s) => s.blockHeight)).toEqual([100, 101])
  })
})

describe("getCurrentBlockHeight", () => {
  it("parses the sealed block height from an array response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([{ header: { height: "9999" } }])))
    expect(await getCurrentBlockHeight()).toBe(9999)
  })

  it("parses the sealed block height from a bare object response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ header: { height: "12345" } })))
    expect(await getCurrentBlockHeight()).toBe(12345)
  })

  it("throws on a non-ok blocks response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "down" }))
    )
    await expect(getCurrentBlockHeight()).rejects.toThrow(/503/)
  })
})

// ── ingest ──────────────────────────────────────────────────────────────────

/**
 * Minimal supabase stub. `state.cursorRow` seeds the backfill_state read;
 * `state.upsertError` / `state.cursorUpsertError` drive the two upsert paths.
 * `state.upserts` records the pinnacle_sales rows written.
 */
function makeSupabase(state: any) {
  return {
    from(table: string) {
      if (table === "backfill_state") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: state.cursorRow ?? null, error: null }),
            }),
          }),
          upsert: async (row: any) => {
            // Record what was actually STORED so a test can assert that the
            // returned new_cursor and the persisted cursor agree.
            state.cursorWrites = state.cursorWrites ?? []
            state.cursorWrites.push(row)
            return { error: state.cursorUpsertError ?? null }
          },
        }
      }
      // pinnacle_sales
      return {
        upsert: async (rows: any[]) => {
          state.upserts.push(...rows)
          return { error: state.upsertError ?? null }
        },
      }
    },
  } as any
}

describe("ingestPinnacleSalesEvents", () => {
  it("walks one chunk from an explicit cursor and upserts decoded sales", async () => {
    const state = { upserts: [] as any[] }
    // getCurrentBlockHeight then one fetchCompletedPinnacleSales chunk
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++
        if (call === 1) return okJson([{ header: { height: "300" } }]) // current height
        return okJson([block([pinnacleEvent()])]) // events chunk
      })
    )
    const supabase = makeSupabase(state)
    const res = await ingestPinnacleSalesEvents(supabase, 100)
    expect(res.new_cursor).toBe(300)
    expect(res.sales_ingested).toBe(1)
    expect(res.errors).toEqual([])
    expect(state.upserts[0]).toMatchObject({
      id: "flow_tx1_555",
      nft_id: "555",
      sale_price_usd: 12.5,
      source: "flow_events",
    })
  })

  it("reads the cursor from backfill_state when none is passed", async () => {
    const state = { upserts: [] as any[], cursorRow: { cursor: 290 } }
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++
        if (call === 1) return okJson([{ header: { height: "300" } }])
        return okJson([]) // no sales this chunk
      })
    )
    const res = await ingestPinnacleSalesEvents(makeSupabase(state), undefined)
    expect(res.sales_ingested).toBe(0)
    expect(res.new_cursor).toBe(300)
  })

  it("records an upsert error without incrementing sales_ingested", async () => {
    const state = { upserts: [] as any[], upsertError: { message: "boom" } }
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++
        if (call === 1) return okJson([{ header: { height: "300" } }])
        return okJson([block([pinnacleEvent()])])
      })
    )
    const res = await ingestPinnacleSalesEvents(makeSupabase(state), 100)
    expect(res.sales_ingested).toBe(0)
    expect(res.errors.some((e) => e.includes("Upsert error") && e.includes("boom"))).toBe(true)
  })

  it("captures a fetch throw as a chunk error and HOLDS the cursor at that chunk", async () => {
    // ⚠ INVERTED 2026-08-21, NOT deleted. This ended `expect(res.new_cursor).toBe(300)`
    // under the title "…and still advances the cursor" — the same
    // permanent-loss shape fixed that day in seventeen `app/api` routes, in an
    // eighteenth the guard could not see because it derives its population with
    // `grep -rl … app/api` and this implementation lives in `lib/`.
    //
    // The cursor advancing to the chain head over a chunk that never returned
    // means those blocks are below the cursor forever; nothing re-reads them.
    const state: any = { upserts: [] as any[] }
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++
        if (call === 1) return okJson([{ header: { height: "300" } }])
        throw new Error("network down")
      })
    )
    const res = await ingestPinnacleSalesEvents(makeSupabase(state), 100)
    expect(res.sales_ingested).toBe(0)
    expect(res.errors.some((e) => e.includes("Fetch error") && e.includes("network down"))).toBe(true)
    // The first (and only) chunk starts at 100, so the cursor holds at 99.
    expect(res.new_cursor).toBe(99)
    // ⚠ And what was STORED must equal what was reported — returning the head
    // while writing something lower is the fabricated-number shape.
    expect(state.cursorWrites?.at(-1)?.cursor).toBe(99)
  })

  it("a failed UPSERT holds the cursor too — a range fetched but not persisted is still unread", async () => {
    // The rows do not exist either way, so an upsert error must hold exactly
    // like a fetch error. Nothing asserted this before.
    const state = { upserts: [] as any[], upsertError: { message: "boom" } }
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++
        if (call === 1) return okJson([{ header: { height: "300" } }])
        return okJson([block([pinnacleEvent()])])
      })
    )
    const res = await ingestPinnacleSalesEvents(makeSupabase(state), 100)
    expect(res.errors.some((e) => e.includes("Upsert error"))).toBe(true)
    expect(res.new_cursor).toBe(99)
  })

  it("records the cursor-update error when the final upsert fails", async () => {
    const state = { upserts: [] as any[], cursorUpsertError: { message: "cursor fail" } }
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++
        if (call === 1) return okJson([{ header: { height: "300" } }])
        return okJson([])
      })
    )
    const res = await ingestPinnacleSalesEvents(makeSupabase(state), 100)
    expect(res.errors.some((e) => e.includes("Cursor update error") && e.includes("cursor fail"))).toBe(true)
  })

  it("no-ops the chunk loop when the cursor is already at the head", async () => {
    const state = { upserts: [] as any[] }
    vi.stubGlobal("fetch", vi.fn(async () => okJson([{ header: { height: "300" } }])))
    const res = await ingestPinnacleSalesEvents(makeSupabase(state), 300)
    expect(res.sales_ingested).toBe(0)
    expect(res.new_cursor).toBe(300)
    // Only the height fetch happened — no events fetch (loop body never ran).
    expect((globalThis.fetch as any).mock.calls.length).toBe(1)
  })
})
