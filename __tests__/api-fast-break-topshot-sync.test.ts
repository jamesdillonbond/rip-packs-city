import { describe, it, expect, beforeEach, vi } from "vitest"

// POST /api/fast-break/topshot-sync — the collector's own Top Shot Fast Break page, read in
// their browser. Pins: the user and wallet come from the SESSION, never the body; a failed
// wallet read or ingest is a named 500, never an "ok" sync.

const calls: { rpc: Array<{ name: string; args: any }> } = { rpc: [] }
let rpcResult: { data: any; error: any } = { data: { run: "Pro Run — Nov 16–29", nights_upserted: 13, cards: 79 }, error: null }
vi.mock("@/lib/supabase", () => {
  const admin: any = {
    rpc: async (name: string, args: any) => {
      calls.rpc.push({ name, args })
      return rpcResult
    },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

let signedIn = true
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!signedIn) throw new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    return { id: "22222222-2222-4222-8222-222222222222" }
  },
}))

let pinned: { wallet: string | null; ok: boolean } = { wallet: "0xABCDEF0123456789", ok: true }
vi.mock("@/lib/wallet/pinned-wallet", () => ({ fetchPinnedWallet: async () => pinned }))

import { POST } from "@/app/api/fast-break/topshot-sync/route"

const req = (body: any, bad = false) =>
  ({ headers: new Headers(), json: async () => { if (bad) throw new Error("bad"); return body } }) as any

const PAYLOAD = {
  contest_id: "contest-run-nba-pro-2026-11-16",
  today: "2026-11-28",
  nights: [{ date: "2026-11-28", objective: "Combine for 10 3-Pointers Made + 20 3-Pointers Attempted" }],
  players: [["Deni Avdija", 1, 2], { name: "Shaedon Sharpe", left: null, total: null }],
  // A body that tries to name another collector must be ignored.
  user_id: "99999999-9999-4999-8999-999999999999",
}

beforeEach(() => {
  calls.rpc = []
  signedIn = true
  pinned = { wallet: "0xABCDEF0123456789", ok: true }
  rpcResult = { data: { run: "Pro Run — Nov 16–29", nights_upserted: 13, cards: 79 }, error: null }
})

describe("POST /api/fast-break/topshot-sync", () => {
  it("401s a signed-out caller", async () => {
    signedIn = false
    expect((await POST(req(PAYLOAD))).status).toBe(401)
    expect(calls.rpc).toHaveLength(0)
  })

  it("400s malformed JSON and a payload that is not a Top Shot contest", async () => {
    expect((await POST(req(null, true))).status).toBe(400)
    const res = await POST(req({ ...PAYLOAD, contest_id: "contest-run-nfl-classic-2026-11-16" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_payload")
    expect(calls.rpc).toHaveLength(0)
  })

  it("500s when the pinned-wallet read fails instead of syncing without the wallet", async () => {
    pinned = { wallet: null, ok: false }
    const res = await POST(req(PAYLOAD))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("wallet_lookup_failed")
    expect(calls.rpc).toHaveLength(0)
  })

  it("500s when the ingest fails — never reports a sync that did not land", async () => {
    rpcResult = { data: null, error: { message: "boom" } }
    const res = await POST(req(PAYLOAD))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("ingest_failed")
    expect(body.ok).toBeUndefined()
  })

  it("ingests with the session's user and lower-cased wallet, not the body's", async () => {
    const res = await POST(req(PAYLOAD))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, walletPinned: true })
    expect(calls.rpc).toHaveLength(1)
    const p = calls.rpc[0].args.p
    expect(calls.rpc[0].name).toBe("fast_break_ingest_topshot")
    expect(p.user_id).toBe("22222222-2222-4222-8222-222222222222")
    expect(p.wallet).toBe("0xabcdef0123456789")
    expect(p.players).toEqual([
      { name: "Deni Avdija", left: 1, total: 2 },
      { name: "Shaedon Sharpe", left: null, total: null },
    ])
  })

  it("still records the run with no pinned wallet, and says the wallet is missing", async () => {
    pinned = { wallet: null, ok: true }
    const body = await (await POST(req(PAYLOAD))).json()
    expect(body.walletPinned).toBe(false)
    expect(calls.rpc[0].args.p.wallet).toBeNull()
  })
})
