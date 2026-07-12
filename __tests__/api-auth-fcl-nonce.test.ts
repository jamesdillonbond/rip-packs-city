import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/auth/fcl-nonce.
// Mints a single-use nonce by inserting into fcl_auth_nonces. Mock @/lib/supabase
// so the insert resolves { error: null } (happy → returns a hex nonce) or an
// error (→ 500). The route races the insert against an 8s timeout.

const state: { error: any; data: any } = { error: null, data: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    insert: async () => ({ error: state.error, data: state.data }),
  }
  return { supabaseAdmin: b }
})

import { GET } from "@/app/api/auth/fcl-nonce/route"

beforeEach(() => {
  state.error = null
  state.data = null
})

describe("GET /api/auth/fcl-nonce", () => {
  it("returns a hex nonce + appIdentifier on success", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.appIdentifier).toBe("Rip Packs City")
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
  })

  it("500s on a plain insert error", async () => {
    state.error = { message: "insert failed" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("insert failed")
  })
})
