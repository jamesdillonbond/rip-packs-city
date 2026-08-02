import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/market — ?specialSerials=true on the LEGACY (cached_listings) path.
//
// REGRESSION GUARD for the 2026-08-02 fix.
//
// The defect: collapseToEditions() — which runs only on the legacy path, i.e.
// Golazos and UFC, since TS/AllDay/Pinnacle aggregate at their source —
// unconditionally emitted `isSpecialSerial: false` on every collapsed row, and
// the specialSerials predicate runs AFTER that collapse. So the filter could
// only ever return an EMPTY board: a #1 serial present in cached_listings was
// discarded along with everything else. The modern aggregated path was always
// correct (it filters per-row values with no collapse in between).
//
// The fix carries the REPRESENTATIVE (floor-ask) listing's flag through the
// collapse, so the param means the same thing on both paths:
//
//     "this edition's headline listing is a #1 or a perfect (#N/N) mint"
//
// Market stays EDITION-grain (Trevor, 2026-07-18): `serialNumber` is still
// null on collapsed rows. This is a flag, not a serial — per-serial
// affordances belong on Sniper.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

import { GET } from "@/app/api/market/route"

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"

const req = (u: string) => ({ nextUrl: new URL(u) }) as never

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

// Distinct player per index so collapseToEditions groups 1:1 unless a test
// deliberately reuses an index to force a collision.
function listing(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `L${i}`,
    flow_id: `F${i}`,
    moment_id: null,
    player_name: `Player ${i}`,
    set_name: "Base Set",
    series_name: "1",
    tier: "COMMON",
    ask_price: 10 + i,
    fmv: 100,
    confidence: "HIGH",
    serial_number: i + 2,
    circulation_count: 500,
    badge_slugs: [],
    listed_at: `2026-07-${String(10 + (i % 18)).padStart(2, "0")}T00:00:00Z`,
    collection_id: GOLAZOS,
    ...over,
  }
}

const call = async (qs: string) => {
  const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}&${qs}`))
  return res.json()
}

describe("GET /api/market — ?specialSerials=true (legacy cached_listings path)", () => {
  beforeEach(() => {
    state.sb = null
    vi.clearAllMocks()
  })

  it("keeps #1 mints and drops ordinary serials", async () => {
    install({
      cached_listings: {
        data: [
          listing(0, { serial_number: 1 }), // #1 — kept
          listing(1, { serial_number: 7 }), // ordinary — dropped
        ],
        error: null,
        count: 2,
      },
      editions: { data: [], error: null },
    })

    const body = await call("specialSerials=true")
    expect(body.listings.map((r: never) => (r as { playerName: string }).playerName)).toEqual(["Player 0"])
  })

  it("keeps a perfect (#N/N) mint, not just #1", async () => {
    install({
      cached_listings: {
        data: [
          listing(0, { serial_number: 500, circulation_count: 500 }), // perfect — kept
          listing(1, { serial_number: 7, circulation_count: 500 }),   // ordinary — dropped
        ],
        error: null,
        count: 2,
      },
      editions: { data: [], error: null },
    })

    const body = await call("specialSerials=true")
    expect(body.listings.map((r: never) => (r as { playerName: string }).playerName)).toEqual(["Player 0"])
  })

  it("returns the whole board when the filter is off", async () => {
    // Proves the filter is the thing selecting rows — guards against a future
    // change that makes the control a silent no-op returning everything.
    install({
      cached_listings: {
        data: [listing(0, { serial_number: 1 }), listing(1, { serial_number: 7 })],
        error: null,
        count: 2,
      },
      editions: { data: [], error: null },
    })

    const body = await call("sort=discount_desc")
    expect(body.listings).toHaveLength(2)
  })

  it("keeps Market edition-grain: the flag survives the collapse, the serial does not", async () => {
    install({
      cached_listings: { data: [listing(0, { serial_number: 1 })], error: null, count: 1 },
      editions: { data: [], error: null },
    })

    const body = await call("specialSerials=true")
    const row = body.listings[0] as { isSpecialSerial: boolean; serialNumber: number | null }
    expect(row.isSpecialSerial).toBe(true)
    expect(row.serialNumber).toBeNull()
  })

  it("within one edition, the FLOOR-ask listing decides the flag", async () => {
    // Same player+set+tier => one collapsed edition. The cheapest listing is the
    // #1, so the edition qualifies.
    install({
      cached_listings: {
        data: [
          listing(0, { ask_price: 5, serial_number: 1 }),
          listing(0, { ask_price: 90, serial_number: 42, id: "L0b", flow_id: "F0b" }),
        ],
        error: null,
        count: 2,
      },
      editions: { data: [], error: null },
    })

    const body = await call("specialSerials=true")
    expect(body.listings).toHaveLength(1)
    const row = body.listings[0] as { listedCount: number; askPrice: number }
    expect(row.listedCount).toBe(2) // genuinely collapsed, not two separate rows
    expect(row.askPrice).toBe(5)
  })

  it("excludes an edition whose floor listing is NOT special, even if a #1 is listed higher", async () => {
    // The inverse. Claiming this edition otherwise would advertise a #1 at a
    // floor price you cannot actually get it for.
    install({
      cached_listings: {
        data: [
          listing(0, { ask_price: 5, serial_number: 42 }),
          listing(0, { ask_price: 90, serial_number: 1, id: "L0b", flow_id: "F0b" }),
        ],
        error: null,
        count: 2,
      },
      editions: { data: [], error: null },
    })

    const body = await call("specialSerials=true")
    expect(body.listings).toHaveLength(0)
  })
})
