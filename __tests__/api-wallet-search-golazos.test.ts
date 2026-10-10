import { describe, it, expect, beforeEach, vi } from "vitest"

// Golazos wallet analysis in POST /api/wallet-search. Golazos is served from
// wallet_moments_cache via the shared get_wallet_moments_with_fmv RPC +
// serverMomentToRow (the SAME source/mapper /api/collection-moments uses), NOT a
// live on-chain walk — the Cadence walk that fills wmc is owned by
// /api/wallet-backfill-golazos. Pins: the populated read maps RPC moments ->
// MomentRow rows with a correct summary; an empty wmc read returns rows:[] (and,
// with no INGEST token in test, never attempts the backfill fetch); an RPC error
// returns a soft 200 error; and an unresolvable username returns the resolve
// error. Also guards that the stale "coming soon" stub is gone.

const state = vi.hoisted(() => ({
  rpc: { data: null as unknown, error: null as { message?: string } | null },
  resolveFound: false,
}))

vi.mock("@/lib/cache", () => ({ getOrSetCache: (_k: string, _t: number, fn: () => unknown) => fn() }))
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({}),
    // The durable dedup counter (2026-10-10) is keyed by bucket+key; everything
    // else is the wmc read.
    rpc: async (fn: string, args: any) => {
      if (fn !== "bump_anon_action_rate") return state.rpc
      const g = globalThis as any
      if (g.__rateError) return { data: null, error: { message: "timeout" } }
      g.__rate = g.__rate ?? {}
      const k = `${args.p_bucket}|${args.p_key}`
      g.__rate[k] = (g.__rate[k] ?? 0) + 1
      return { data: { allowed: g.__rate[k] <= args.p_limit }, error: null }
    },
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () =>
    state.resolveFound
      ? { found: true, walletAddress: "0xc4ab4a06ade1fd0f" }
      : { found: false, reason: (state as { resolveReason?: string }).resolveReason ?? "username_not_found_on_topshot" },
}))

import { POST } from "@/app/api/wallet-search/route"

const ADDR = "0xc4ab4a06ade1fd0f"
const req = (body: Record<string, unknown>): any => ({
  json: async () => body,
  url: "https://t/api/wallet-search",
})

// A ServerMoment as get_wallet_moments_with_fmv returns for Golazos (shape
// captured live 2026-08-09).
const moment = (over: Record<string, unknown> = {}) => ({
  moment_id: "1006747815",
  edition_key: "505",
  serial_number: 1,
  fmv_usd: 5,
  confidence: "STALE",
  low_ask: 2,
  player_name: "Diego Milito",
  set_name: "Estrellas",
  tier: "RARE",
  series_number: 1,
  circulation_count: 207,
  thumbnail_url: "https://assets.laligagolazos.com/x.png",
  team_name: "Real Zaragoza",
  acquired_at: null,
  last_seen_at: null,
  buy_price: null,
  acquisition_method: null,
  acquisition_source: null,
  acquisition_confidence: null,
  loan_principal: null,
  source_address: null,
  is_locked: false,
  ...over,
})

beforeEach(() => {
  state.rpc = { data: null, error: null }
  state.resolveFound = false
  delete process.env.INGEST_SECRET_TOKEN
})

