import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// Three mutating dynamic routes that had NO test importing their module, each
// carrying a real AUTH / OWNERSHIP / VALIDATION ladder:
//
//   · PATCH /api/admin/allow-list/[id]  — the allow-list decision endpoint
//       (approve/hold/deny/reset). A wrong answer here grants or revokes site
//       access. Pins: admin-bearer gate, uuid guard, action allowlist, the
//       RPC ok:false → not_found(404)/rejected(400) split, re-read row.
//   · PATCH /api/admin/feedback/[id]    — feedback triage. Pins the duplicate
//       resolution block (canonical id required, not-self, must exist) and the
//       "no updatable fields" guard.
//   · DELETE /api/mcp/keys/[keyId]      — API-key revoke. Pins the OWNERSHIP
//       check: a key whose wallet is not in the caller's saved_wallets must 403,
//       never revoke. That 403 is the whole security boundary of the route.
//
// The Supabase client is a small queue-driven chainable mock: every builder
// method returns `this`; the terminals (.maybeSingle / awaited .limit / .rpc)
// shift the next queued { data, error } off the matching FIFO.
// ─────────────────────────────────────────────────────────────────────────────

const sb = vi.hoisted(() => ({
  fromQueue: [] as Array<{ data: unknown; error: unknown }>,
  rpcQueue: [] as Array<{ data: unknown; error: unknown }>,
}))
const admin = vi.hoisted(() => ({ ok: true }))
const authState = vi.hoisted(() => ({ user: null as { id: string } | null }))

function nextFrom() {
  return sb.fromQueue.shift() ?? { data: null, error: null }
}
function nextRpc() {
  return sb.rpcQueue.shift() ?? { data: null, error: null }
}

vi.mock("@/lib/supabase", () => {
  const builder: any = {
    select: () => builder,
    update: () => builder,
    insert: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => nextFrom(),
    single: async () => nextFrom(),
    // awaited directly (e.g. .select().eq().limit(1))
    then: (res: any, rej: any) => Promise.resolve(nextFrom()).then(res, rej),
  }
  const client: any = {
    from: () => builder,
    rpc: async () => nextRpc(),
  }
  return { supabaseAdmin: client, supabase: client }
})

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => admin.ok,
  adminUnauthorizedResponse: () =>
    NextResponse.json({ error: "unauthorized" }, { status: 401 }),
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => authState.user,
}))

import { NextResponse } from "next/server"
import { PATCH as allowListPATCH } from "@/app/api/admin/allow-list/[id]/route"
import { PATCH as feedbackPATCH } from "@/app/api/admin/feedback/[id]/route"
import { DELETE as mcpDELETE } from "@/app/api/mcp/keys/[keyId]/route"

const p = <T,>(v: T) => Promise.resolve(v)
const UUID = "11111111-2222-3333-4444-555555555555"

function patchReq(body: unknown): NextRequest {
  return new NextRequest("https://t/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  sb.fromQueue = []
  sb.rpcQueue = []
  admin.ok = true
  authState.user = { id: "user-1" }
})

describe("PATCH /api/admin/allow-list/[id]", () => {
  it("401s without admin auth", async () => {
    admin.ok = false
    const res = await allowListPATCH(patchReq({ action: "approve" }), { params: p({ id: UUID }) })
    expect(res.status).toBe(401)
  })
  it("400s on a non-uuid id", async () => {
    const res = await allowListPATCH(patchReq({ action: "approve" }), { params: p({ id: "nope" }) })
    expect(res.status).toBe(400)
  })
  it("400s on an unknown action", async () => {
    const res = await allowListPATCH(patchReq({ action: "nuke" }), { params: p({ id: UUID }) })
    expect(res.status).toBe(400)
  })
  it("500s when the decision RPC errors", async () => {
    sb.rpcQueue = [{ data: null, error: { message: "rpc down" } }]
    const res = await allowListPATCH(patchReq({ action: "deny", reason: "spam" }), { params: p({ id: UUID }) })
    expect(res.status).toBe(500)
  })
  it("404s when the RPC reports ok:false / not_found", async () => {
    sb.rpcQueue = [{ data: { ok: false, error: "not_found" }, error: null }]
    const res = await allowListPATCH(patchReq({ action: "approve" }), { params: p({ id: UUID }) })
    expect(res.status).toBe(404)
  })
  it("400s when the RPC reports ok:false with a non-not_found reason", async () => {
    sb.rpcQueue = [{ data: { ok: false, error: "already_active" }, error: null }]
    const res = await allowListPATCH(patchReq({ action: "approve" }), { params: p({ id: UUID }) })
    expect(res.status).toBe(400)
  })
  it("returns the re-read row on success", async () => {
    sb.rpcQueue = [{ data: { ok: true }, error: null }]
    sb.fromQueue = [{ data: { id: UUID, status: "active" }, error: null }]
    const res = await allowListPATCH(patchReq({ action: "approve" }), { params: p({ id: UUID }) })
    expect(res.status).toBe(200)
    expect((await res.json()).row.status).toBe("active")
  })
  it("404s when the row vanishes after a successful decision", async () => {
    sb.rpcQueue = [{ data: { ok: true }, error: null }]
    sb.fromQueue = [{ data: null, error: null }]
    const res = await allowListPATCH(patchReq({ action: "reset" }), { params: p({ id: UUID }) })
    expect(res.status).toBe(404)
  })
})

