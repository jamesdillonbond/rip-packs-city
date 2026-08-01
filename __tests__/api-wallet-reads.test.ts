import { describe, it, expect, beforeEach, vi } from "vitest"

// Wallet read routes share a required-identifier guard (wallet / ownerKey) and
// several also validate the collection slug — all returning 400/401 before any
// DB call. This pins those guards AND drives each route's 2xx path:
//   - pack-summary  → requireUser + verified saved_wallet → get_wallet_pack_summary RPC
//   - edition-counts→ groups wallet_moments_cache rows by edition_key
//   - cost-basis    → non-TopShot collection short-circuits (reason=cost_basis_unavailable)
//   - hold-time     → non-TopShot collection short-circuits (reason=acquisition_data_unavailable)
//   - wallet/profile→ requireOwnedKey → get_user_profile RPC payload echoed with x-rpc-cache: miss
// supabaseAdmin is a table-keyed chainable + per-fn RPC fixture map. Note the
// two auth shapes in play: pack-summary throws-a-Response via requireUser, while
// wallet/profile returns-a-Response via requireOwnedKey (which reads the session
// through getCurrentUser and resolves ownership against profile_bio).

const db: { tables: Record<string, any>; rpc: Record<string, any> } = { tables: {}, rpc: {} }
const authState: { user: { id: string } | null } = { user: null }

// ── requireOwnedKey fixtures (wallet/profile) ───────────────────────────────
// `ownership.claimantId` is who claims the requested ownerKey (null = unclaimed);
// the claimed username echoes back whatever key the route asked about, so any
// ownerKey a test uses resolves to the caller unless the test overrides it.
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

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (t: string) => {
    if (t === "profile_bio") return profileBioBuilder()
    const b: any = {
      select: () => b, eq: () => b, not: () => b, is: () => b, gt: () => b,
      in: () => b, range: () => b, order: () => b, limit: () => b,
      then: (resolve: any) => resolve(db.tables[t] ?? { data: [], error: null }),
    }
    return b
  }
  const client: any = {
    from: (t: string) => makeBuilder(t),
    rpc: async (name: string) => db.rpc[name] ?? { data: null, error: null },
  }
  return { supabaseAdmin: client, supabase: client }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!authState.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      })
    return authState.user
  },
  getCurrentUser: async () => authState.user,
}))

import { GET as packSummary } from "@/app/api/wallet/pack-summary/route"
import { GET as editionCounts } from "@/app/api/wallet/edition-counts/route"
import { GET as costBasis } from "@/app/api/wallet-cost-basis/route"
import { GET as holdTime } from "@/app/api/wallet-hold-time/route"
import { GET as walletProfile } from "@/app/api/wallet/profile/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  db.tables = {}
  db.rpc = {}
  authState.user = null
  ownership.claimantId = "u1"
  ownership.claimantErr = null
  ownership.selfUsername = null
  ownership.selfErr = null
})

describe("wallet read routes — required-identifier guard", () => {
  it("pack-summary is auth-gated: 401 without a signed-in user", async () => {
    expect((await packSummary(req("https://t/api/wallet/pack-summary"))).status).toBe(401)
  })
  it("edition-counts 400s without wallet", async () => {
    expect((await editionCounts(req("https://t/api/wallet/edition-counts"))).status).toBe(400)
  })
  it("cost-basis 400s without wallet", async () => {
    expect((await costBasis(req("https://t/api/wallet-cost-basis"))).status).toBe(400)
  })
  it("hold-time 400s without wallet", async () => {
    expect((await holdTime(req("https://t/api/wallet-hold-time"))).status).toBe(400)
  })
  it("wallet/profile 400s without ownerKey", async () => {
    expect((await walletProfile(req("https://t/api/wallet/profile"))).status).toBe(400)
  })
  it("wallet/profile is auth-gated: 401 without a signed-in user", async () => {
    expect((await walletProfile(req("https://t/api/wallet/profile?ownerKey=trevor-unique-401"))).status).toBe(401)
  })
  it("wallet/profile 403s when ownerKey belongs to a DIFFERENT user", async () => {
    authState.user = { id: "attacker" }
    ownership.claimantId = "victim"
    db.rpc.get_user_profile = { data: { username: "victim", wallets: 9 }, error: null }
    const res = await walletProfile(req("https://t/api/wallet/profile?ownerKey=trevor-unique-403"))
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain("victim")
  })
})

describe("wallet read routes — collection-slug guard", () => {
  it("edition-counts 400s on an unknown collection", async () => {
    const res = await editionCounts(req("https://t/api/wallet/edition-counts?wallet=0xabc&collection=not-real"))
    expect(res.status).toBe(400)
  })
  it("cost-basis 400s on an unknown collection", async () => {
    const res = await costBasis(req("https://t/api/wallet-cost-basis?wallet=0xabc&collection=not-real"))
    expect(res.status).toBe(400)
  })
})

describe("wallet read routes — success paths", () => {
  it("pack-summary 200s with the RPC summary for a verified wallet", async () => {
    authState.user = { id: "u1" }
    db.tables.saved_wallets = { data: [{ wallet_addr: "0xabc", verified_at: "2026-07-01" }], error: null }
    db.rpc.get_wallet_pack_summary = { data: { totals: { primary_drops: 4 }, wallet: "0xabc" }, error: null }
    const res = await packSummary(req("https://t/api/wallet/pack-summary?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals.primary_drops).toBe(4)
  })

  it("pack-summary 403s when the wallet is not verified on the account", async () => {
    authState.user = { id: "u1" }
    db.tables.saved_wallets = { data: [], error: null }
    const res = await packSummary(req("https://t/api/wallet/pack-summary?wallet=0xabc"))
    expect(res.status).toBe(403)
  })

  it("edition-counts 200s and groups rows by edition_key", async () => {
    db.tables.wallet_moments_cache = {
      data: [
        { edition_key: "73:2785", is_locked: true },
        { edition_key: "73:2785", is_locked: false },
        { edition_key: "8:1", is_locked: false },
      ],
      error: null,
    }
    const res = await editionCounts(req("https://t/api/wallet/edition-counts?wallet=0xABC&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc")
    expect(body.editionCount).toBe(2)
    expect(body.editions["73:2785"]).toEqual({ owned: 2, locked: 1 })
  })

  it("cost-basis 200s with cost_basis_unavailable for a non-TopShot collection", async () => {
    const res = await costBasis(req("https://t/api/wallet-cost-basis?wallet=0xbd94cade097e50ac&collection=nfl-all-day"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reason).toBe("cost_basis_unavailable")
    expect(body.wallet).toBe("0xbd94cade097e50ac")
  })

  it("hold-time 200s with acquisition_data_unavailable for a non-TopShot collection", async () => {
    const res = await holdTime(req("https://t/api/wallet-hold-time?wallet=0xbd94cade097e50ac&collection=nfl-all-day"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reason).toBe("acquisition_data_unavailable")
  })

  it("wallet/profile 200s and returns the RPC payload (cache miss) for the owning session", async () => {
    authState.user = { id: "u1" }
    db.rpc.get_user_profile = { data: { username: "trevor", wallets: 3 }, error: null }
    const res = await walletProfile(req("https://t/api/wallet/profile?ownerKey=trevor-unique-1"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-rpc-cache")).toBe("miss")
    const body = await res.json()
    expect(body.username).toBe("trevor")
  })
})
