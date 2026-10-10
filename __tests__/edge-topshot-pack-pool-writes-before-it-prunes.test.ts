import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// compute-topshot-pack-ev used to DELETE a distribution's pack_drop_pool (error
// unread) and THEN insert, so a failed insert chunk — or a fetch that resolved
// no editions — left the pack with no pool and no odds (2026-10-10 audit). The
// AllDay / Golazos twins already write first and prune stale rows after. This
// pins the same order for Top Shot.

const src = stripComments(readFileSync("supabase/functions/compute-topshot-pack-ev/index.ts", "utf8"))
const start = src.indexOf('.from("pack_drop_pool")')
const block = src.slice(start - 2000, start + 2500)

describe("compute-topshot-pack-ev — pack_drop_pool is written before it is pruned", () => {
  it("finds the pool write (not vacuous)", () => {
    expect(start).toBeGreaterThan(-1)
  })

  it("upserts on the PK before any delete, and never inserts-after-delete", () => {
    const up = block.indexOf(".upsert(chunk")
    const del = block.indexOf(".delete()")
    expect(up).toBeGreaterThan(-1)
    expect(del).toBeGreaterThan(up)
    expect(block).toMatch(/onConflict:\s*"collection_id,dist_id,edition_id,slot_name"/)
    expect(block).not.toMatch(/\.insert\(chunk\)/)
  })

  it("the prune removes only rows this run did not refresh, and only after a clean write", () => {
    const del = block.indexOf(".delete()")
    expect(block.slice(del, del + 300)).toMatch(/\.lt\("last_refreshed_at", nowIso\)/)
    expect(block.slice(0, del)).toMatch(/if \(!poolWriteFailed && !postSeedResolveFailed\)/)
  })

  it("an empty row set returns before touching the pool", () => {
    const empty = block.indexOf("if (poolRows.length === 0) continue")
    expect(empty).toBeGreaterThan(-1)
    expect(empty).toBeLessThan(block.indexOf(".upsert(chunk"))
  })
})
