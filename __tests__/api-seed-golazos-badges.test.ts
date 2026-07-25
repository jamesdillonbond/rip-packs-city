import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/seed-golazos-badges (GET public count + POST
// Bearer-gated). Deep legs: the GET count + 500, POST auth, the editions-page
// error 500, and the badge-building path — a matched edition becomes a
// badge_editions upsert (withBadges + inserted), with the upsert-error branch.
// classifyGolazos is mocked so a sentinel set_name deterministically yields a badge.

const state: { result: any; upsertErr: any } = { result: { count: 0, data: [], error: null }, upsertErr: null }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: () => b,
    range: () => b,
    upsert: async () => ({ error: state.upsertErr }),
    then: (resolve: any) => resolve(state.result),
  }
  return { createClient: () => ({ from: () => b }) }
})
vi.mock("@/lib/golazos-badges", () => ({
  classifyGolazos: (text: string) => (text.includes("PUSKAS") ? ["Puskás"] : []),
  GOLAZOS_BADGE_RULES: [{ badgeTitle: "Puskás", priority: 7 }],
}))

import { GET, POST } from "@/app/api/seed-golazos-badges/route"

const TOKEN = "test-ingest-token"
const post = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.result = { count: 0, data: [], error: null }
  state.upsertErr = null
})

describe("GET /api/seed-golazos-badges", () => {
  it("returns the Golazos badge count", async () => {
    state.result = { count: 13, error: null }
    const body = await (await GET()).json()
    expect(body.count).toBe(13)
    expect(body.collection_id).toBe("06248cc4-b85f-47cd-af67-1855d14acd75")
  })
  it("500s on a count error", async () => {
    state.result = { count: null, error: { message: "db down" } }
    expect((await GET()).status).toBe(500)
  })
})

describe("POST /api/seed-golazos-badges", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(post())).status).toBe(401)
  })
  it("401s with a wrong bearer", async () => {
    expect((await POST(post("Bearer wrong"))).status).toBe(401)
  })
  it("returns an empty summary for a 0-row editions page", async () => {
    state.result = { data: [], error: null }
    const body = await (await POST(post(`Bearer ${TOKEN}`))).json()
    expect(body).toEqual({ scanned: 0, withBadges: 0, inserted: 0 })
  })
  it("500s on an editions-page error", async () => {
    state.result = { data: null, error: { message: "editions down" } }
    expect((await POST(post(`Bearer ${TOKEN}`))).status).toBe(500)
  })
  it("builds + upserts a badge row for a matched edition", async () => {
    state.result = { data: [
      { id: "e1", external_id: "x1", name: "n", set_name: "PUSKAS AWARD", player_name: "Messi", tier: "RARE" },
      { id: "e2", external_id: "x2", name: "n2", set_name: "Plain", player_name: "Q", tier: "COMMON" },
    ], error: null }
    const body = await (await POST(post(`Bearer ${TOKEN}`))).json()
    expect(body.scanned).toBe(2)
    expect(body.withBadges).toBe(1)
    expect(body.inserted).toBe(1)
  })
  it("tolerates an upsert error (inserted stays 0)", async () => {
    state.result = { data: [{ id: "e1", external_id: "x1", name: "n", set_name: "PUSKAS X", player_name: null, tier: null }], error: null }
    state.upsertErr = { message: "upsert down" }
    const body = await (await POST(post(`Bearer ${TOKEN}`))).json()
    expect(body.withBadges).toBe(1)
    expect(body.inserted).toBe(0)
  })
})
