import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import stripComments from "../scripts/lib/strip-comments.mjs"

// The thin-parallel value ESTIMATE (public.edition_fmv_estimates, 2026-09-30) is
// a labelled guide, NOT an FMV. Accuracy is the gate (roadmap 2026-08-03): it
// must not reach portfolio totals, deal / sniper / squeeze boards, alerts or the
// HIGH/MEDIUM share. The structural guarantee is that exactly ONE module reads
// it — lib/fmv/edition-estimate.ts — whose consumers state its basis every time.
// A new reader must go through that module, not the table.
//
// Tree walk over the app code roots (not a curated list), comments stripped so a
// comment naming the table does not count.

const ROOTS = ["app", "lib", "components", "scripts", "workers", "supabase/functions"]
const SKIP = new Set(["node_modules", ".next", ".claude"])
const THE_READER = "lib/fmv/edition-estimate.ts"

function walk(dir: string, out: string[]) {
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    if (SKIP.has(n)) continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p)
  }
}

describe("edition_fmv_estimates has exactly one reader", () => {
  const files: string[] = []
  for (const r of ROOTS) walk(r, files)

  it("walked the tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain(THE_READER)
  })

  it("only lib/fmv/edition-estimate.ts names the table in code", () => {
    const hits = files.filter((f) => stripComments(readFileSync(f, "utf8")).includes("edition_fmv_estimates"))
    expect(hits).toEqual([THE_READER])
  })
})
