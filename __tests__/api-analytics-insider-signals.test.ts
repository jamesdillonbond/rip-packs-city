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
