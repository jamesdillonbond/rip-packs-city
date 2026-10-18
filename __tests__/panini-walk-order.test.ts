import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildWalkOrder, weightedMerge } from "../scripts/panini-walk-order.mjs"

// The residential Panini runner's walk order (scripts/panini-walk-order.mjs), 2026-09-29.
// WHY: held-but-uncatalogued editions were prepended to the route's `pskus` (the KNOWN list), but
// the runner walks brand-new grid discoveries BEFORE the known list — 1,464–3,900 of them per run
// against ~660 walked — so 0 of 136 held editions were walked. They now arrive as their own
// `priority_pskus` and must be walked FIRST, before any discovery.

describe("buildWalkOrder", () => {
  const known = ["held-1", "k-stale", "k-fresh"]          // route prepends held pskus to `pskus`
  const discovered = ["new-1", "k-fresh", "new-2"]

  it("walks held priority pskus BEFORE brand-new discoveries, each psku once", () => {
    const { pskus, priorityCount, freshCount, orderMode } =
      buildWalkOrder({ priority: ["held-1"], known, knownComplete: true, discovered })
    // Re-pinned 2026-10-02: after the priority list, new and stalest-known alternate 1:1.
    expect(pskus).toEqual(["held-1", "new-1", "k-stale", "new-2", "k-fresh"])
    expect(priorityCount).toBe(1)
    expect(freshCount).toBe(2)
    expect(orderMode).toBe("stalest-first, interleaved (1 held-priority + 2 new + 3 known)")
  })

  it("without priority, new discoveries and the stalest known alternate (2026-10-02)", () => {
    const { pskus, orderMode } = buildWalkOrder({ known, knownComplete: true, discovered })
    expect(pskus).toEqual(["new-1", "held-1", "new-2", "k-stale", "k-fresh"])
    expect(orderMode).toBe("stalest-first, interleaved (2 new + 3 known)")
  })

  it("a flood of new discoveries cannot starve refresh of the known catalogue", () => {
    // 22 products admitted at once put ~4,400 new pskus ahead of the known list at ~600 a run.
    const flood = Array.from({ length: 4400 }, (_, i) => `new-${i}`)
    const cat = Array.from({ length: 12000 }, (_, i) => `known-${i}`)
    const { pskus } = buildWalkOrder({ known: cat, knownComplete: true, discovered: flood })
    const firstRun = pskus.slice(0, 600)
    expect(firstRun.filter((p) => p.startsWith("known-")).length).toBe(300)
    expect(firstRun.filter((p) => p.startsWith("new-")).length).toBe(300)
    // and the known ones are the STALEST (the head of the catalogue list), in order
    expect(firstRun.filter((p) => p.startsWith("known-")).slice(0, 3)).toEqual(["known-0", "known-1", "known-2"])
    expect(new Set(pskus).size).toBe(pskus.length)
    expect(pskus.length).toBe(16400)
  })

  it("a PARTIAL list disables new-first promotion but still walks the explicit priority list first", () => {
    const { pskus, freshCount } = buildWalkOrder({ priority: ["held-1"], known, knownComplete: false, discovered })
    expect(freshCount).toBe(0)
    expect(pskus[0]).toBe("held-1")
    // Absent-from-list is not "new" on a partial list: discoveries fall behind the known list.
    expect(pskus).toEqual(["held-1", "k-stale", "k-fresh", "new-1", "new-2"])
  })

  it("the runner actually uses buildWalkOrder and reads priority_pskus (source-drift guard)", () => {
    const src = readFileSync(join(process.cwd(), "scripts", "ingest-panini-runner.mjs"), "utf8")
    expect(src).toMatch(/import \{ buildWalkOrder \} from "\.\/panini-walk-order\.mjs"/)
    // Re-pinned 2026-10-18: the call now also passes the priced-product weighting (still every
    // original argument, so held-priority / interleave behaviour is unchanged).
    expect(src).toMatch(/buildWalkOrder\(\{\s*priority: priorityPskus, known, knownComplete, discovered,/)
    expect(src).toMatch(/isPriced: \(p\) => setIdOf\(p\) === PRICED_SET_ID/)
    expect(src).toMatch(/const PRICED_SET_ID = 2332;/)
    // 1:1 by default (sized 10-18: WC p50 ~18 h, others ~4 d); 3:1 would push the others to ~8 d.
    expect(src).toMatch(/PANINI_PRICED_PER_OTHER \?\? "1"/)
    expect(src).toMatch(/j\?\.priority_pskus/)
  })
})

// 2026-10-18 — priced products (World Cup Prizm, set 2332) get N of every N+1 KNOWN slots, so the
// only modeled product refreshes faster without starving the other ~30k pskus.
describe("buildWalkOrder — priced-product weighting", () => {
  const wc = (i: number) => `packcard-2332_1_${i}_1`
  const other = (i: number) => `packcard-9999_1_${i}_1`
  const isPriced = (p: string) => p.startsWith("packcard-2332_")
  // stalest-first catalogue where the priced cards are all at the BACK (the 10-18 shape)
  const known = [other(1), other(2), other(3), other(4), other(5), other(6), wc(1), wc(2), wc(3), wc(4), wc(5), wc(6)]

  it("is off by default: the known order is unchanged", () => {
    const r = buildWalkOrder({ known, knownComplete: true })
    expect(r.pskus).toEqual(known)
  })
  it("gives priced cards 3 of every 4 known slots, each group still stalest-first", () => {
    const r = buildWalkOrder({ known, knownComplete: true, isPriced, pricedPerOther: 3 })
    expect(r.pskus.slice(0, 8)).toEqual([wc(1), wc(2), wc(3), other(1), wc(4), wc(5), wc(6), other(2)])
    expect(r.orderMode).toMatch(/priced 3:1 \(6 priced\)/)
  })
  it("never starves the other products: every one of them is still queued, in its own order", () => {
    const r = buildWalkOrder({ known, knownComplete: true, isPriced, pricedPerOther: 3 })
    const others = r.pskus.filter((p) => !isPriced(p))
    expect(others).toEqual([other(1), other(2), other(3), other(4), other(5), other(6)])
    expect(new Set(r.pskus).size).toBe(known.length)
  })
  it("keeps held-priority first and the 1:1 fresh/known interleave", () => {
    const r = buildWalkOrder({ priority: [other(9)], known, knownComplete: true, discovered: [other(7)], isPriced, pricedPerOther: 3 })
    expect(r.pskus.slice(0, 3)).toEqual([other(9), other(7), wc(1)])
  })
  it("ignores a non-positive or non-integer weight", () => {
    for (const w of [0, -1, 1.5]) expect(buildWalkOrder({ known, knownComplete: true, isPriced, pricedPerOther: w }).pskus).toEqual(known)
  })
  it("weightedMerge drains the longer list once the shorter runs out", () => {
    expect(weightedMerge(["a1", "a2"], ["b1", "b2", "b3"], 3)).toEqual(["a1", "a2", "b1", "b2", "b3"])
  })
})
