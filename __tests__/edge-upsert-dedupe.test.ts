import { describe, it, expect } from "vitest"
import { dedupeByConflictKey } from "../supabase/functions/_shared/upsert-dedupe"

// Pins the primitive that unblocked compute-pinnacle-pack-ev.
//
// The failure it prevents is not subtle but it IS total: a single
// `INSERT … ON CONFLICT DO UPDATE` may not touch one target row twice, so ONE
// duplicated upstream id aborts the whole statement (21000) and discards every
// other row in the chunk. That held the function at 100% failure — four
// identical ticks a day from 2026-08-11 06:17Z — with Pinnacle pack EV frozen.
//
// The two properties that matter are (1) the batch becomes upsert-safe, and
// (2) the collision is COUNTED. A dedupe that silently collapsed rows would
// trade a loud deterministic failure for an invisible one.

describe("dedupeByConflictKey", () => {
  const row = (id: string, v: number) => ({ dist_id: id, total: v })
  const byDist = (r: { dist_id: string }) => r.dist_id

  it("leaves a clean batch untouched and reports no duplicates", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3)]
    const out = dedupeByConflictKey(rows, byDist)
    expect(out.rows).toEqual(rows)
    expect(out.duplicates).toBe(0)
    expect(out.duplicateKeys).toEqual([])
  })

  it("collapses rows sharing a conflict key so the batch is upsert-safe", () => {
    const out = dedupeByConflictKey([row("a", 1), row("b", 2), row("a", 9)], byDist)
    // One row per key — the invariant Postgres requires.
    expect(out.rows).toHaveLength(2)
    expect(new Set(out.rows.map(byDist)).size).toBe(out.rows.length)
  })

  it("keeps the LAST occurrence, matching what a sequential upsert would leave", () => {
    const out = dedupeByConflictKey([row("a", 1), row("a", 2), row("a", 3)], byDist)
    expect(out.rows).toEqual([row("a", 3)])
  })

  it("counts every dropped row and samples the colliding keys", () => {
    // 'a' appears 3× (2 dropped), 'b' twice (1 dropped) → 3 dropped, 2 keys.
    const out = dedupeByConflictKey(
      [row("a", 1), row("b", 1), row("a", 2), row("a", 3), row("b", 2)],
      byDist,
    )
    expect(out.duplicates).toBe(3)
    expect(out.rows).toHaveLength(2)
    expect(out.duplicateKeys.sort()).toEqual(["a", "b"])
  })

  it("bounds the sample so a pathological batch cannot flood pipeline_runs.extra", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [row(`k${i}`, 1), row(`k${i}`, 2)]).flat()
    const out = dedupeByConflictKey(rows, byDist, 5)
    expect(out.duplicates).toBe(20)
    expect(out.duplicateKeys).toHaveLength(5)
  })

  it("preserves first-seen key ORDER, so a stable upstream yields a stable batch", () => {
    const out = dedupeByConflictKey([row("b", 1), row("a", 1), row("b", 2)], byDist)
    expect(out.rows.map(byDist)).toEqual(["b", "a"])
  })

  it("treats keys that differ only by type as ONE key, matching Postgres on a text column", () => {
    // dist_id is built with String(node.id), so 7 and "7" must not survive as
    // two rows — Postgres would see one target row and throw 21000.
    const mixed = [{ dist_id: 7 }, { dist_id: "7" }]
    const out = dedupeByConflictKey(mixed, (r) => String(r.dist_id))
    expect(out.rows).toHaveLength(1)
    expect(out.duplicates).toBe(1)
  })

  it("handles an empty batch", () => {
    const out = dedupeByConflictKey([], byDist)
    expect(out.rows).toEqual([])
    expect(out.duplicates).toBe(0)
  })
})
