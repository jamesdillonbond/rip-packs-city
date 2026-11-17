import { describe, it, expect, beforeEach, vi } from "vitest"

// A public Portfolio FMV sums ONLY wallets the profile's user OWNS (2026-11-14).
// Anyone can save any address, so before this a collector could save a
// stranger's wallet and publish its holdings as their own (profile, OG card,
// share tweet). Ownership is the estate's single rule (lib/wallet/wallet-owner.ts):
// a verifier, else the first saver — the rule that already gates private reads.

const st: { own: any[]; claims: any[]; claimsErr: any } = { own: [], claims: [], claimsErr: null }
let bioCall = 0

vi.mock("@/lib/supabase", () => {
  const mk = (table: string): any => {
    let isClaimRead = false
    const b: any = {
      select: (cols: string) => {
        if (table === "saved_wallets" && /verified_at/.test(cols)) isClaimRead = true
        return b
      },
      ilike: () => b,
      eq: () => b,
      in: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        bioCall++
        return bioCall === 1
          ? { data: { user_id: "me" }, error: null }
          : { data: { username: "collector" }, error: null }
      },
      then: (resolve: any) =>
        resolve(isClaimRead ? { data: st.claims, error: st.claimsErr } : { data: st.own, error: null }),
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => mk(t), rpc: async () => ({ data: [], error: null }) } }
})

import { getPublicProfile } from "@/lib/profile/public-profile"

const wallet = (addr: string, fmv: number) => ({
  wallet_addr: addr,
  username: null,
  display_name: null,
  collection_id: "c",
  cached_fmv_usd: fmv,
})

beforeEach(() => {
  bioCall = 0
  st.claimsErr = null
  st.own = [wallet("0x00000000000000aa", 100), wallet("0x00000000000000bb", 900_000)]
})

describe("public profile wallets are the user's own", () => {
  it("drops a wallet another account VERIFIED, keeps the user's first-saved wallet", async () => {
    st.claims = [
      { id: 1, user_id: "me", wallet_addr: "0x00000000000000aa", verified_at: null },
      { id: 2, user_id: "whale", wallet_addr: "0x00000000000000bb", verified_at: "2026-09-01" },
      { id: 3, user_id: "me", wallet_addr: "0x00000000000000bb", verified_at: null },
    ]
    const r = await getPublicProfile("collector-a")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.wallets.map((w) => w.cached_fmv)).toEqual([100])
    expect(r.data.wallet_count).toBe(1)
  })

  it("drops a wallet another account saved FIRST when nobody verified it", async () => {
    st.claims = [
      { id: 1, user_id: "me", wallet_addr: "0x00000000000000aa", verified_at: null },
      { id: 2, user_id: "whale", wallet_addr: "0x00000000000000bb", verified_at: null },
      { id: 9, user_id: "me", wallet_addr: "0x00000000000000bb", verified_at: null },
    ]
    const r = await getPublicProfile("collector-b")
    expect(r.ok && r.data.wallets.map((w) => w.cached_fmv)).toEqual([100])
  })

  it("keeps a wallet the user verified even though another account saved it first", async () => {
    st.claims = [
      { id: 1, user_id: "squatter", wallet_addr: "0x00000000000000bb", verified_at: null },
      { id: 5, user_id: "me", wallet_addr: "0x00000000000000bb", verified_at: "2026-10-01" },
      { id: 6, user_id: "me", wallet_addr: "0x00000000000000aa", verified_at: null },
    ]
    const r = await getPublicProfile("collector-c")
    expect(r.ok && r.data.wallets.map((w) => w.cached_fmv)).toEqual([100, 900_000])
  })

  it("fails the bundle when the ownership read fails — never publishes the unfiltered sum", async () => {
    st.claims = []
    st.claimsErr = { message: "claims down" }
    const r = await getPublicProfile("collector-d")
    expect(r.ok).toBe(false)
  })

  it("2026-11-15: counts only wallets THIS user verified (not another account's verification)", async () => {
    st.claims = [
      { id: 1, user_id: "me", wallet_addr: "0x00000000000000aa", verified_at: "2026-11-15" },
      { id: 2, user_id: "me", wallet_addr: "0x00000000000000AA", verified_at: "2026-11-15" },
      { id: 3, user_id: "whale", wallet_addr: "0x00000000000000bb", verified_at: "2026-09-01" },
    ]
    const r = await getPublicProfile("collector-e")
    expect(r.ok && r.data.verified_wallet_count).toBe(1)
  })

  it("2026-11-15: zero verified wallets reads 0, not absent", async () => {
    st.claims = [{ id: 1, user_id: "me", wallet_addr: "0x00000000000000aa", verified_at: null }]
    const r = await getPublicProfile("collector-f")
    expect(r.ok && r.data.verified_wallet_count).toBe(0)
  })
})
