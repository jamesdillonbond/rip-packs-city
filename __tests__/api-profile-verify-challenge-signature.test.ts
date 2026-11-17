import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/verify-challenge/signature (GET + POST).
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// The route shipped 2026-09-14 with no test referencing it, which reddened
// `api-route-tsx-test-completeness` on `main` — the rot-guard whose whole job is
// to stop exactly that. It is allowlistable, and allowlisting would have been
// the wrong call: this is a WALLET-VERIFICATION route that stamps `verified_at`
// and pays awards, so "no test" and "not worth testing" are not the same claim.
//
// ⭐ THE ASSERTION THIS FILE IS REALLY FOR is the three-state one the route's own
// comment names: when Flow cannot be reached, the answer must be **"we could not
// ask"** (503, `unavailable: true`), NEVER "your signature failed" (400). This
// repo's most productive defect class is a failed read rendered as an answer, and
// the account-level false claim — telling a user their own wallet did not verify
// because an access node was down — is the worst sub-class of it. A test that
// only checked "returns 400 on a bad signature" would pass while that inverted.
//
// The mocks are STATE-DRIVEN so the deep branches are reachable rather than
// merely present: the saved-wallet gate, already-verified short-circuits on both
// verbs, the chain-unavailable 503, a genuine rejection 400, the success path
// (asserted on the captured RPC args), the post-verify race (`ok:false` -> 409),
// and the per-user rate limit.

class FlowVerifyUnavailable extends Error {}

const state: {
  user: any
  saved: { data: any; error: any }
  verify: { outcome: any; throws: Error | null }
  rpc: { data: any; error: any }
  lastRpc: { name: string; args: any } | null
} = {
  user: null,
  saved: { data: null, error: null },
  verify: { outcome: { ok: true }, throws: null },
  rpc: { data: { ok: true, first_verification: true, link_wallet_award: 50, referral_award: null }, error: null },
  lastRpc: null,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      ilike: () => b,
      maybeSingle: async () => state.saved,
    }
    return b
  }
  const client: any = {
    from: () => build(),
    rpc: async (name: string, args: any) => {
      state.lastRpc = { name, args }
      return state.rpc
    },
  }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/auth/flow-signature", () => ({
  CHALLENGE_TTL_MS: 600_000,
  FlowVerifyUnavailable,
  normalizeFlowAddress: (v: unknown) =>
    typeof v === "string" && /^0x[0-9a-fA-F]{16}$/.test(v.trim()) ? v.trim().toLowerCase() : null,
  makeChallenge: (addr: unknown) =>
    typeof addr === "string"
      ? { address: addr, issuedAt: "2026-09-14T00:00:00.000Z", nonce: "n0nce", message: "msg", messageHex: "6d7367" }
      : null,
  verifyWalletSignature: async () => {
    if (state.verify.throws) throw state.verify.throws
    return state.verify.outcome
  },
}))

const WALLET = "0x1234567890abcdef"
const route = () => import("@/app/api/profile/verify-challenge/signature/route")

const get = async (qs: string) => {
  const { GET } = await route()
  return GET({ nextUrl: { searchParams: new URLSearchParams(qs) } } as any)
}
const post = async (body: unknown) => {
  const { POST } = await route()
  return POST({ json: async () => body } as any)
}

beforeEach(() => {
  state.user = { id: "user-1" }
  state.saved = { data: { id: 7, wallet_addr: WALLET, verified_at: null }, error: null }
  state.verify = { outcome: { ok: true }, throws: null }
  state.rpc = {
    data: { ok: true, first_verification: true, link_wallet_award: 50, referral_award: null },
    error: null,
  }
  state.lastRpc = null
  vi.resetModules() // the rate limiter is module-level state
})

describe("/api/profile/verify-challenge/signature — auth and the saved-wallet gate", () => {
  it("fails CLOSED for an anonymous caller on both verbs", async () => {
    state.user = null
    expect((await get(`wallet_addr=${WALLET}`)).status).toBe(401)
    expect((await post({ wallet_addr: WALLET })).status).toBe(401)
  })

  it("rejects an address that is not 0x + 16 hex", async () => {
    expect((await get("wallet_addr=nonsense")).status).toBe(400)
    expect((await post({ wallet_addr: "0xdeadbeef" })).status).toBe(400)
  })

  it("requires the wallet to be SAVED to this account first", async () => {
    // The signature proves control of an address; it does not prove the user
    // asked us to associate it. The two claims stay separate.
    state.saved = { data: null, error: null }
    expect((await get(`wallet_addr=${WALLET}`)).status).toBe(404)
    expect((await post({ wallet_addr: WALLET })).status).toBe(404)
  })

  it("rejects an unparseable POST body", async () => {
    const { POST } = await route()
    const res = await POST({
      json: async () => {
        throw new Error("bad json")
      },
    } as any)
    expect(res.status).toBe(400)
  })
})

