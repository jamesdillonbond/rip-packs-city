import { describe, it, expect } from "vitest"
import { loadRotatingWindow } from "@/lib/unmapped-rotating-window"

/**
 * The defect this pins (measured live 2026-08-04 on the AllDay >7d tail):
 *
 * Both AllDay unmapped-sales resolvers loaded their rotating candidate window
 * with a single PostgREST `.or(last_onchain_attempt_at.is.null,…lt.<cutoff>)`.
 * The supporting index matched the query exactly, so "the OR is non-sargable"
 * was NOT the mechanism. The mechanism was that the second arm matched NOTHING
 * — the oldest attempt stamp (Jul 27) was NEWER than the reattempt cutoff
 * (Jul 21) — while the first arm returned only 36 rows against a LIMIT of 600.
 * Short of its limit, the scan could not stop: it walked all 32,850 remaining
 * index entries applying a filter that could never match again, and died on
 * `canceling statement due to statement timeout`. Self-perpetuating, too, since
 * each run stamps the rows it probes and keeps arm A tiny.
 *
 * So the load-bearing assertions here are STRUCTURAL: two separately-bounded
 * queries, never a combined `.or()`, with arm B's limit reduced to the
 * remainder and skipped entirely when arm A already fills the window.
 */

type Call = {
  table: string
  columns: string
  eq: Record<string, unknown>
  is: Record<string, unknown>
  gt: Record<string, unknown>
  lt: Record<string, unknown>
  or: string[]
  order: Array<{ col: string; opts: unknown }>
  limit: number | null
}

/** Chainable supabase stub that records the shape of every issued query. */
function makeClient(responses: Array<{ data: any[] | null; error: any }>) {
  const calls: Call[] = []
  let i = 0
  const client = {
    from(table: string) {
      const call: Call = {
        table, columns: "", eq: {}, is: {}, gt: {}, lt: {},
        or: [], order: [], limit: null,
      }
      calls.push(call)
      const q: any = {
        select(c: string) { call.columns = c; return q },
        eq(k: string, v: unknown) { call.eq[k] = v; return q },
        is(k: string, v: unknown) { call.is[k] = v; return q },
        gt(k: string, v: unknown) { call.gt[k] = v; return q },
        lt(k: string, v: unknown) { call.lt[k] = v; return q },
        or(s: string) { call.or.push(s); return q },
        order(col: string, opts: unknown) { call.order.push({ col, opts }); return q },
        limit(n: number) {
          call.limit = n
          return Promise.resolve(responses[i++] ?? { data: [], error: null })
        },
      }
      return q
    },
  }
  return { client, calls }
}

const CUTOFF = "2026-07-21T00:00:00.000Z"
const BASE = {
  collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
  columns: "nft_id, sold_at",
  limit: 600,
  reattemptCutoff: CUTOFF,
}

