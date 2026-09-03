import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/profile/[username]. Dynamic route: 2nd
// arg is { params: Promise<{ username }> }. Pipeline is username -> user_id
// (profile_bio maybeSingle #1), then a parallel fan-out of the full bio
// (profile_bio maybeSingle #2), trophies (rpc), and saved_wallets (thenable). We
// mock supabaseAdmin with a per-table builder + a call counter on profile_bio to
// return the resolve row then the full bio. Pins the 400 (missing handle), 404
// (unknown handle), 500 (resolve error), and the happy path.

const st: { idRow: any; idErr: any; bio: any; bioErr: any; trophy: any; wallets: any } = {
  idRow: null,
  idErr: null,
  bio: null,
  bioErr: null,
  trophy: [],
  wallets: [],
}
let bioCall = 0

vi.mock("@/lib/supabase", () => {
  const mk = (table: string): any => {
    const b: any = {
      select: () => b,
      ilike: () => b,
      eq: () => b,
      maybeSingle: async () => {
        if (table === "profile_bio") {
          bioCall++
          return bioCall === 1
            ? { data: st.idRow, error: st.idErr }
            : { data: st.bio, error: st.bioErr }
        }
        return { data: null, error: null }
      },
      then: (resolve: any) => resolve({ data: st.wallets, error: null }),
    }
    return b
  }
  return {
    supabaseAdmin: {
      from: (t: string) => mk(t),
      rpc: async () => ({ data: st.trophy, error: null }),
    },
  }
})

import { GET } from "@/app/api/public/profile/[username]/route"

const ctx = (username: string) => ({ params: Promise.resolve({ username }) })
const req = {} as any

beforeEach(() => {
  bioCall = 0
  st.idRow = null
  st.idErr = null
  st.bio = null
  st.bioErr = null
  st.trophy = []
  st.wallets = []
})