describe("POST /api/wallet-search — Golazos wmc path", () => {
  it("maps wmc moments to MomentRow rows with a correct summary", async () => {
    state.rpc = {
      data: [
        {
          moments: [moment(), moment({ moment_id: "1023633856", player_name: "Willian José", fmv_usd: 24.5 })],
          total_count: 9400,
        },
      ],
      error: null,
    }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos", limit: 2, offset: 0 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBeUndefined()
    expect(body.rows).toHaveLength(2)
    expect(body.rows[0].momentId).toBe("1006747815")
    expect(body.rows[0].playerName).toBe("Diego Milito")
    expect(body.rows[0].tier).toBe("RARE")
    expect(body.rows[0].fmv).toBe(5)
    expect(body.rows[0].serialNumber).toBe(1)
    expect(body.rows[0].lowAsk).toBe(2)
    expect(body.rows[0].editionKey).toBe("505")
    expect(body.rows[0].thumbnailUrl).toBe("https://assets.laligagolazos.com/x.png")
    expect(body.rows[1].playerName).toBe("Willian José")
    expect(body.walletAddress).toBe(ADDR)
    // total_count drives totalMoments; remaining accounts for the offset window.
    expect(body.summary).toEqual({ totalMoments: 9400, returnedMoments: 2, remainingMoments: 9398 })
  })

  it("computes remainingMoments from the offset window", async () => {
    state.rpc = { data: [{ moments: [moment()], total_count: 50 }], error: null }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos", limit: 1, offset: 10 }))
    const body = await res.json()
    // 50 total - offset 10 - 1 returned = 39 remaining.
    expect(body.summary).toEqual({ totalMoments: 50, returnedMoments: 1, remainingMoments: 39 })
  })

  it("returns rows:[] (no stale 'coming soon') on an empty wmc read", async () => {
    state.rpc = { data: [{ moments: [], total_count: 0 }], error: null }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.summary.totalMoments).toBe(0)
    expect(JSON.stringify(body)).not.toContain("coming soon")
  })

  // ⭐ WHY 200 AND NOT 500 — recorded 2026-09-14 because a session re-litigated
  // this pin, wrote the 500, and only this test caught it. The pin is CORRECT,
  // and the argument is about CALLERS, not about the status code in the abstract:
  //   · app/share/[wallet]/ShareEmptyState.tsx guards on `!res.ok` and would
  //     indeed be defeated by a 200 — but it posts NO `collection` field, so it
  //     takes the Top Shot path and CANNOT REACH this Golazos branch.
  //   · app/api/profile/resolve-and-associate sends `nba-top-shot`; smoke-test
  //     sends no collection. Neither reaches it either.
  //   · app/api/support-chat is the ONLY caller that can (`effectiveCollectionId`)
  //     and it reads `data?.error` BEFORE looking at status, so it is already
  //     correct and a 5xx would gain it nothing.
  // So no caller both reaches this branch and discriminates on status. Golazos is
  // one collection inside a multi-collection endpoint; failing the whole request
  // with a 5xx would be a louder claim than the failure supports.
  // ⚠ If a NEW caller ever reaches this branch AND gates on `res.ok`/status, this
  // trade flips — re-derive the caller list before changing the code, and update
  // this comment rather than deleting the test.
  it("returns a soft 200 error (never a 5xx) when the wmc read fails", async () => {
    state.rpc = { data: null, error: { message: "boom" } }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.error).toContain("Failed to fetch")
  })

  // 2026-09-29: a handle Top Shot does not know and a lookup that could not
  // reach Top Shot need opposite copy; both used to answer "Could not resolve".
  it("a username Top Shot does not know is a 404 that says check the spelling", async () => {
    state.resolveFound = false
    ;(state as { resolveReason?: string }).resolveReason = "username_not_found_on_topshot"
    const res = await POST(req({ input: "nosuchuser", collection: "laliga-golazos" }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe("username_not_found")
    expect(body.error).toMatch(/Check the spelling/)
    expect(body.rows).toEqual([])
  })

  it("a lookup that could not reach Top Shot is a 503 that concludes nothing", async () => {
    state.resolveFound = false
    ;(state as { resolveReason?: string }).resolveReason = "topshot_gql_error"
    const res = await POST(req({ input: "someone", collection: "laliga-golazos" }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe("username_lookup_unavailable")
    expect(body.error).toMatch(/says nothing about it/)
    expect(body.error).not.toMatch(/spelling/)
    ;(state as { resolveReason?: string }).resolveReason = undefined
  })

  it("resolves a username via the shared resolver, then serves that wallet's wmc rows", async () => {
    state.resolveFound = true
    state.rpc = { data: [{ moments: [moment()], total_count: 1 }], error: null }
    const res = await POST(req({ input: "milito", collection: "laliga-golazos" }))
    const body = await res.json()
    expect(body.walletAddress).toBe("0xc4ab4a06ade1fd0f")
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].momentId).toBe("1006747815")
  })
})

// 2026-10-10: an anonymous search of a wallet with no Golazos rows (any random
// address) re-triggered the Golazos backfill on EVERY call. Durable dedup now.
describe("POST /api/wallet-search — Golazos backfill trigger is deduped", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  it("two searches of the same empty wallet dispatch ONE backfill", async () => {
    process.env.INGEST_SECRET_TOKEN = "t"
    ;(globalThis as any).__rate = {}
    ;(globalThis as any).__rateError = false
    const fetchSpy = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchSpy)
    state.rpc = { data: [{ moments: [], total_count: 0 }], error: null }
    await POST(req({ input: ADDR, collection: "laliga-golazos" }))
    await flush()
    await POST(req({ input: ADDR, collection: "laliga-golazos" }))
    await flush()
    const dispatches = fetchSpy.mock.calls.filter((c: any[]) => String(c[0]).includes("/api/wallet-backfill-golazos"))
    expect(dispatches).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it("an unreadable counter dispatches NOTHING (fail closed)", async () => {
    process.env.INGEST_SECRET_TOKEN = "t"
    ;(globalThis as any).__rateError = true
    const fetchSpy = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchSpy)
    state.rpc = { data: [{ moments: [], total_count: 0 }], error: null }
    await POST(req({ input: "0x00000000000000aa", collection: "laliga-golazos" }))
    await flush()
    expect(fetchSpy.mock.calls.filter((c: any[]) => String(c[0]).includes("/api/wallet-backfill-golazos"))).toHaveLength(0)
    ;(globalThis as any).__rateError = false
    vi.unstubAllGlobals()
  })
})
