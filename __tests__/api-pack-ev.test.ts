import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/pack-ev.
// The happy path fans out to the Top Shot GraphQL API + secondary-ask lookups
// (no simple mock seam), so this pins the pre-fetch guards: missing
// packListingId → 400, and a collection that is neither nba-top-shot nor
// nfl-all-day → 404. @supabase/supabase-js is mocked only so the module-level
// createClient() import doesn't touch a real client.
// NOTE: deeper coverage is import-only — EV compute is upstream-GQL-driven.

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({}), rpc: async () => ({ data: null, error: null }) }),
}))

import { POST } from "@/app/api/pack-ev/route"

function post(body: unknown) {
  return {
    url: "https://t/api/pack-ev",
    json: async () => body,
  } as any
}

describe("POST /api/pack-ev", () => {
  it("400s when packListingId is missing", async () => {
    const res = await POST(post({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("packListingId is required")
  })

  it("404s for a collection that does not support pack EV", async () => {
    const res = await POST(post({ packListingId: "abc", collectionId: "laliga-golazos" }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("Packs not available for this collection")
    expect(body.collectionId).toBe("laliga-golazos")
  })

  it("is a function (export shape)", () => {
    expect(typeof POST).toBe("function")
  })
})
