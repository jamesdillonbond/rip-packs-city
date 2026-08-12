import { describe, it, expect, beforeEach, vi } from "vitest"

// Controllable supabaseAdmin mock: `state` drives what the snapshot read returns and
// records upserts, so we can exercise the fresh / live / stale / degraded ladder.
const state: {
  read: { data: any; error: any } | null
  throwOnRead: boolean
  throwOnUpsert: boolean
  upserts: any[]
} = { read: null, throwOnRead: false, throwOnUpsert: false, upserts: [] }

vi.mock("@/lib/supabase", () => {
  const admin: any = {
    from: () => admin,
    select: () => admin,
    eq: () => admin,
    maybeSingle: async () => {
      if (state.throwOnRead) throw new Error("read boom")
      return state.read ?? { data: null, error: null }
    },
    upsert: async (row: any) => {
      if (state.throwOnUpsert) throw new Error("upsert boom")
      state.upserts.push(row)
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import {
  readBoardOrLive,
  warmBoard,
  withCacheMeta,
  BOARD_CACHE_FRESH_MS,
} from "@/lib/insights/board-cache"

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()

function snapshotRow(ageMs: number, payload: any = { rows: [{ id: 1 }] }) {
  return { data: { payload, refreshed_at: isoAgo(ageMs) }, error: null }
}

const liveOk = (payload: any = { rows: [{ id: 9 }] }, rowCount = 1) =>
  vi.fn(async () => ({ payload, ok: true, rowCount }))

beforeEach(() => {
  state.read = null
  state.throwOnRead = false
  state.throwOnUpsert = false
  state.upserts = []
})

describe("withCacheMeta", () => {
  it("stamps cache provenance without mutating the input", () => {
    const input = { rows: [1], meta: { fetched_at: "x" } }
    const out = withCacheMeta(input, { ageMs: 1234, stale: false, refreshedAt: "t" })
    expect((out.meta as any).served_from_cache).toBe(true)
    expect((out.meta as any).cache_age_ms).toBe(1234)
    expect((out.meta as any).cache_stale).toBe(false)
    expect((out.meta as any).fetched_at).toBe("x") // preserved
    expect((input as any).meta.served_from_cache).toBeUndefined() // not mutated
  })

  it("creates a meta object when the payload has none", () => {
    const out = withCacheMeta({ rows: [] }, { ageMs: 0, stale: true, refreshedAt: "t" })
    expect((out.meta as any).cache_stale).toBe(true)
  })
})

describe("readBoardOrLive", () => {
  it("serves a FRESH snapshot without calling live", async () => {
    state.read = snapshotRow(1000, { rows: [{ id: 42 }] })
    const live = liveOk()
    const { payload, source } = await readBoardOrLive("deals", live)
    expect(source).toBe("fresh-cache")
    expect((payload as any).rows[0].id).toBe(42)
    expect((payload as any).meta.served_from_cache).toBe(true)
    expect(live).not.toHaveBeenCalled()
    expect(state.upserts).toHaveLength(0) // consumers never write
  })

  it("runs live when no snapshot exists and does NOT write", async () => {
    state.read = { data: null, error: null }
    const live = liveOk({ rows: [{ id: 7 }] })
    const { payload, source } = await readBoardOrLive("deals", live)
    expect(source).toBe("live")
    expect((payload as any).rows[0].id).toBe(7)
    expect(live).toHaveBeenCalledOnce()
    expect(state.upserts).toHaveLength(0)
  })

  it("prefers a fresh LIVE result over a STALE snapshot", async () => {
    state.read = snapshotRow(BOARD_CACHE_FRESH_MS + 60_000, { rows: [{ id: 1 }] })
    const live = liveOk({ rows: [{ id: 2 }] })
    const { payload, source } = await readBoardOrLive("deals", live)
    expect(source).toBe("live")
    expect((payload as any).rows[0].id).toBe(2)
  })

  it("falls back to a STALE snapshot when the live query is not ok", async () => {
    state.read = snapshotRow(BOARD_CACHE_FRESH_MS + 60_000, { rows: [{ id: 5 }] })
    const live = vi.fn(async () => ({ payload: { rows: [] }, ok: false, rowCount: 0 }))
    const { payload, source } = await readBoardOrLive("deals", live)
    expect(source).toBe("stale-cache")
    expect((payload as any).rows[0].id).toBe(5)
    expect((payload as any).meta.cache_stale).toBe(true)
  })

  it("falls back to a stale snapshot when the live query THROWS", async () => {
    state.read = snapshotRow(BOARD_CACHE_FRESH_MS + 1, { rows: [{ id: 8 }] })
    const live = vi.fn(async () => {
      throw new Error("db down")
    })
    const { payload, source } = await readBoardOrLive("rookies", live)
    expect(source).toBe("stale-cache")
    expect((payload as any).rows[0].id).toBe(8)
  })

  it("returns the (empty) live payload when nothing is cached and live is not ok", async () => {
    state.read = { data: null, error: null }
    const live = vi.fn(async () => ({ payload: { rows: [] }, ok: false, rowCount: 0 }))
    const { payload, source } = await readBoardOrLive("first-mint", live)
    expect(source).toBe("live-degraded")
    expect((payload as any).rows).toEqual([])
  })

  it("is fail-open: a snapshot READ error is treated as no snapshot, live still serves", async () => {
    state.throwOnRead = true
    const live = liveOk({ rows: [{ id: 3 }] })
    const { payload, source } = await readBoardOrLive("deals", live)
    expect(source).toBe("live")
    expect((payload as any).rows[0].id).toBe(3)
  })
})

describe("warmBoard", () => {
  it("writes the snapshot when the live query is ok", async () => {
    const live = liveOk({ rows: [{ id: 1 }, { id: 2 }] }, 2)
    const res = await warmBoard("deals", live)
    expect(res.ok).toBe(true)
    expect(res.rowCount).toBe(2)
    expect(state.upserts).toHaveLength(1)
    expect(state.upserts[0].board_key).toBe("deals")
    expect(state.upserts[0].row_count).toBe(2)
  })

  it("does NOT write when the live query is not ok", async () => {
    const live = vi.fn(async () => ({ payload: { rows: [] }, ok: false, rowCount: 0 }))
    const res = await warmBoard("rookies", live)
    expect(res.ok).toBe(false)
    expect(state.upserts).toHaveLength(0)
  })

  // The ok:false path is the COMMON one — these fetchers report a PostgrestError as
  // `ok: !error` rather than throwing — and until 2026-08-12 it dropped the reason,
  // so pipeline_runs recorded 68 failures of `deals`/`first-mint` with no cause at
  // all. Carrying `error` through is the whole point of that change.
  it("carries the fetcher's reason through on the ok:false path", async () => {
    const live = vi.fn(async () => ({
      payload: { rows: [] },
      ok: false,
      rowCount: 0,
      error: "topshot_first_mint_trophy_stats: canceling statement due to statement timeout",
    }))
    const res = await warmBoard("first-mint", live)
    expect(res.ok).toBe(false)
    expect(res.error).toBe(
      "topshot_first_mint_trophy_stats: canceling statement due to statement timeout"
    )
    expect(state.upserts).toHaveLength(0)
  })

  it("still reports a THROWN error, and does not invent one on success", async () => {
    const threw = await warmBoard("deals", vi.fn(async () => {
      throw new Error("socket hang up")
    }))
    expect(threw.ok).toBe(false)
    expect(threw.error).toBe("socket hang up")

    const fine = await warmBoard("deals", liveOk())
    expect(fine.ok).toBe(true)
    expect(fine.error).toBeUndefined()
  })

  it("reports an error and does not write when the live query throws", async () => {
    const live = vi.fn(async () => {
      throw new Error("kaboom")
    })
    const res = await warmBoard("first-mint", live)
    expect(res.ok).toBe(false)
    expect(res.error).toContain("kaboom")
    expect(state.upserts).toHaveLength(0)
  })

  it("is fail-open: a write error still resolves ok (best-effort)", async () => {
    state.throwOnUpsert = true
    const live = liveOk()
    const res = await warmBoard("deals", live)
    expect(res.ok).toBe(true) // write swallowed, warm still reports success
  })
})
