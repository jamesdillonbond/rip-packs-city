import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/profile/hero-moment.
// Resolution order: ?ownerKey → getCurrentUser() → smoke-test header. Pins the
// fail-closed 401, the authed happy path, the no-FMV fall-through, AND
// (2026-07-28 Gap-C error-leg pass) the previously-dark branches: ownerKey
// resolution via saved_wallets (0x) and profile_bio (username), the smoke-test
// synthetic hero, the RPC-error 500, the no_moments reason, and the
// manual_no_fmv reason.

const state: {
  user: any
  rpc: { data: any; error: any }
  tables: Record<string, any>
} = {
  user: null,
  rpc: { data: null, error: null },
  tables: {},
}

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(() => state.tables[t] ?? { data: null, error: null }),
    rpc: async () => state.rpc,
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/hero-moment/route"

const req = (url: string, headers: Record<string, string> = {}) =>
  ({
    nextUrl: new URL(url),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as any

const TOPSHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const pricedRow = (over: Record<string, any> = {}) => ({
  moment_id: "m1",
  player_name: "Dame",
  set_name: "Base",
  tier: "RARE",
  serial_number: 5,
  mint_count: 100,
  image_url: null,
  edition_key: "1:1",
  fmv_usd: 42,
  is_locked: false,
  is_manual_override: false,
  collection_id: TOPSHOT_UUID,
  ...over,
})

beforeEach(() => {
  state.user = null
  state.rpc = { data: null, error: null }
  state.tables = {}
})

describe("GET /api/profile/hero-moment", () => {
  it("401s with reason no_user when no user resolves and it is not a smoke request", async () => {
    const res = await GET(req("https://t/api/profile/hero-moment"))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.hero).toBeNull()
    expect(body.reason).toBe("no_user")
  })

  it("returns the hero for an authed user with a priced moment", async () => {
    state.user = { id: "u1" }
    state.rpc = { data: [pricedRow()], error: null }
    const res = await GET(req("https://t/api/profile/hero-moment"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hero.momentId).toBe("m1")
    expect(body.hero.fmvUsd).toBe(42)
    expect(body.hero.collectionUuid).toBe(TOPSHOT_UUID)
    // resolves the collection label from COLLECTIONS by uuid
    expect(body.hero.collectionId).toBe("nba-top-shot")
  })

  it("resolves ownerKey as a 0x wallet via saved_wallets", async () => {
    state.tables.saved_wallets = { data: { user_id: "u-wallet" }, error: null }
    state.rpc = { data: [pricedRow({ moment_id: "mw" })], error: null }
    const res = await GET(req("https://t/api/profile/hero-moment?ownerKey=0xABCDEF0000000000"))
    expect(res.status).toBe(200)
    expect((await res.json()).hero.momentId).toBe("mw")
    // getCurrentUser must NOT be the resolver here — ownerKey won
    expect(state.user).toBeNull()
  })

  it("resolves ownerKey as a username via profile_bio", async () => {
    state.tables.profile_bio = { data: { user_id: "u-name" }, error: null }
    state.rpc = { data: [pricedRow({ moment_id: "mn" })], error: null }
    const res = await GET(req("https://t/api/profile/hero-moment?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).hero.momentId).toBe("mn")
  })

  // HONESTY CANON — CLAUDE.md's worst sub-class (a false claim about the
  // reader's own account), and a byte-for-byte COPY of the same defect in
  // /api/profile/top-moments. `resolveUserId` swallowed both lookup errors, so
  // a FAILED read of an explicitly-requested ownerKey fell through to
  // `getCurrentUser()` and this route answered with THE VIEWER'S hero moment
  // under someone else's key. The two ownerKey cases directly above are the
  // positive controls: a successful resolve must still win over the session.
  it("does not substitute the viewer's own hero when the wallet lookup errored", async () => {
    state.user = { id: "viewer-1" }
    state.tables.saved_wallets = { data: null, error: { message: "canceling statement due to statement timeout" } }
    state.rpc = { data: [pricedRow({ moment_id: "viewer-hero" })], error: null }
    const res = await GET(req("https://t/api/profile/hero-moment?ownerKey=0xABCDEF0000000000"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("viewer-hero")
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("does not publish reason 'no_user' out of a failed username lookup", async () => {
    state.user = null
    state.tables.profile_bio = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/profile/hero-moment?ownerKey=trevor"))
    expect(res.status).not.toBe(401)
    expect(JSON.stringify(await res.json())).not.toContain("no_user")
  })

  it("an ownerKey that resolves to nobody still falls back to the session — positive control", async () => {
    state.user = { id: "viewer-1" }
    state.tables.profile_bio = { data: null, error: null } // read OK, no such owner
    state.rpc = { data: [pricedRow({ moment_id: "viewer-hero" })], error: null }
    const res = await GET(req("https://t/api/profile/hero-moment?ownerKey=nobody"))
    expect(res.status).toBe(200)
    expect((await res.json()).hero.momentId).toBe("viewer-hero")
  })

  it("500s when the hero RPC errors", async () => {
    state.user = { id: "u1" }
    state.rpc = { data: null, error: { message: "rpc down" } }
    const res = await GET(req("https://t/api/profile/hero-moment"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("rpc down")
  })

  it("returns hero:null reason no_moments when the RPC yields no row", async () => {
    state.user = { id: "u1" }
    state.rpc = { data: [], error: null }
    const res = await GET(req("https://t/api/profile/hero-moment"))
    const body = await res.json()
    expect(body.hero).toBeNull()
    expect(body.reason).toBe("no_moments")
  })

  it("returns reason no_fmv when the top moment has no positive FMV", async () => {
    state.user = { id: "u1" }
    state.rpc = { data: [pricedRow({ fmv_usd: 0 })], error: null }
    const body = await (await GET(req("https://t/api/profile/hero-moment"))).json()
    expect(body.hero).toBeNull()
    expect(body.reason).toBe("no_fmv")
  })

  it("returns reason manual_no_fmv when a manual override has no positive FMV", async () => {
    state.user = { id: "u1" }
    state.rpc = { data: [pricedRow({ fmv_usd: 0, is_manual_override: true })], error: null }
    const body = await (await GET(req("https://t/api/profile/hero-moment"))).json()
    expect(body.hero).toBeNull()
    expect(body.reason).toBe("manual_no_fmv")
  })

  describe("smoke-test header stub", () => {
    const prev = process.env.SMOKE_TEST_SESSION_TOKEN
    afterEach(() => {
      if (prev === undefined) delete process.env.SMOKE_TEST_SESSION_TOKEN
      else process.env.SMOKE_TEST_SESSION_TOKEN = prev
    })

    it("returns the synthetic hero when the smoke token matches and no user resolves", async () => {
      process.env.SMOKE_TEST_SESSION_TOKEN = "s3cr3t-token"
      const res = await GET(
        req("https://t/api/profile/hero-moment", { "x-rpc-smoke-test": "s3cr3t-token" })
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.hero.isSmokeTestStub).toBe(true)
      expect(body.hero.momentId).toBe("smoke-test-stub")
    })

    it("still 401s when the smoke token is wrong (length differs → no compare)", async () => {
      process.env.SMOKE_TEST_SESSION_TOKEN = "s3cr3t-token"
      const res = await GET(
        req("https://t/api/profile/hero-moment", { "x-rpc-smoke-test": "nope" })
      )
      expect(res.status).toBe(401)
    })
  })
})