describe("GET /api/public/profile/[username]", () => {
  it("400s when the username is blank", async () => {
    const res = await GET(req, ctx("   "))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("username required")
  })

  it("404s when the handle resolves to no user", async () => {
    st.idRow = null
    const res = await GET(req, ctx("ghost"))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("Not found")
    expect(body.username).toBe("ghost")
  })

  it("500s when the username->user_id resolve errors", async () => {
    st.idErr = { message: "resolve down" }
    const res = await GET(req, ctx("trevor"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("resolve down")
  })

  it("returns the assembled public profile bundle on the happy path", async () => {
    st.idRow = { user_id: "u1" }
    st.bio = {
      username: "trevor",
      display_name: "Trevor",
      tagline: "team captain",
      favorite_team: "Blazers",
      twitter: "@tdillonbond",
      discord: null,
      avatar_url: null,
      accent_color: "#E03A2F",
      equipped_border: null,
      equipped_banner: null,
    }
    st.trophy = [{ slot: 1, moment_id: "m1", player_name: "Dame", serial_number: "1", fmv: "9000" }]
    st.wallets = [
      { wallet_addr: "0xabc", collection_id: "c1", cached_fmv_usd: 1234, accent_color: null },
    ]
    const res = await GET(req, ctx("Trevor"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.username).toBe("trevor")
    expect(body.bio.display_name).toBe("Trevor")
    // trophies numeric coercion out of the jsonb RPC
    expect(body.trophies[0].serial_number).toBe(1)
    expect(body.trophies[0].fmv).toBe(9000)
    // ⚠ `wallet_addr`, NOT `wallet_address`. This assertion previously named a
    // column that does not exist on saved_wallets, so the privacy strip it
    // claims to guard was never actually tested — it passed on any payload,
    // including one leaking every address. It matters now: the query SELECTS
    // wallet_addr (to count distinct addresses) and drops it in the mapping,
    // so this is the only thing standing between that and publishing it.
    expect(body.wallets[0]).not.toHaveProperty("wallet_addr")
    expect(JSON.stringify(body)).not.toContain("0xabc")
    expect(body.wallets[0].accent_color).toBe("#E03A2F")
    expect(body.wallets[0].cached_fmv).toBe(1234)
  })

  // 2026-09-02 (onboarding QA #6): the stale split the dashboard uses is now
  // on the payload, so public surfaces can hold stale value out of the headline.
  it("ships the stale-priced split alongside the total, null when not yet reconciled", async () => {
    st.idRow = { user_id: "u1" }
    st.bio = { username: "trevor", display_name: "Trevor" }
    st.trophy = []
    st.wallets = [
      { wallet_addr: "0xabc", collection_id: "c1", cached_fmv_usd: 88425, cached_fmv_stale_usd: 39553, cached_stale_count: 370, accent_color: null },
      { wallet_addr: "0xabc", collection_id: "c2", cached_fmv_usd: 100, accent_color: null },
    ]
    const body = await (await GET(req, ctx("Trevor"))).json()
    expect(body.wallets[0].cached_fmv).toBe(88425)
    expect(body.wallets[0].cached_fmv_stale).toBe(39553)
    expect(body.wallets[0].cached_stale_count).toBe(370)
    expect(body.wallets[1].cached_fmv_stale).toBeNull()
    expect(body.wallets[1].cached_stale_count).toBeNull()
  })
})

describe("wallet_count counts ADDRESSES, not saved_wallets rows", () => {
  // The bug this replaced: saved_wallets is keyed per (wallet_addr,
  // collection_id), so pinning ONE address writes one row per collection it
  // holds moments in. The profile rendered `wallets.length` and told a
  // collector with a single Dapper wallet that they had "4 WALLETS".
  //
  // It is computed server-side and shipped as a scalar because the addresses
  // are stripped from the payload — no client can derive it.
  beforeEach(() => {
    st.idRow = { user_id: "u1" }
    st.bio = { username: "trevor", display_name: "Trevor" }
  })

  it("reports 1 for one address spread across four collections", async () => {
    st.wallets = ["c1", "c2", "c3", "c4"].map((c) => ({
      wallet_addr: "0xbd94cade097e50ac",
      collection_id: c,
      cached_fmv_usd: 100,
      cached_moment_count: 10,
    }))
    const body = await (await GET(req, ctx("trevor"))).json()
    expect(body.wallets).toHaveLength(4) // the rows are all still there…
    expect(body.wallet_count).toBe(1) // …but that is ONE wallet
  })

  it("still counts genuinely distinct addresses separately", async () => {
    // The mirror case. A fix that just hardcoded 1, or counted collections,
    // would pass the case above and be wrong for everyone with two wallets.
    st.wallets = [
      { wallet_addr: "0xaaa", collection_id: "c1" },
      { wallet_addr: "0xaaa", collection_id: "c2" },
      { wallet_addr: "0xbbb", collection_id: "c1" },
    ]
    const body = await (await GET(req, ctx("trevor"))).json()
    expect(body.wallet_count).toBe(2)
  })

  it("treats casing/whitespace as the same address", async () => {
    st.wallets = [
      { wallet_addr: "0xAAA", collection_id: "c1" },
      { wallet_addr: " 0xaaa ", collection_id: "c2" },
    ]
    const body = await (await GET(req, ctx("trevor"))).json()
    expect(body.wallet_count).toBe(1)
  })

  it("does not count a row whose address is missing", async () => {
    // A row we cannot attribute to an address is not evidence of another
    // wallet, and counting it would reintroduce the over-count one row at a
    // time.
    st.wallets = [
      { wallet_addr: "0xaaa", collection_id: "c1" },
      { wallet_addr: null, collection_id: "c2" },
      { wallet_addr: "", collection_id: "c3" },
    ]
    const body = await (await GET(req, ctx("trevor"))).json()
    expect(body.wallet_count).toBe(1)
  })

  it("is 0, not absent, for a collector with no wallets", async () => {
    // The client omits the line when the field is missing, so an absent
    // wallet_count would silently hide a real zero.
    st.wallets = []
    const body = await (await GET(req, ctx("trevor"))).json()
    expect(body.wallet_count).toBe(0)
  })
})
