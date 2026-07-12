import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/pack-roi. Mocks @/lib/supabase's supabaseAdmin
// (imported by the route). Pins the required-wallet guard, the empty-wallet
// message, and the 2-hour acquisition-clustering that infers pack rips.

const state: { moments: any } = { moments: { data: [] } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    not: () => b,
    order: () => b,
    then: (resolve: any) => resolve(state.moments),
  }
  return { supabaseAdmin: { from: () => b }, supabase: { from: () => b } }
})

import { GET } from "@/app/api/pack-roi/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.moments = { data: [] }
})

describe("GET /api/pack-roi", () => {
  it("400s without a wallet param", async () => {
    expect((await GET(req("https://t/api/pack-roi"))).status).toBe(400)
  })

  it("returns the empty message when the wallet has no moments", async () => {
    state.moments = { data: [] }
    const body = await (await GET(req("https://t/api/pack-roi?wallet=0xabc"))).json()
    expect(body.packs).toEqual([])
    expect(body.message).toContain("No moments found")
  })

  it("reports no pack rips when moments are spread out (>2h apart)", async () => {
    state.moments = {
      data: [
        { edition_id: "e1", acquired_at: "2026-07-01T00:00:00Z", fmv: 10 },
        { edition_id: "e2", acquired_at: "2026-07-01T05:00:00Z", fmv: 20 }, // 5h later
      ],
    }
    const body = await (await GET(req("https://t/api/pack-roi?wallet=0xabc"))).json()
    expect(body.packs).toEqual([])
    expect(body.message).toContain("No pack rip events")
  })

  it("clusters moments acquired together (<2h) into one pack rip with summed FMV", async () => {
    state.moments = {
      data: [
        { edition_id: "e1", acquired_at: "2026-07-01T00:00:00Z", fmv: 10 },
        { edition_id: "e2", acquired_at: "2026-07-01T00:30:00Z", fmv: 20 },
        { edition_id: "e3", acquired_at: "2026-07-01T01:00:00Z", fmv: 5 },
      ],
    }
    const body = await (await GET(req("https://t/api/pack-roi?wallet=0xabc"))).json()
    expect(body.packs).toHaveLength(1)
    expect(body.packs[0].momentsReceived).toBe(3)
    expect(body.packs[0].currentFmv).toBe(35)
  })
})
