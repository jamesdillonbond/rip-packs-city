import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/trade-hub/wishlist. Every verb is cookie-auth
// gated → fail-closed 401 when unauthenticated (getCurrentUser → null). Mocks
// supabaseAdmin + the auth helper.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))

import { GET, POST, DELETE } from "@/app/api/trade-hub/wishlist/route"

const postReq = (body: any) => ({ json: async () => body }) as any
const delReq = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("/api/trade-hub/wishlist — fail-closed auth", () => {
  it("GET 401s when unauthenticated", async () => {
    expect((await GET()).status).toBe(401)
  })
  it("POST 401s when unauthenticated", async () => {
    expect((await POST(postReq({}))).status).toBe(401)
  })
  it("DELETE 401s when unauthenticated", async () => {
    expect((await DELETE(delReq("https://t/api/trade-hub/wishlist?id=1"))).status).toBe(401)
  })
})
