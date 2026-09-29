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
    expect(pskus).toEqual(["held-1", "new-1", "new-2", "k-stale", "k-fresh"])
    expect(priorityCount).toBe(1)
    expect(freshCount).toBe(2)
    expect(orderMode).toBe("stalest-first (1 held-priority + 2 new + 3 known)")
  })

  it("without priority the order is exactly the pre-2026-09-29 one (new first, then stalest known)", () => {
    const { pskus, orderMode } = buildWalkOrder({ known, knownComplete: true, discovered })
    expect(pskus).toEqual(["new-1", "new-2", "held-1", "k-stale", "k-fresh"])
    expect(orderMode).toBe("stalest-first (2 new + 3 known)")
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