describe("PATCH /api/admin/feedback/[id]", () => {
  it("401s without admin auth", async () => {
    admin.ok = false
    const res = await feedbackPATCH(patchReq({ feedback_status: "reviewed" }), { params: p({ id: "5" }) })
    expect(res.status).toBe(401)
  })
  it("400s on a non-positive-integer id", async () => {
    const res = await feedbackPATCH(patchReq({ feedback_status: "reviewed" }), { params: p({ id: "0" }) })
    expect(res.status).toBe(400)
  })
  it("400s on an invalid feedback_status", async () => {
    const res = await feedbackPATCH(patchReq({ feedback_status: "bogus" }), { params: p({ id: "5" }) })
    expect(res.status).toBe(400)
  })
  it("400s when no updatable fields are supplied", async () => {
    const res = await feedbackPATCH(patchReq({}), { params: p({ id: "5" }) })
    expect(res.status).toBe(400)
  })
  it("rejects duplicate→self reference", async () => {
    const res = await feedbackPATCH(
      patchReq({ feedback_status: "duplicate", duplicate_of: 5 }),
      { params: p({ id: "5" }) }
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("same row")
  })
  it("400s when the duplicate target does not exist", async () => {
    // target lookup returns no row
    sb.fromQueue = [{ data: null, error: null }]
    const res = await feedbackPATCH(
      patchReq({ feedback_status: "duplicate", duplicate_of: 99 }),
      { params: p({ id: "5" }) }
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("does not reference an existing row")
  })
  it("updates and returns the row on a valid duplicate resolution", async () => {
    sb.fromQueue = [
      { data: { id: 99 }, error: null }, // target exists
      { data: { id: 5, feedback_status: "duplicate", duplicate_of: 99 }, error: null }, // update returning
    ]
    const res = await feedbackPATCH(
      patchReq({ feedback_status: "duplicate", duplicate_of: 99 }),
      { params: p({ id: "5" }) }
    )
    expect(res.status).toBe(200)
    expect((await res.json()).row.duplicate_of).toBe(99)
  })
  it("404s when the update matches no row", async () => {
    sb.fromQueue = [{ data: null, error: null }] // update returning null
    const res = await feedbackPATCH(patchReq({ admin_note: "looked at it" }), { params: p({ id: "5" }) })
    expect(res.status).toBe(404)
  })
})

describe("DELETE /api/mcp/keys/[keyId]", () => {
  it("401s with no session", async () => {
    authState.user = null
    const res = await mcpDELETE(new NextRequest("https://t/x", { method: "DELETE" }), {
      params: p({ keyId: UUID }),
    })
    expect(res.status).toBe(401)
  })
  it("400s on a non-uuid keyId", async () => {
    const res = await mcpDELETE(new NextRequest("https://t/x", { method: "DELETE" }), {
      params: p({ keyId: "nope" }),
    })
    expect(res.status).toBe(400)
  })
  it("404s when the key does not exist", async () => {
    sb.fromQueue = [{ data: [], error: null }] // key lookup empty
    const res = await mcpDELETE(new NextRequest("https://t/x", { method: "DELETE" }), {
      params: p({ keyId: UUID }),
    })
    expect(res.status).toBe(404)
  })
  it("403s when the key's wallet is not in the caller's saved wallets (ownership boundary)", async () => {
    sb.fromQueue = [{ data: [{ wallet_address: "0xdeadbeefdeadbeef", status: "active" }], error: null }]
    sb.rpcQueue = [{ data: [{ wallet_addr: "0xaaaaaaaaaaaaaaaa" }], error: null }] // saved wallets — different
    const res = await mcpDELETE(new NextRequest("https://t/x", { method: "DELETE" }), {
      params: p({ keyId: UUID }),
    })
    expect(res.status).toBe(403)
  })
  it("500s when the saved-wallet lookup RPC errors", async () => {
    sb.fromQueue = [{ data: [{ wallet_address: "0xdeadbeefdeadbeef", status: "active" }], error: null }]
    sb.rpcQueue = [{ data: null, error: { message: "rpc down" } }]
    const res = await mcpDELETE(new NextRequest("https://t/x", { method: "DELETE" }), {
      params: p({ keyId: UUID }),
    })
    expect(res.status).toBe(500)
  })
  it("revokes the key when the caller owns its wallet", async () => {
    sb.fromQueue = [{ data: [{ wallet_address: "0xdeadbeefdeadbeef", status: "active" }], error: null }]
    sb.rpcQueue = [
      { data: [{ wallet_addr: "0xdeadbeefdeadbeef" }], error: null }, // saved wallets — match
      { data: true, error: null }, // mcp_revoke_api_key
    ]
    const res = await mcpDELETE(new NextRequest("https://t/x", { method: "DELETE" }), {
      params: p({ keyId: UUID }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.revoked).toBe(true)
  })
})
