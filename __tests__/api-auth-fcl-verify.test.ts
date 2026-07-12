import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/auth/fcl-verify.
// Body-shape guards run before any nonce lookup / signature verification:
// invalid JSON → 400, missing addr → 400, missing accountProof → 400, missing
// nonce → 400. Mock the deps so the module imports cleanly; we pin those guards
// (the happy path verifies an on-chain account proof + mints a session).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
vi.mock("@onflow/fcl", () => ({ AppUtils: { verifyAccountProof: async () => false } }))

import { POST } from "@/app/api/auth/fcl-verify/route"

function req(raw?: string): NextRequest {
  return new NextRequest("https://t/api/auth/fcl-verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  })
}

describe("POST /api/auth/fcl-verify", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(req("not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when addr is missing", async () => {
    const res = await POST(req(JSON.stringify({ accountProof: { nonce: "n" } })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("addr")
  })

  it("400s when accountProof is missing", async () => {
    const res = await POST(req(JSON.stringify({ addr: "0xabc" })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("accountProof")
  })

  it("400s when accountProof.nonce is missing", async () => {
    const res = await POST(req(JSON.stringify({ addr: "0xabc", accountProof: {} })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("nonce")
  })
})
