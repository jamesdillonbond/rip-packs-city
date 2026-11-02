import { describe, it, expect } from "vitest"
import { asOfObservedFloors, observedOpensAsOf } from "@/lib/pack-dist/observed-as-of"
import { atlasTierCounts } from "@/lib/pack-dist/tier-counts"

// The Atlas floor is opens observed UP TO the payload's stamp. Live numbers
// (11-02): dist 8905 Atlas opened 915, all-time observed 929 → refuted; observed
// as of its own stamp 924 → still refuted (a genuine ~1% contradiction). A dist
// opened 701 with all-time 705 but 700 by its stamp → admitted (lag, not lie).

function fakeDb(counts: Record<string, number | "err">) {
  const calls: Array<{ dist: string; lte: string }> = []
  const db = {
    from: (t: string) => {
      expect(t).toBe("pack_rips")
      const q: any = { dist: "", lte: "" }
      const b: any = {
        select: () => b,
        eq: (k: string, v: string) => { if (k === "dist_id") q.dist = v; return b },
        lte: (_k: string, v: string) => { q.lte = v; return b },
        then: (resolve: any) => {
          calls.push({ dist: q.dist, lte: q.lte })
          const c = counts[q.dist]
          return resolve(c === "err" ? { count: null, error: { message: "boom" } } : { count: c, error: null })
        },
      }
      return b
    },
  }
  return { db, calls }
}
const row = (dist_id: string, total: number, unopened: number) => ({ dist_id, summary_fetched_at: "2026-11-02T02:33:00Z", total_pack_count: total, unopened_count: unopened })

describe("asOfObservedFloors", () => {
  it("re-reads ONLY rows the all-time count refutes, at the row's own stamp", async () => {
    const { db, calls } = fakeDb({ lag: 700, lie: 924 })
    const out = await asOfObservedFloors(db, [row("ok", 719, 18), row("lag", 719, 18), row("lie", 1500, 585)], new Map<string, number>([["ok", 701], ["lag", 705], ["lie", 929]]))
    expect(calls).toEqual([{ dist: "lag", lte: "2026-11-02T02:33:00Z" }, { dist: "lie", lte: "2026-11-02T02:33:00Z" }])
    expect(out.get("ok")).toBe(701)
    expect(out.get("lag")).toBe(700)
    expect(out.get("lie")).toBe(924)
    // and the floor then admits the lag row, still refutes the genuine one
    const payload = (r: any) => ({ ...r, remaining_by_tier: { legendary: 1 }, original_by_tier: { legendary: 3 } })
    expect(atlasTierCounts(payload(row("lag", 719, 18)), out.get("lag"))).not.toBeNull()
    expect(atlasTierCounts(payload(row("lie", 1500, 585)), out.get("lie"))).toBeNull()
  })
  it("a failed as-of read keeps the all-time count (unknown never admits)", async () => {
    const { db } = fakeDb({ lag: "err" })
    const out = await asOfObservedFloors(db, [row("lag", 719, 18)], new Map([["lag", 705]]))
    expect(out.get("lag")).toBe(705)
  })
  it("observedOpensAsOf refuses a missing stamp without a read", async () => {
    const { db, calls } = fakeDb({})
    expect(await observedOpensAsOf(db, "x", null)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
