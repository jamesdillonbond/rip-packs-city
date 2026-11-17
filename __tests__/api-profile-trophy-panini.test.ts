import { describe, it, expect, beforeEach, vi } from "vitest"

// POST /api/profile/trophy for a Panini card (2026-09-28). Most Panini cards
// have no live `editions` row for the public slab to coalesce to, so what this
// route STORES is what the public profile SHOWS. Pins: a verified card is
// stored with the SERVER-resolved fields (the body's forged serial/art/FMV are
// discarded); a card not under a linked username is a 403 with nothing
// written; a failed verification is a 503 with nothing written.

const state: { user: any; resolution: any; lastUpsert: any } = { user: null, resolution: null, lastUpsert: null }

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, eq: () => b, not: () => b, limit: () => b, order: () => b,
      upsert: (payload: any) => ((state.lastUpsert = payload), b),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: { id: 1 }, error: null }),
      insert: async () => ({ error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => ({ data: null, error: null }) }
  return { supabase: client, supabaseAdmin: client }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => state.user,
  getCurrentUser: async () => state.user,
}))
vi.mock("@/lib/trophy/panini-card", () => ({
  resolvePaniniTrophyCard: async () => state.resolution,
}))
vi.mock("@/lib/trophy/funnel-event", () => ({ logTrophyFunnelEvent: async () => {} }))

import { POST } from "@/app/api/profile/trophy/route"

const PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"
const SKU = "packcard-2063_398995_10651284_4__1_25"
const forged = {
  slot: 2, momentId: SKU, collectionId: PANINI, editionId: "forged",
  playerName: "Forged Name", setName: "Forged Set", serialNumber: 1, circulationCount: 1,
  tier: "ULTIMATE", thumbnailUrl: "https://evil.example/x.png", fmv: 99999, badges: ["forged"],
}
const req = (body: any) => ({ json: async () => body, headers: new Headers() }) as any

beforeEach(() => {
  state.user = { id: "u1" }
  state.resolution = null
  state.lastUpsert = null
})

describe("POST /api/profile/trophy — Panini", () => {
  it("stores the server-resolved card, discarding every forged body field", async () => {
    state.resolution = {
      ok: true,
      card: {
        momentId: SKU, editionId: "packcard-2063_398995_10651284_4", playerName: "Toumani Camara",
        setName: "Rookie Roundup", serialNumber: 7, circulationCount: 25, tier: null,
        thumbnailUrl: "https://assets.paniniamerica.net/catalog/product/pack/942/thumb.png",
      },
    }
    const res = await POST(req(forged))
    expect(res.status).toBe(200)
    expect(state.lastUpsert).toMatchObject({
      collection_id: PANINI,
      moment_id: SKU,
      edition_id: "packcard-2063_398995_10651284_4",
      player_name: "Toumani Camara",
      set_name: "Rookie Roundup",
      serial_number: 7,
      circulation_count: 25,
      tier: null,
      thumbnail_url: "https://assets.paniniamerica.net/catalog/product/pack/942/thumb.png",
      fmv: null,
      badges: null,
      video_url: null,
    })
  })

  it("403s with nothing written when the card is not under a linked username", async () => {
    state.resolution = { ok: true, card: null }
    const res = await POST(req(forged))
    expect(res.status).toBe(403)
    expect(state.lastUpsert).toBeNull()
  })

  it("503s with nothing written when verification could not read — never a 403 'not yours'", async () => {
    state.resolution = { ok: false, error: { message: "canceling statement due to statement timeout" } }
    const res = await POST(req(forged))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.status).not.toBe(403)
    expect(state.lastUpsert).toBeNull()
  })
})
