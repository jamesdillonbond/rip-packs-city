import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/insider/signals — composes three Supabase table reads
// (topshot_insider_alerts / topshot_insider_buybacks / external_announcements)
// via chained supabaseAdmin.from() builders. Mocks the builder per fmv-demo
// template. Pins the empty has_data=false gate and a populated has_data=true
// path with buyback name-filtering.

const tables: Record<string, { data: any; error?: any }> = {}

vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b,
      or: () => b,
      order: () => b,
      in: () => b,
      limit: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { GET } from "@/app/api/analytics/insider/signals/route"

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe("GET /api/analytics/insider/signals", () => {
  it("reports has_data=false when every source is empty", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.has_data).toBe(false)
    expect(body.alerts).toEqual([])
    expect(body.buybacks).toEqual([])
    expect(body.announcements).toEqual([])
    expect(typeof body.generated_at).toBe("string")
  })

  it("surfaces alerts and name-resolved buybacks with has_data=true", async () => {
    tables.topshot_insider_alerts = {
      data: [{ id: "a1", alert_type: "spike", title: "T", summary: "S", severity: "high", generated_at: "2026-07-12T00:00:00Z", expires_at: null }],
    }
    tables.topshot_insider_buybacks = {
      data: [{ id: "b1", moment_id: 9, price_usd: 100, sold_at: "2026-07-12T00:00:00Z", editions: { player_name: "Damian Lillard", set_name: "Cosmic" } }],
    }
    const res = await GET()
    const body = await res.json()
    expect(body.has_data).toBe(true)
    expect(body.alerts).toHaveLength(1)
    expect(body.buybacks).toHaveLength(1)
    expect(body.buybacks[0].player_name).toBe("Damian Lillard")
  })

  it("drops unresolvable buybacks (no player name) from the payload", async () => {
    tables.topshot_insider_buybacks = {
      // moment_id null → name fallback can't fire → filtered out
      data: [{ id: "b2", moment_id: null, price_usd: 5, sold_at: "2026-07-12T00:00:00Z", editions: null }],
    }
    const body = await (await GET()).json()
    expect(body.buybacks).toEqual([])
    expect(body.has_data).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The moment -> edition NAME FALLBACK (many buyback rows carry no edition_id,
// only a moment_id) plus the per-table error branches and the outer catch.
// These were dark because the fixtures never populated moments/editions.
// ---------------------------------------------------------------------------

describe("GET /api/analytics/insider/signals — buyback name fallback", () => {
  it("resolves a nameless buyback through moments -> editions", async () => {
    tables.topshot_insider_buybacks = {
      data: [{ id: "b1", moment_id: 42, price_usd: 12, sold_at: "2026-07-12T00:00:00Z", editions: null }],
    }
    tables.moments = { data: [{ nft_id: 42, edition_id: "ed-1" }] }
    tables.editions = { data: [{ id: "ed-1", player_name: "Ja Morant", set_name: "Base Set" }] }

    const body = await (await GET()).json()
    expect(body.buybacks).toHaveLength(1)
    expect(body.buybacks[0].player_name).toBe("Ja Morant")
    expect(body.buybacks[0].set_name).toBe("Base Set")
    expect(body.has_data).toBe(true)
  })

  it("still drops the row when the moment maps to no edition", async () => {
    tables.topshot_insider_buybacks = {
      data: [{ id: "b1", moment_id: 42, price_usd: 12, sold_at: "2026-07-12T00:00:00Z", editions: null }],
    }
    tables.moments = { data: [{ nft_id: 42, edition_id: null }] }
    const body = await (await GET()).json()
    expect(body.buybacks).toEqual([])
  })

  it("still drops the row when the edition carries no player_name", async () => {
    tables.topshot_insider_buybacks = {
      data: [{ id: "b1", moment_id: 42, price_usd: 12, sold_at: "2026-07-12T00:00:00Z", editions: null }],
    }
    tables.moments = { data: [{ nft_id: 42, edition_id: "ed-1" }] }
    tables.editions = { data: [{ id: "ed-1", player_name: null, set_name: "Base Set" }] }
    const body = await (await GET()).json()
    expect(body.buybacks).toEqual([])
  })

  it("tolerates editions arriving as a one-element array (PostgREST embed shape)", async () => {
    tables.topshot_insider_buybacks = {
      data: [{ id: "b1", moment_id: 9, price_usd: 100, sold_at: "2026-07-12T00:00:00Z", editions: [{ player_name: "Steph Curry", set_name: "MGLE" }] }],
    }
    const body = await (await GET()).json()
    expect(body.buybacks[0].player_name).toBe("Steph Curry")
  })

  it("caps the resolved buyback list at 5 even though 25 are fetched", async () => {
    tables.topshot_insider_buybacks = {
      data: Array.from({ length: 12 }, (_, i) => ({
        id: `b${i}`, moment_id: i, price_usd: i, sold_at: "2026-07-12T00:00:00Z",
        editions: { player_name: `P${i}`, set_name: "S" },
      })),
    }
    const body = await (await GET()).json()
    expect(body.buybacks).toHaveLength(5)
  })

  it("coerces price_usd to a number and null-fills the optional columns", async () => {
    tables.topshot_insider_buybacks = {
      data: [{ id: "b1", moment_id: 1, price_usd: "42.50", sold_at: "2026-07-12T00:00:00Z", editions: { player_name: "P", set_name: "S" } }],
    }
    const b = (await (await GET()).json()).buybacks[0]
    expect(b.price_usd).toBe(42.5)
    expect(b.acquisition_method).toBeNull()
    expect(b.buyer_address).toBeNull()
    expect(b.serial_number).toBeNull()
  })
})

describe("GET /api/analytics/insider/signals — degradation", () => {
  it("still answers 200 when every source query errors", async () => {
    tables.topshot_insider_alerts = { data: null, error: { message: "alerts down" } }
    tables.topshot_insider_buybacks = { data: null, error: { message: "buybacks down" } }
    tables.external_announcements = { data: null, error: { message: "ann down" } }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.has_data).toBe(false)
    expect(body.alerts).toEqual([])
  })

  it("sets the shared s-maxage cache header", async () => {
    const res = await GET()
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=60")
  })
})
