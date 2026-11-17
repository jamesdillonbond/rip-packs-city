import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PANINI_FMV_SOURCE_NOTE } from "@/lib/panini/fmv-source-note"

// 2026-11-09 (signup-wave remediation P1): every Panini FMV surface says its
// prices come only from sales on Panini's own platform. One constant, rendered
// by each surface — pinned here so a surface cannot silently drop it.

const SURFACES = [
  "components/collection/PaniniCollection.tsx",
  "components/collection/PaniniSniper.tsx",
]

describe("Panini FMV on-platform disclosure", () => {
  it("states the scope and the lag, and carries no confidence tier (internal, concierge rule 3)", () => {
    expect(PANINI_FMV_SOURCE_NOTE).toMatch(/comes only from sales on Panini's own platform/)
    expect(PANINI_FMV_SOURCE_NOTE).toMatch(/anywhere else aren't counted/)
    expect(PANINI_FMV_SOURCE_NOTE).toMatch(/few days/)
    expect(PANINI_FMV_SOURCE_NOTE).not.toMatch(/\b(HIGH|MEDIUM|LOW|confidence)\b/i)
  })

  it.each(SURFACES)("%s renders the shared note", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8")
    expect(src).toContain('from "@/lib/panini/fmv-source-note"')
    // rendered, not merely imported
    expect(src.match(/\{\s*`?\s*\$?\{?\s*PANINI_FMV_SOURCE_NOTE|PANINI_FMV_SOURCE_NOTE\s*\}/g)?.length ?? 0).toBeGreaterThan(0)
  })

  it("the Collection tab renders it on BOTH the profile and the seen-cards branch", () => {
    const src = readFileSync(join(process.cwd(), "components/collection/PaniniCollection.tsx"), "utf8")
    expect(src.split("PANINI_FMV_SOURCE_NOTE").length - 1).toBe(3) // 1 import + 2 renders
  })
})
