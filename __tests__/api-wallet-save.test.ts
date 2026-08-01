import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/wallet/save. Pins the pre-DB guards
// (malformed JSON → 400, missing ownerKey/walletAddress → 400), the
// save_user_wallet happy path (200) and error → 500, and — as of the owner-key
// IDOR fix — the ownership contract: the write target came from the body
// `ownerKey` on a service-role RPC, so anyone could re-point another user's
// saved wallet / TopShot username / display name and then trigger a seed run
// against it. The background /wallet/seed fetch runs in after() and is out of
// scope. Mocks supabaseAdmin (rpc for the route, from() for the guard's
// profile_bio lookups).

const rpc: { data: any | null; error: any | null; calls: number } = { data: { ok: true }, error: null, calls: 0 }

// ── requireOwnedKey fixtures ────────────────────────────────────────────────
// `ownership.claimantId` is who claims the requested key (null = unclaimed); the
// claimed username echoes back whatever key the route asked about, so any
// ownerKey a test uses resolves to the caller unless the test overrides it.
// `selfUsername` drives the unclaimed-key branch (a brand-new account with no
// username of its own may still make its first write).
const auth: { user: { id: string } | null } = { user: { id: "u1" } }
const ownership: {
  claimantId: string | null
  claimantErr: any | null
  selfUsername: string | null
  selfErr: any | null
} = { claimantId: "u1", claimantErr: null, selfUsername: null, selfErr: null }

// profile_bio is read twice by the guard: `.ilike("username", key)` (who claims
// the key) and `.eq("user_id", …)` (does the caller have a username of their
// own). Distinguish the two by which filter was used.
function profileBioBuilder() {
  let claimQuery = false
  let key = ""
  const b: any = {
    select: () => b,
    ilike: (_col: string, v: string) => {
      claimQuery = true
      key = v
      return b
    },
    eq: () => b,
    maybeSingle: async (): Promise<{ data: any | null; error: any | null }> =>
      claimQuery
        ? {
            data: ownership.claimantId
              ? { user_id: ownership.claimantId, username: key }
              : null,
            error: ownership.claimantErr,
          }
        : {
            data: ownership.selfUsername ? { username: ownership.selfUsername } : null,
            error: ownership.selfErr,
          },
  }
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (_t: string) => profileBioBuilder(), // the guard's only table read
    rpc: async () => {
      rpc.calls++
      return { data: rpc.data, error: rpc.error }
    },
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
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

beforeEach(() => {
  rpc.data = { ok: true }
  rpc.error = null
  rpc.calls = 0
  auth.user = { id: "u1" }
  ownership.claimantId = "u1"
  ownership.claimantErr = null
  ownership.selfUsername = null
  ownership.selfErr = null
})

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

  // ── the ownership contract (the IDOR that was closed) ─────────────────────
  it("401s when unauthenticated, without calling save_user_wallet", async () => {
    auth.user = null
    const res = await POST(req({ ownerKey: "victim", walletAddress: "0xATTACKER" }))
    expect(res.status).toBe(401)
    expect(rpc.calls).toBe(0)
  })

  it("403s when ownerKey is claimed by a DIFFERENT user, without calling save_user_wallet", async () => {
    auth.user = { id: "attacker" }
    ownership.claimantId = "victim"
    const res = await POST(req({ ownerKey: "victim", walletAddress: "0xATTACKER" }))
    expect(res.status).toBe(403)
    expect(rpc.calls).toBe(0)
  })

  it("lets a brand-new account (no username yet) make its first save on an UNCLAIMED key", async () => {
    ownership.claimantId = null
    ownership.selfUsername = null
    const res = await POST(req({ ownerKey: "fresh-key", walletAddress: "0xABC" }))
    expect(res.status).toBe(200)
    expect(rpc.calls).toBe(1)
  })

  it("403s an UNCLAIMED key when the caller already owns a username", async () => {
    ownership.claimantId = null
    ownership.selfUsername = "trevor"
    const res = await POST(req({ ownerKey: "someone-elses", walletAddress: "0xABC" }))
    expect(res.status).toBe(403)
    expect(rpc.calls).toBe(0)
  })

  it("fails CLOSED with 403 when the ownership lookup itself errors", async () => {
    ownership.claimantErr = { message: "profile_bio unavailable" }
    const res = await POST(req({ ownerKey: "u1", walletAddress: "0xABC" }))
    expect(res.status).toBe(403)
    expect(rpc.calls).toBe(0)
  })
})
