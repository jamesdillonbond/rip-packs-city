import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/portfolio-history.
// GET stays PUBLIC and has two branches: ?wallet → get_wallet_fmv_history RPC;
// ?ownerKey → portfolio_snapshots table; neither → 400. Pin the missing-param
// 400, the wallet-branch happy path, the ownerKey-branch happy path, and the
// wallet RPC error → 500.
//
// POST is session-gated as of the owner-key IDOR fix: it upserts a snapshot row
// selected by a body `ownerKey`, so `requireOwnedKey` must prove the key belongs
// to the caller first. Its 400 / upsert-shape / 500 legs are pinned alongside
// the 401 + cross-user 403 security contract.

const state: {
  rpc: { data: any[] | any | null; error: any | null }
  snapshots: { data: any[] | any | null; error: any | null }
  upserted: { data: any | null; error: any | null }
  upsertRows: any[]
  rpcArgs: any
} = {
  rpc: { data: [], error: null },
  snapshots: { data: [], error: null },
  upserted: { data: { id: "s1" }, error: null },
  upsertRows: [],
  rpcArgs: null,
}

// ── requireOwnedKey fixtures ────────────────────────────────────────────────
// The guard demands a session AND that `profile_bio` prove the key belongs to
// that session user. `ownership.claimantId` is who claims the requested key
// (null = unclaimed); the claimed username echoes back whatever key the route
// asked about, so any ownerKey a test uses resolves to the caller unless the
// test overrides it. `selfUsername` drives the unclaimed-key branch.
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
    from(table: string) {
      if (table === "profile_bio") return profileBioBuilder()
      let isUpsert = false
      const b: any = {
        select: () => b, eq: () => b, gte: () => b, order: () => b,
        upsert: (row: any) => { isUpsert = true; state.upsertRows.push(row); return b },
        single: async () => state.upserted,
        then: (resolve: any) => resolve(isUpsert ? state.upserted : state.snapshots),
      }
      return b
    },
    rpc: async (_n: string, args: any) => { state.rpcArgs = args; return state.rpc },
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { GET, POST } from "@/app/api/profile/portfolio-history/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.rpc = { data: [], error: null }
  state.snapshots = { data: [], error: null }
  state.upserted = { data: { id: "s1" }, error: null }
  state.upsertRows = []
  state.rpcArgs = null
  auth.user = { id: "u1" }
  ownership.claimantId = "u1"
  ownership.claimantErr = null
  ownership.selfUsername = null
  ownership.selfErr = null
})

describe("GET /api/profile/portfolio-history", () => {
  it("400s when neither ownerKey nor wallet is provided", async () => {
    const res = await GET(req("https://t/api/profile/portfolio-history"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey or wallet required")
  })

  it("returns the wallet FMV-history snapshots for ?wallet", async () => {
    state.rpc = { data: [{ day: "2026-07-01", total_fmv: 100 }], error: null }
    const res = await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc&days=30"))
    expect(res.status).toBe(200)
    expect((await res.json()).snapshots).toHaveLength(1)
  })

  it("500s when the wallet RPC errors", async () => {
    state.rpc = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("returns portfolio_snapshots for the ?ownerKey branch", async () => {
    state.snapshots = { data: [{ snapshot_date: "2026-07-01", total_fmv: 50 }], error: null }
    const res = await GET(req("https://t/api/profile/portfolio-history?ownerKey=trevor&days=7"))
    expect(res.status).toBe(200)
    expect((await res.json()).snapshots).toHaveLength(1)
  })

  it("defaults snapshots to [] when the query returns null data", async () => {
    state.snapshots = { data: null, error: null }
    expect((await (await GET(req("https://t/api/profile/portfolio-history?ownerKey=t"))).json()).snapshots).toEqual([])
  })

  it("500s when the ownerKey snapshot read errors", async () => {
    state.snapshots = { data: null, error: { message: "snap down" } }
    expect((await GET(req("https://t/api/profile/portfolio-history?ownerKey=t"))).status).toBe(500)
  })

  it("caps ?days at 90 and defaults it to 30", async () => {
    await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc&days=999"))
    expect(state.rpcArgs.p_days).toBe(90)
    await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc"))
    expect(state.rpcArgs.p_days).toBe(30)
  })

  it("prefers the wallet branch when BOTH wallet and ownerKey are supplied", async () => {
    state.rpc = { data: [{ day: "d", total_fmv: 1 }], error: null }
    state.snapshots = { data: [{ a: 1 }, { b: 2 }], error: null }
    const body = await (await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc&ownerKey=t"))).json()
    expect(body.snapshots).toHaveLength(1) // the RPC result, not the table read
  })

  it("stays PUBLIC — an unauthenticated read still works (only POST is gated)", async () => {
    auth.user = null
    state.snapshots = { data: [{ snapshot_date: "2026-07-01", total_fmv: 50 }], error: null }
    const res = await GET(req("https://t/api/profile/portfolio-history?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).snapshots).toHaveLength(1)
  })
})

describe("POST /api/profile/portfolio-history", () => {
  const preq = (body: any) => ({ json: async () => body }) as any

  it("400s without an ownerKey", async () => {
    const res = await POST(preq({ totalFmv: 10 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("upserts today's snapshot and returns the row", async () => {
    const body = await (await POST(preq({ ownerKey: "trevor", totalFmv: 250.5, momentCount: 12, walletCount: 2 }))).json()
    expect(body.snapshot).toEqual({ id: "s1" })
    const row = state.upsertRows[0]
    expect(row.owner_key).toBe("trevor")
    expect(row.total_fmv).toBe(250.5)
    expect(row.moment_count).toBe(12)
    expect(row.wallet_count).toBe(2)
    expect(row.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("zero-fills missing numeric fields rather than writing undefined", async () => {
    await POST(preq({ ownerKey: "trevor" }))
    const row = state.upsertRows[0]
    expect(row.total_fmv).toBe(0)
    expect(row.moment_count).toBe(0)
    expect(row.wallet_count).toBe(0)
  })

  it("500s on an upsert error", async () => {
    state.upserted = { data: null, error: { message: "upsert down" } }
    expect((await POST(preq({ ownerKey: "trevor" }))).status).toBe(500)
  })

  // ── the ownership contract (the IDOR that was closed) ─────────────────────
  // The upsert is keyed (owner_key, snapshot_date) on a service-role client, so
  // before the guard any caller could overwrite another user's portfolio history
  // for today — silently corrupting the FMV/moment-count series they see.
  it("401s when unauthenticated, writing nothing", async () => {
    auth.user = null
    const res = await POST(preq({ ownerKey: "victim", totalFmv: 1 }))
    expect(res.status).toBe(401)
    expect(state.upsertRows).toEqual([])
  })

  it("403s when ownerKey is claimed by a DIFFERENT user, writing nothing", async () => {
    auth.user = { id: "attacker" }
    ownership.claimantId = "victim"
    const res = await POST(preq({ ownerKey: "victim", totalFmv: 999999 }))
    expect(res.status).toBe(403)
    expect(state.upsertRows).toEqual([])
  })

  it("fails CLOSED with 403 when the ownership lookup itself errors", async () => {
    ownership.claimantErr = { message: "profile_bio unavailable" }
    const res = await POST(preq({ ownerKey: "trevor", totalFmv: 1 }))
    expect(res.status).toBe(403)
    expect(state.upsertRows).toEqual([])
  })
})
