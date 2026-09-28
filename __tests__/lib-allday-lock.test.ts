import { describe, it, expect, vi, beforeEach } from "vitest"
import { refreshAllDayWalletLocks, AllDayLockDeadlineError } from "@/lib/allday-lock"

// Unit test for the All Day on-chain lock diff. Locked All Day moments leave the
// wallet's on-chain collection, so anything cached but NOT returned on-chain is
// locked. We mock Flow REST and a chainable Supabase stub that PAGES like
// PostgREST (a limit, and a hard 1,000-row cap).

// Encode a Cadence [UInt64] result the way Flow REST returns it: a
// quote-wrapped base64 of the JSON-CDC envelope.
function flowRestBody(ids: string[]): string {
  const envelope = { type: "Array", value: ids.map((id) => ({ type: "UInt64", value: id })) }
  const b64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64")
  return JSON.stringify(b64) // adds the surrounding quotes the helper strips
}

const POSTGREST_CAP = 1000

type Row = { moment_id: string; is_locked: boolean | null }

// A stub that honours .gt / .order / .limit and the 1,000-row cap on reads, and
// records every update with the ids it targeted. `failUpdates` makes the Nth
// update call (0-based) return an error.
function makeSupabase(cacheRows: Row[], opts: { failUpdates?: number[] } = {}) {
  const updates: Array<{ payload: Record<string, unknown>; ids: string[] }> = []
  let updateCalls = 0
  let reads = 0
  function builder() {
    const st: { kind: "select" | "update"; payload?: Record<string, unknown>; gt?: string; limit?: number; ids?: string[] } = { kind: "select" }
    const b: any = {
      select: () => b,
      update: (payload: Record<string, unknown>) => { st.kind = "update"; st.payload = payload; return b },
      eq: () => b,
      gt: (_c: string, v: string) => { st.gt = v; return b },
      order: () => b,
      limit: (n: number) => { st.limit = n; return b },
      in: (_c: string, ids: string[]) => { st.ids = ids; return b },
      then: (resolve: any) => {
        if (st.kind === "update") {
          const n = updateCalls++
          if (opts.failUpdates?.includes(n)) return resolve({ data: null, error: { message: "boom" } })
          updates.push({ payload: st.payload!, ids: st.ids ?? [] })
          return resolve({ data: null, error: null })
        }
        reads++
        const sorted = [...cacheRows].sort((a, b2) => (a.moment_id < b2.moment_id ? -1 : a.moment_id > b2.moment_id ? 1 : 0))
        const after = st.gt
        const rest = after === undefined ? sorted : sorted.filter((r) => r.moment_id > after)
        const cap = Math.min(st.limit ?? Infinity, POSTGREST_CAP)
        return resolve({ data: rest.slice(0, cap), error: null })
      },
    }
    return b
  }
  const sb: any = { from: () => builder(), _updates: updates, reads: () => reads }
  return sb
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("refreshAllDayWalletLocks", () => {
  it("marks cached-but-not-on-chain moments as locked and stamps every row", async () => {
    // On-chain (unlocked) returns only m1; m2 is cached but absent → locked.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(flowRestBody(["m1"]), { status: 200 }))
    )
    const sb = makeSupabase([
      { moment_id: "m1", is_locked: false },
      { moment_id: "m2", is_locked: false },
    ])

    const r = await refreshAllDayWalletLocks("0xabc", sb)

    expect(r.total_cached).toBe(2)
    expect(r.unlocked_onchain).toBe(1)
    expect(r.marked_locked).toBe(1) // m2
    expect(r.marked_unlocked).toBe(0)
    expect(r.rows_stamped).toBe(2)
    expect(r.write_errors).toBe(0)
    // A lock flip write + the freshness stamp both carry lock_checked_at.
    expect(sb._updates.some((u: any) => u.payload.is_locked === true && u.payload.lock_checked_at)).toBe(true)
    expect(sb._updates.some((u: any) => u.payload.lock_checked_at && u.payload.is_locked === undefined)).toBe(true)
  })

  it("unlocks a stale-locked moment that is back on-chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(flowRestBody(["m1"]), { status: 200 }))
    )
    const sb = makeSupabase([{ moment_id: "m1", is_locked: true }])
    const r = await refreshAllDayWalletLocks("0xabc", sb)
    expect(r.marked_unlocked).toBe(1)
    expect(r.marked_locked).toBe(0)
  })

  // 2026-09-28: an unpaged read stopped at PostgREST's 1,000 rows, so a whale
  // had an arbitrary 1,000 examined per walk and stayed stalest forever.
  it("examines and stamps EVERY cached row of a wallet above the 1,000-row cap", async () => {
    const rows: Row[] = Array.from({ length: 2_450 }, (_, i) => ({ moment_id: `m${String(i).padStart(5, "0")}`, is_locked: false }))
    const onchain = rows.filter((_, i) => i % 10 !== 0).map((r) => r.moment_id) // every 10th is locked
    vi.stubGlobal("fetch", vi.fn(async () => new Response(flowRestBody(onchain), { status: 200 })))
    const sb = makeSupabase(rows)

    const r = await refreshAllDayWalletLocks("0xabc", sb)

    expect(r.total_cached).toBe(2_450)
    expect(r.marked_locked).toBe(245)
    expect(r.rows_stamped).toBe(2_450)
    const stamped = new Set(sb._updates.flatMap((u: any) => u.ids))
    expect(stamped.size).toBe(2_450)
    expect(sb.reads()).toBeGreaterThan(2) // it paged
  })

  it("reads the on-chain set in large IDs-only windows, not 1,000-id detail windows", async () => {
    const ids = Array.from({ length: 45_053 }, (_, i) => String(i))
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const args = JSON.parse(init.body).arguments.map((a: string) => JSON.parse(Buffer.from(a, "base64").toString()))
      const start = Number(args[1].value)
      const count = Number(args[2].value)
      return new Response(flowRestBody(ids.slice(start, start + count)), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const r = await refreshAllDayWalletLocks("0xabc", makeSupabase([]))
    expect(r.unlocked_onchain).toBe(45_053)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
    const script = Buffer.from(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).script, "base64").toString()
    expect(script).not.toMatch(/borrowNFT/)
  })

  it("a failed write is counted as a failure, never as a stamped row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(flowRestBody(["m1", "m2"]), { status: 200 })))
    const sb = makeSupabase([
      { moment_id: "m1", is_locked: false },
      { moment_id: "m2", is_locked: false },
    ], { failUpdates: [0] })
    const r = await refreshAllDayWalletLocks("0xabc", sb)
    expect(r.write_errors).toBe(1)
    expect(r.rows_stamped).toBe(0)
    expect(r.first_write_error).toBe("boom")
  })

  it("a failed flip write is not reported as a flip", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(flowRestBody([]), { status: 200 })))
    const sb = makeSupabase([{ moment_id: "m1", is_locked: false }], { failUpdates: [0] })
    const r = await refreshAllDayWalletLocks("0xabc", sb)
    expect(r.marked_locked).toBe(0)
    expect(r.write_errors).toBe(1)
  })

  it("does not start a walk past the deadline, and writes nothing", async () => {
    const fetchMock = vi.fn(async () => new Response(flowRestBody(["m1"]), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const sb = makeSupabase([{ moment_id: "m1", is_locked: false }])
    await expect(refreshAllDayWalletLocks("0xabc", sb, { deadlineMs: Date.now() - 1 })).rejects.toBeInstanceOf(AllDayLockDeadlineError)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sb._updates).toHaveLength(0)
  })
})
