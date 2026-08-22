import { describe, it, expect, beforeEach, vi } from "vitest"

import { WARM_BOARDS, WARM_BOARDS_PER_TICK } from "@/lib/insights/board-cache"

/**
 * `ageMinutes` drives what `readBoardSnapshotAges()` sees, which is what the tick's
 * ROTATION selects on. Before 2026-08-22 the route warmed every board every tick, so
 * the mock never needed to model snapshot ages at all and `select()` could return a
 * non-thenable — that is why this file had no rotation coverage to begin with.
 */
const rec: {
  upserts: any[]
  rpcCalls: any[]
  ageMinutes: Record<string, number | null>
} = { upserts: [], rpcCalls: [], ageMinutes: {} }

vi.mock("@/lib/supabase", () => {
  // `.select()` is awaited directly by readBoardSnapshotAges and chained by
  // readBoardSnapshot, so it must be BOTH thenable and chainable.
  const chain: any = {
    eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: any) =>
      resolve({
        data: Object.entries(rec.ageMinutes)
          .filter(([, min]) => min != null)
          .map(([board_key, min]) => ({
            board_key,
            refreshed_at: new Date(Date.now() - (min as number) * 60_000).toISOString(),
          })),
        error: null,
      }),
  }
  const admin: any = {
    from: () => admin,
    select: () => chain,
    upsert: async (row: any) => {
      rec.upserts.push(row)
      return { data: null, error: null }
    },
    rpc: async (name: string, args: any) => {
      rec.rpcCalls.push({ name, args })
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

// The builders are exercised on their own in lib-insights-boards.test.ts; here we
// stub them so the cron test drives warm/log behavior deterministically.
vi.mock("@/lib/insights/boards", () => ({
  fetchDealsDefault: vi.fn(async () => ({ payload: { rows: [{ id: 1 }] }, ok: true, rowCount: 1 })),
  fetchRookiesDefault: vi.fn(async () => ({ payload: { rows: [] }, ok: true, rowCount: 0 })),
  fetchFirstMintDefault: vi.fn(async () => ({
    payload: { trophies: [] },
    ok: false,
    rowCount: 0,
    error: "topshot_first_mint_trophies: canceling statement due to statement timeout",
  })),
}))

vi.mock("@/lib/insights/candy-board", () => ({
  fetchCandyMlbDefault: vi.fn(async () => ({ payload: { initialRows: [{ id: 1 }] }, ok: true, rowCount: 1 })),
}))

vi.mock("@/lib/insights/panini-board", () => ({
  fetchPaniniSqueezeDefault: vi.fn(async () => ({ payload: { initialRows: [{ id: 2 }] }, ok: true, rowCount: 1 })),
}))

import { POST, GET } from "@/app/api/cron/refresh-insights-cache/route"

const req = (auth?: string) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
  }) as any

/** Every board equally fresh, so selection falls back to a deterministic order. */
const allFresh = (min = 5) =>
  Object.fromEntries(WARM_BOARDS.map(({ key }) => [key, min])) as Record<string, number>

beforeEach(() => {
  rec.upserts = []
  rec.rpcCalls = []
  rec.ageMinutes = allFresh()
  process.env.INGEST_SECRET_TOKEN = "test-token"
  process.env.CRON_SECRET = "cron-token"
})

describe("POST /api/cron/refresh-insights-cache", () => {
  it("401s without the ingest bearer", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(rec.upserts).toHaveLength(0)
    expect(rec.rpcCalls).toHaveLength(0)
  })

  it("401s with a wrong bearer (matches neither secret)", async () => {
    const res = await POST(req("Bearer nope"))
    expect(res.status).toBe(401)
  })

  it("accepts the Vercel-cron CRON_SECRET bearer", async () => {
    const res = await POST(req("Bearer cron-token"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.pipeline).toBe("refresh-insights-cache")
  })

  // ── ROTATION (2026-08-22) ──────────────────────────────────────────────────
  // INVERTED, not deleted. This test used to assert `warmed === 4 / total === 5`,
  // i.e. that a tick ran EVERY board. That contract is what made the tick the
  // largest avoidable load on a 2-core instance and, measured, the reason its own
  // queries were killed at the service_role 30s wall (57-76% of warms). The
  // assertion is kept pointing the other way so nobody restores the old loop
  // without a red test.
  it("warms at most WARM_BOARDS_PER_TICK boards, not the whole watchlist", async () => {
    const res = await POST(req("Bearer test-token"))
    const body = await res.json()
    expect(body.total).toBe(WARM_BOARDS_PER_TICK)
    expect(body.total).toBeLessThan(WARM_BOARDS.length)
    expect(rec.upserts.length).toBeLessThanOrEqual(WARM_BOARDS_PER_TICK)
  })

  it("accounts for every board — warmed plus skipped is the whole watchlist", async () => {
    // A partial tick must never be readable as a coverage collapse. Without this,
    // dropping a board from BOTH lists would look identical in the log to it having
    // been warmed, and `warmed`/`total` alone cannot tell the two apart.
    await POST(req("Bearer test-token"))
    const extra = rec.rpcCalls[0].args.p_extra
    expect(extra.rotation.per_tick).toBe(WARM_BOARDS_PER_TICK)
    expect(
      [...extra.rotation.warmed_keys, ...extra.rotation.skipped_keys].sort()
    ).toEqual(WARM_BOARDS.map((b) => b.key).sort())
  })

  it("selects the STALEST boards, and carries a failing board's reason into p_error", async () => {
    // first-mint is the stub that reports ok:false. Make it the stalest so rotation
    // must pick it — otherwise this test would pass for the wrong reason on any tick
    // where the healthy boards happened to be selected.
    rec.ageMinutes = { ...allFresh(1), "first-mint": 90, deals: 60 }
    const res = await POST(req("Bearer test-token"))
    const body = await res.json()

    expect(body.boards.map((b: any) => b.key).sort()).toEqual(["deals", "first-mint"])
    // deals warms, first-mint does not — a partial tick is still ok (>=1 warmed and
    // nothing past the staleness ceiling), with the failure recorded rather than hidden.
    expect(rec.upserts.map((u) => u.board_key)).toEqual(["deals"])
    expect(body.warmed).toBe(1)
    expect(body.ok).toBe(true)
    expect(rec.rpcCalls[0].args.p_error).toContain("first-mint")
    // The REASON, not just the key — the whole point of the 2026-08-12 error carry.
    expect(rec.rpcCalls[0].args.p_error).toContain("statement timeout")
    expect(rec.rpcCalls[0].args.p_rows_written).toBe(1)
  })

  it("a never-warmed board outranks a merely old one", async () => {
    // stalestBoards() will not call a null age stale, so if rotation also passed over
    // it, a board with no snapshot row would never be warmed by anything at all.
    rec.ageMinutes = { ...allFresh(1), rookies: null, deals: 119 }
    await POST(req("Bearer test-token"))
    expect(rec.rpcCalls[0].args.p_extra.rotation.warmed_keys).toContain("rookies")
  })

  it("reports ok:false when a board has aged past the staleness ceiling", async () => {
    // The cumulative honesty check must survive rotation: it reads ALL boards after
    // the warm, not just the ones this tick selected.
    rec.ageMinutes = { ...allFresh(1), "candy-mlb": 200 }
    const res = await POST(req("Bearer test-token"))
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.stale_boards.map((s: any) => s.key)).toContain("candy-mlb")
    expect(rec.rpcCalls[0].args.p_error).toContain("STALE candy-mlb")
  })

  it("GET works the same as POST (both auth-gated)", async () => {
    const res = await GET(req("Bearer test-token"))
    const body = await res.json()
    expect(body.pipeline).toBe("refresh-insights-cache")
  })
})
