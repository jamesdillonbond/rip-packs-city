import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/wallet/save. Pins the pre-DB guards
// (malformed JSON → 400, missing ownerKey/walletAddress → 400) plus the
// save_user_wallet happy path (200) and error → 500. The background /wallet/seed
// fetch runs in after() and is out of scope. Mocks supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: { ok: true }, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
// The happy path schedules a background /wallet/seed fetch via next/server's
// after(); stub after() so it's a no-op outside a request scope.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (_fn: any) => {} }
})

import { POST } from "@/app/api/wallet/save/route"

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body }, url: "https://t/api/wallet/save" }) as any

beforeEach(() => { rpc.data = { ok: true }; rpc.error = null })

describe("POST /api/wallet/save", () => {
  it("400s on malformed JSON", async () => {
    expect((await POST(req(null, true))).status).toBe(400)
  })
  it("400s when ownerKey/walletAddress are missing", async () => {
    expect((await POST(req({ ownerKey: "u1" }))).status).toBe(400)
    expect((await POST(req({ walletAddress: "0xabc" }))).status).toBe(400)
  })
  it("200s on a successful save", async () => {
    const res = await POST(req({ ownerKey: "u1", walletAddress: "0xABC" }))
    expect(res.status).toBe(200)
  })
  it("500s on an RPC error", async () => {
    rpc.error = { message: "db" }
    expect((await POST(req({ ownerKey: "u1", walletAddress: "0xABC" }))).status).toBe(500)
  })
})
