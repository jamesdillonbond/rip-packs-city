import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/mcp/keys/[keyId] (DELETE). User-cookie-auth
// via getCurrentUser; the handler takes a second arg { params: Promise<{keyId}> }.
// FAIL-CLOSED AUTH is the priority, followed by the UUID-format 400 guard.
// Mocks @/lib/supabase supabaseAdmin and @/lib/auth/supabase-server.

const auth: { user: any } = { user: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: [], error: null }),
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { DELETE } from "@/app/api/mcp/keys/[keyId]/route"

const req = () => ({}) as any
const ctx = (keyId: string) => ({ params: Promise.resolve({ keyId }) })

beforeEach(() => {
  auth.user = null
})

describe("DELETE /api/mcp/keys/[keyId]", () => {
  it("401s when unauthenticated (before touching params)", async () => {
    auth.user = null
    const res = await DELETE(req(), ctx("00000000-0000-0000-0000-000000000000"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s when keyId is not a UUID", async () => {
    auth.user = { id: "u1" }
    const res = await DELETE(req(), ctx("not-a-uuid"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("keyId must be a UUID")
  })

  it("404s when the key row does not exist", async () => {
    auth.user = { id: "u1" }
    const res = await DELETE(req(), ctx("11111111-1111-1111-1111-111111111111"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Key not found")
  })
})
