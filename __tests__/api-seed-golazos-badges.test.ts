import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/seed-golazos-badges (GET public count + POST
// Bearer-gated). Mirrors seed-allday-badges: createClient (@supabase/supabase-js)
// is mocked; POST auth compares the header against `Bearer ${INGEST_SECRET_TOKEN}`
// at CALL time (string compare) → no/wrong header 401. Happy POST: an empty
// editions page short-circuits pagination → {scanned:0,...}.

const state: { result: any } = { result: { count: 0, data: [], error: null } }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    range: () => b,
    upsert: async () => ({ error: null }),
    then: (resolve: any) => resolve(state.result),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET, POST } from "@/app/api/seed-golazos-badges/route"

const TOKEN = "test-ingest-token"

function post(auth?: string) {
  return { headers: new Headers(auth ? { authorization: auth } : {}) } as any
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.result = { count: 0, data: [], error: null }
})

describe("GET /api/seed-golazos-badges", () => {
  it("returns the Golazos badge count (public)", async () => {
    state.result = { count: 7, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(7)
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

  it("401s with a wrong bearer token", async () => {
    expect((await POST(post("Bearer wrong"))).status).toBe(401)
  })

  it("returns the seed summary for an empty editions page", async () => {
    state.result = { data: [], error: null }
    const res = await POST(post(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ scanned: 0, withBadges: 0, inserted: 0 })
  })
})
