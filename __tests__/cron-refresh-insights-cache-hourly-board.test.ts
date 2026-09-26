import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * panini-boards is warmed HOURLY, not every 5-minute tick (its four views cost
 * ~270k buffers per warm). Pinned both ways: a fresh snapshot is skipped, a due
 * or UNKNOWN-age one is warmed (never skip on missing evidence), and the reader's
 * freshness window covers the interval so a healthy hourly board is never "stale".
 */

const { state, upserts, rpcCalls, ok, paniniBoards } = vi.hoisted(() => {
  const ok = async () => ({ payload: { x: 1 }, ok: true, rowCount: 1 })
  return {
    state: { ages: [] as Array<{ board_key: string; refreshed_at: string }> | null },
    upserts: [] as any[],
    rpcCalls: [] as any[],
    ok,
    paniniBoards: vi.fn(ok),
  }
})

vi.mock("@/lib/supabase", () => {
  const admin: any = {
    from: () => admin,
    select: () => ({
      then: (resolve: any) => resolve(state.ages === null ? { data: null, error: { message: "boom" } } : { data: state.ages, error: null }),
      eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
    }),
    upsert: async (row: any) => {
      upserts.push(row)
      return { data: null, error: null }
    },
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args })
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

vi.mock("@/lib/insights/boards", () => ({ fetchDealsDefault: ok, fetchRookiesDefault: ok, fetchFirstMintDefault: ok }))
vi.mock("@/lib/insights/candy-board", () => ({ fetchCandyMlbDefault: ok }))
vi.mock("@/lib/insights/panini-board", () => ({ fetchPaniniSqueezeDefault: ok }))
vi.mock("@/lib/insights/panini-more-boards", () => ({ fetchPaniniMoreBoards: () => paniniBoards() }))

import { POST } from "@/app/api/cron/refresh-insights-cache/route"
import { freshMsFor, BOARD_CACHE_FRESH_MS, WARM_BOARDS } from "@/lib/insights/board-cache"

const req = () => ({ headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer t" : null) } }) as any
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "t"
  upserts.length = 0
  rpcCalls.length = 0
  paniniBoards.mockClear()
})

describe("the hourly panini-boards warm", () => {
  it("is SKIPPED while its snapshot is younger than the interval", async () => {
    state.ages = [{ board_key: "panini-boards", refreshed_at: minsAgo(20) }]
    const body = await (await POST(req())).json()
    expect(paniniBoards).not.toHaveBeenCalled()
    expect(upserts.map((u) => u.board_key)).not.toContain("panini-boards")
    expect(rpcCalls[0].args.p_extra.skipped_not_due).toEqual(["panini-boards"])
    // The other boards still warm every tick.
    expect(body.warmed).toBe(5)
  })

  it("is WARMED once the interval has passed", async () => {
    state.ages = [{ board_key: "panini-boards", refreshed_at: minsAgo(59) }]
    await POST(req())
    expect(paniniBoards).toHaveBeenCalledTimes(1)
    expect(upserts.map((u) => u.board_key)).toContain("panini-boards")
  })

  it("is WARMED when its age is UNKNOWN — never skipped on missing evidence", async () => {
    state.ages = null
    await POST(req())
    expect(paniniBoards).toHaveBeenCalledTimes(1)
  })

  it("the reader's freshness window covers the interval; every other board keeps the 10-minute window", () => {
    const every = WARM_BOARDS.find((b) => b.key === "panini-boards")?.warmEveryMs ?? 0
    expect(every).toBeGreaterThan(0)
    expect(freshMsFor("panini-boards")).toBeGreaterThan(every)
    for (const b of WARM_BOARDS.filter((w) => !w.warmEveryMs)) {
      expect(freshMsFor(b.key)).toBe(BOARD_CACHE_FRESH_MS)
    }
  })
})
