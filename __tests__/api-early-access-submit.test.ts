import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/early-access/submit (public form — no
// bearer auth). Pins the pre-DB validation guards (invalid JSON, missing email,
// bad wallet format, neither wallet nor username) and one mocked path: a
// username-only DUPLICATE submission, which deliberately skips the dedup lookup
// (needs both wallet+username), the auto-approval block and the after() work
// (both gated on !isDuplicate) — so only rpc("submit_allow_list_request") runs.
// Mocks @/lib/supabase supabaseAdmin (rpc + a minimal from() builder).

const state: { submit: { data: any; error: any } } = {
  submit: { data: { ok: true, duplicate: true, status: "pending" }, error: null },
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    ilike: () => b,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null }),
    update: () => b,
    then: (r: any) => r({ error: null }),
  }
  return {
    supabaseAdmin: {
      from: () => b,
      rpc: async () => state.submit,
    },
  }
})

import { POST } from "@/app/api/early-access/submit/route"

function req(body: any, opts: { badJson?: boolean } = {}): any {
  const headers = new Headers()
  return {
    method: "POST",
    headers,
    json: async () => {
      if (opts.badJson) throw new Error("bad json")
      return body
    },
  }
}

beforeEach(() => {
  state.submit = { data: { ok: true, duplicate: true, status: "pending" }, error: null }
})

describe("POST /api/early-access/submit", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(req(null, { badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when email is missing", async () => {
    const res = await POST(req({ username: "collector" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Email is required.")
  })

  it("400s on a malformed wallet", async () => {
    const res = await POST(req({ email: "a@b.com", wallet: "0xzzzz" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("0x followed by exactly 16 hex")
  })

  it("400s when neither wallet nor username is supplied", async () => {
    const res = await POST(req({ email: "a@b.com" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("either a Flow wallet address or a username")
  })

  it("returns ok+duplicate for a username-only duplicate submission", async () => {
    state.submit = { data: { ok: true, duplicate: true, status: "pending" }, error: null }
    const res = await POST(req({ email: "a@b.com", username: "collector" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.duplicate).toBe(true)
  })

  it("500s when the submit RPC errors", async () => {
    state.submit = { data: null, error: { message: "db" } }
    const res = await POST(req({ email: "a@b.com", username: "collector" }))
    expect(res.status).toBe(500)
  })
})
