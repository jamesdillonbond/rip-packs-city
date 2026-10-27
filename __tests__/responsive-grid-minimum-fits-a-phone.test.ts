import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// ⛔ `repeat(auto-fit | auto-fill, minmax(280px, 1fr))` cannot go BELOW one 280px column.
// Inside a padded card on a 320px phone (~256px of content box) that column is wider
// than its container, so the page scrolls sideways — and on a real phone the layout
// viewport widens and the whole page renders zoomed out.
//
// 2026-10-26 mobile sweep: /teams/nba/blazers measured scrollWidth 332 at 320px (the
// team hub's "Recent sales" grid, components/entity/TeamActivity.tsx). Nine grids had
// the same expression. e2e/mobile-layout.spec.ts could not see it: the team hub is not in
// its route list, and no route list can hold every page a shared component lands on.
// Fix shape: `minmax(min(280px, 100%), 1fr)` — identical above the minimum, one
// full-width column below it.
//
// Ban at zero over app/ and components/ (a tree walk, not a list). Minimums under 260px
// are allowed: they fit a 320px phone's content box with ordinary padding.

const ROOT = process.cwd()
const THRESHOLD_PX = 260

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(tsx|ts|css)$/.test(name)) out.push(rel)
  }
  return out
}

export function wideGridMinimums(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/repeat\(\s*(auto-fill|auto-fit)\s*,\s*minmax\(\s*(\d+)px/g)) {
    if (Number(m[2]) >= THRESHOLD_PX) out.push(m[0])
  }
  return out
}

describe("auto-fit / auto-fill grid minimums fit a 320px phone", () => {
  const files = ["app", "components"].flatMap((d) => walk(d))

  it("the walk inspects the tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain("components/entity/TeamActivity.tsx")
  })

  it("no grid minimum at or above 260px is left unwrapped by min(…, 100%)", () => {
    const offenders = files.flatMap((f) => wideGridMinimums(readFileSync(join(ROOT, f), "utf8")).map((m) => `${f}: ${m}`))
    expect(offenders).toEqual([])
  })

  it("catches the 2026-10-26 shape and passes the fix (planted defect)", () => {
    expect(wideGridMinimums(`gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))"`)).toHaveLength(1)
    expect(wideGridMinimums(`grid-template-columns: repeat(auto-fill,minmax(320px,1fr));`)).toHaveLength(1)
    expect(wideGridMinimums(`gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))"`)).toEqual([])
    expect(wideGridMinimums(`gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))"`)).toEqual([])
  })
})
