import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for /api/pro-status, added 2026-08-25 — the route had NONE.
//
// 🚨 Every failure path used to answer 200 with
//        { is_pro: false, plan: null, expires_at: null, days_remaining: 0 }
// — a confident claim about the reader's OWN PAID STATUS, manufactured from a
// read that did not happen. `pro_users` holds 21 rows, all active, on `founding`
// and `pro_grandfather`, and the chain useSessionOwner → useProStatus → ProBadge
// renders `null` when `!isPro`. So one hiccup removed the PRO / FOUNDING badge
// site-wide for real paying members, and the hook then cached it for 5 minutes.
//
// ⭐ /api/profile/me's own header already describes this exact chain and that
// route was fixed; this one, one link further down it, was not.
//
// These pin the STATUS and the ABSENCE of the verdict, not the presence of an
// error string — the whole defect was a body that carried a verdict it had not
// established.

const rpcState: { data: any; error: any; throws: unknown } = { data: null, error: null, throws: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpcState.throws) throw rpcState.throws
      return { data: rpcState.data, error: rpcState.error }
    },
  },
}))

import { GET } from "@/app/api/pro-status/route"

function req(url: string) {
  return { nextUrl: new URL(url) } as any
}

beforeEach(() => {
  rpcState.data = null
  rpcState.error = null
  rpcState.throws = null
})

const PRO_URL = "https://t/api/pro-status?wallet=0xAAA"

describe("GET /api/pro-status", () => {
  it("maps an active membership", async () => {
    rpcState.data = { is_pro: true, plan: "founding", expires_at: null, days_remaining: 9999 }
    const res = await GET(req(PRO_URL))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.is_pro).toBe(true)
    expect(body.plan).toBe("founding")
    expect(body.days_remaining).toBe(9999)
  })

  it("reports a genuine non-member as not Pro at 200", async () => {
    // is_pro_user COALESCEs onto this object for a wallet with no row, so this
    // IS the real answer and must keep its 200 — otherwise the fixes below would
    // be satisfied by breaking the ordinary case.
    rpcState.data = { is_pro: false, plan: null, expires_at: null, days_remaining: 0 }
    const res = await GET(req(PRO_URL))
    expect(res.status).toBe(200)
    expect((await res.json()).is_pro).toBe(false)
  })

  it("answers not-Pro at 200 when no wallet is supplied", async () => {
    // Nothing to look up is a true statement, not a failed read.
    const res = await GET(req("https://t/api/pro-status"))
    expect(res.status).toBe(200)
    expect((await res.json()).is_pro).toBe(false)
  })

  describe("a failed membership read must not be published as a verdict", () => {
    it("does not answer 200 when the rpc returns an error", async () => {
      rpcState.error = { message: "boom" }
      const res = await GET(req(PRO_URL))
      expect(res.status).not.toBe(200)
      expect(res.status).toBeGreaterThanOrEqual(500)
    })

    it("does not answer 200 when the rpc throws", async () => {
      rpcState.throws = new Error("fetch failed")
      const res = await GET(req(PRO_URL))
      expect(res.status).not.toBe(200)
    })

    it("publishes NO is_pro verdict at all on failure", async () => {
      // The shipped body carried `is_pro: false` beside the failure. Asserting
      // "there is an error field" would have passed against that exactly.
      rpcState.error = { message: "boom" }
      const body = await (await GET(req(PRO_URL))).json()
      expect(body.is_pro).toBeUndefined()
      expect(body.plan).toBeUndefined()
      expect(body.days_remaining).toBeUndefined()
    })

    it("classifies a statement timeout as a retryable 503", async () => {
      rpcState.error = { code: "57014", message: "canceling statement due to statement timeout" }
      const res = await GET(req(PRO_URL))
      expect(res.status).toBe(503)
      expect((await res.json()).retryable).toBe(true)
    })

    it("treats a null rpc result as a broken read, not as a non-member", async () => {
      // Read from live prosrc rather than assumed: is_pro_user ends in a
      // COALESCE onto a jsonb object, so it cannot return NULL. A null is a
      // broken RPC, and answering "not Pro" from it is the same fabricated
      // claim by a quieter route.
      rpcState.data = null
      const res = await GET(req(PRO_URL))
      expect(res.status).not.toBe(200)
      expect((await res.json()).is_pro).toBeUndefined()
    })
  })
})
