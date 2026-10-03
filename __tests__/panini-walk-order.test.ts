import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildWalkOrder } from "../scripts/panini-walk-order.mjs"

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
    expect(src).toMatch(/buildWalkOrder\(\{ priority: priorityPskus, known, knownComplete, discovered \}\)/)
    expect(src).toMatch(/j\?\.priority_pskus/)
  })
})