describe("loadRotatingWindow", () => {
  it("issues TWO bounded arms and never a combined .or() — the timeout fix", async () => {
    const { client, calls } = makeClient([
      { data: [{ nft_id: "a" }], error: null },
      { data: [{ nft_id: "b" }], error: null },
    ])
    const res = await loadRotatingWindow(client, BASE)

    expect(calls).toHaveLength(2)
    // No arm may reintroduce the single-query OR form.
    expect(calls.every((c) => c.or.length === 0)).toBe(true)
    // Arm A selects the never-attempted NULL group; arm B the aged stamps.
    expect(calls[0].is).toMatchObject({ resolved_at: null, last_onchain_attempt_at: null })
    expect(calls[0].lt.last_onchain_attempt_at).toBeUndefined()
    expect(calls[1].lt.last_onchain_attempt_at).toBe(CUTOFF)
    expect(calls[1].is.last_onchain_attempt_at).toBeUndefined()
    // Both arms keep the partial-index predicate so the index still applies.
    expect(calls.every((c) => c.gt.price_usd === 0 && c.is.resolved_at === null)).toBe(true)
    expect(res.data).toEqual([{ nft_id: "a" }, { nft_id: "b" }])
  })

  it("caps arm B at the REMAINDER so the two arms never exceed the window", async () => {
    const { client, calls } = makeClient([
      { data: Array.from({ length: 36 }, (_, n) => ({ nft_id: `a${n}` })), error: null },
      { data: [], error: null },
    ])
    // 36 never-attempted rows is the real measured count for the AllDay tail.
    const res = await loadRotatingWindow(client, BASE)
    expect(calls[0].limit).toBe(600)
    expect(calls[1].limit).toBe(564)
    expect(res.data).toHaveLength(36)
    expect(res.armCounts).toEqual({ never_attempted: 36, reattempt: 0 })
  })

  it("SKIPS arm B entirely when arm A already fills the window", async () => {
    const { client, calls } = makeClient([
      { data: Array.from({ length: 600 }, (_, n) => ({ nft_id: `a${n}` })), error: null },
    ])
    const res = await loadRotatingWindow(client, BASE)
    expect(calls).toHaveLength(1)
    expect(res.data).toHaveLength(600)
    expect(res.armCounts).toEqual({ never_attempted: 600, reattempt: 0 })
  })

  it("preserves the original ordering: NULLs first by sold_at DESC, then oldest attempt first", async () => {
    const { client, calls } = makeClient([
      { data: [{ nft_id: "n1" }], error: null },
      { data: [{ nft_id: "r1" }], error: null },
    ])
    const res = await loadRotatingWindow(client, BASE)
    // ⚠ Arm A MUST name last_onchain_attempt_at first even though every row in
    // it has that column NULL, so the ordering is unaffected. It steers the
    // PLANNER: without the leading key Postgres picks the (collection_id,
    // sold_at DESC) index, which cannot satisfy IS NULL from the index, and
    // filters 75,820 rows away to find 37 — 10,483 ms vs 16 ms. Dropping this
    // key is invisible to output and reintroduces the statement timeout.
    expect(calls[0].order).toEqual([
      { col: "last_onchain_attempt_at", opts: { ascending: true } },
      { col: "sold_at", opts: { ascending: false } },
    ])
    // Arm B continues that ordering: oldest attempt first, sold_at DESC tiebreak.
    expect(calls[1].order).toEqual([
      { col: "last_onchain_attempt_at", opts: { ascending: true } },
      { col: "sold_at", opts: { ascending: false } },
    ])
    // Arm A rows must precede arm B rows in the merged result.
    expect(res.data).toEqual([{ nft_id: "n1" }, { nft_id: "r1" }])
  })

  it("applies soldBefore to BOTH arms when set, and to neither when omitted", async () => {
    const withTail = makeClient([{ data: [], error: null }, { data: [], error: null }])
    await loadRotatingWindow(withTail.client, { ...BASE, soldBefore: "2026-07-28T00:00:00.000Z" })
    expect(withTail.calls.every((c) => c.lt.sold_at === "2026-07-28T00:00:00.000Z")).toBe(true)

    const live = makeClient([{ data: [], error: null }, { data: [], error: null }])
    await loadRotatingWindow(live.client, BASE)
    expect(live.calls.every((c) => c.lt.sold_at === undefined)).toBe(true)
  })

  it("propagates an error from either arm without returning partial data", async () => {
    const a = makeClient([{ data: null, error: { message: "arm A boom" } }])
    const resA = await loadRotatingWindow(a.client, BASE)
    expect(resA.data).toBeNull()
    expect(resA.error?.message).toBe("arm A boom")
    expect(a.calls).toHaveLength(1) // arm B is not attempted after arm A fails

    const b = makeClient([
      { data: [{ nft_id: "a" }], error: null },
      { data: null, error: { message: "arm B boom" } },
    ])
    const resB = await loadRotatingWindow(b.client, BASE)
    expect(resB.data).toBeNull()
    expect(resB.error?.message).toBe("arm B boom")
  })

  it("never turns a non-positive or non-finite limit into an unbounded read", async () => {
    for (const limit of [0, -5, NaN]) {
      const { client, calls } = makeClient([])
      const res = await loadRotatingWindow(client, { ...BASE, limit })
      expect(calls).toHaveLength(0)
      expect(res.data).toEqual([])
    }
  })
})