describe("/api/profile/verify-challenge/signature — GET issues a challenge", () => {
  it("returns the four signable fields plus the TTL, so the caller need not hardcode ours", async () => {
    const res = await get(`wallet_addr=${WALLET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ address: WALLET, nonce: "n0nce", message: "msg", messageHex: "6d7367" })
    expect(body.issuedAt).toBeTruthy()
    expect(body.expiresInMs).toBe(600_000)
  })

  it("short-circuits an already-verified wallet instead of re-issuing", async () => {
    state.saved = { data: { id: 7, wallet_addr: WALLET, verified_at: "2026-09-01T00:00:00Z" }, error: null }
    const body = await (await get(`wallet_addr=${WALLET}`)).json()
    expect(body.already_verified).toBe(true)
    expect(body.nonce).toBeUndefined()
  })
})

describe("/api/profile/verify-challenge/signature — POST, and the three states", () => {
  it("🚨 renders an UNREACHABLE CHAIN as 'we could not ask', never as a failed signature", async () => {
    // The defect this guards: a 503 from an access node published as "your
    // wallet did not verify" — a false claim about the user's own account.
    state.verify.throws = new FlowVerifyUnavailable("access node down")
    const res = await post({ wallet_addr: WALLET, issuedAt: "t", nonce: "n", signatures: [] })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.unavailable).toBe(true)
    expect(body.ok).toBe(false)
    // ⭐ Assert the ABSENCE of the false claim, not merely the presence of a
    // message: nothing here may suggest the signature itself was judged.
    expect(body.code).toBeUndefined()
    expect(String(body.error)).toMatch(/could not reach|try again/i)
    expect(String(body.error)).not.toMatch(/invalid|did not match|failed to verify/i)
    // ...and nothing was recorded.
    expect(state.lastRpc).toBeNull()
  })

  it("a genuinely rejected signature is a 400 that does NOT record anything", async () => {
    // The control for the test above: the 503 arm is only meaningful if a real
    // rejection is distinguishable from it.
    state.verify.outcome = { ok: false, code: "sig_mismatch", error: "Signature did not match." }
    const res = await post({ wallet_addr: WALLET, issuedAt: "t", nonce: "n", signatures: [] })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe("sig_mismatch")
    expect(body.unavailable).toBeUndefined()
    expect(state.lastRpc).toBeNull()
  })

  it("records a verified signature through resolve_wallet_signature_match and reports the awards", async () => {
    const res = await post({ wallet_addr: WALLET, issuedAt: "t", nonce: "n", signatures: [], referrer: "ref-code" })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      wallet_addr: WALLET,
      verified_via: "wallet_signature",
      first_verification: true,
      link_wallet_award: 50,
    })
    // Asserted on the captured args: the awards path must go through the RPC
    // that mirrors the listing challenge, or the two verification paths diverge.
    expect(state.lastRpc?.name).toBe("resolve_wallet_signature_match")
    expect(state.lastRpc?.args).toMatchObject({ p_user_id: "user-1", p_wallet: WALLET, p_referrer: "ref-code" })
  })

  it("passes a NULL referrer when the field is not a string, rather than coercing it", async () => {
    await post({ wallet_addr: WALLET, issuedAt: "t", nonce: "n", signatures: [], referrer: { nope: true } })
    expect(state.lastRpc?.args.p_referrer).toBeNull()
  })

  it("surfaces a lost race as 409 rather than claiming success", async () => {
    state.rpc = { data: { ok: false, error: "already verified by another request" }, error: null }
    const res = await post({ wallet_addr: WALLET, issuedAt: "t", nonce: "n", signatures: [] })
    expect(res.status).toBe(409)
    expect((await res.json()).ok).toBe(false)
  })

  it("short-circuits an already-verified wallet without touching the chain", async () => {
    state.saved = { data: { id: 7, wallet_addr: WALLET, verified_at: "2026-09-01T00:00:00Z" }, error: null }
    const body = await (await post({ wallet_addr: WALLET })).json()
    expect(body).toMatchObject({ ok: true, already_verified: true })
    expect(state.lastRpc).toBeNull()
  })

  it("rate-limits a single user after 10 attempts in the window", async () => {
    // Each POST costs a Cadence script against a public access node, so the
    // limit is a good-citizen bound as much as a brute-force one.
    const { POST } = await route()
    const call = () => POST({ json: async () => ({ wallet_addr: WALLET, signatures: [] }) } as any)
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await call()).status)
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true)
    expect(codes[10]).toBe(429)
  })
})
