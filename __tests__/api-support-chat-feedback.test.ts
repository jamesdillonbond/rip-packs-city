import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/support-chat/feedback. Pins the two
// pre-DB 400 guards (invalid feedback value, and neither messageId nor
// sessionId) plus the update-by-id happy path. Mocks @supabase/supabase-js and
// the server auth helper (identity derivation swallows to nulls).

const state: { updateError: any } = { updateError: null }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b, eq: () => b, ilike: () => b, order: () => b, limit: () => b,
    maybeSingle: async () => ({ data: null }),
    update: () => ({ eq: async () => ({ error: state.updateError }) }),
  }
  return { createClient: () => ({ from: () => b }) }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}))

import { POST } from "@/app/api/support-chat/feedback/route"

const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => { state.updateError = null })

describe("POST /api/support-chat/feedback", () => {
  it("400s when feedback is not 'up' or 'down'", async () => {
    const res = await POST(req({ feedback: "meh", sessionId: "s1" }))
    expect(res.status).toBe(400)
  })

  it("400s when neither messageId nor sessionId is present", async () => {
    const res = await POST(req({ feedback: "up" }))
    expect(res.status).toBe(400)
  })

  it("updates by primary-key id on the preferred path", async () => {
    const res = await POST(req({ feedback: "up", messageId: 42 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.target).toBe("id")
  })
})
