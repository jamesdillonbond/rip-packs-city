// __tests__/a-search-box-matches-accented-names.test.ts
//
// A free-text search written as `name.toLowerCase().includes(q)` is case-blind
// but ACCENT-SENSITIVE: "doncic" finds nothing for "Luka Dončić", "vinicius"
// nothing for "Vinícius Júnior", "atletico" nothing for "Atlético de Madrid".
// The names this platform searches are full of diacritics (LaLiga Golazos, NBA
// and WNBA rosters), and the people typing rarely type the accent.
//
// ── THE CASE THIS WAS WRITTEN FROM (2026-10-21) ────────────────────────────
// Fifteen search boxes and filters used that expression — the Sniper search and
// player filter, the Pinnacle and Panini snipers, /api/sniper-feed's player
// filter, the Candy / Panini Premiums / Panini Squeeze boards, the Pack Sniper,
// the wallet collection's "Filter moments…", the editions grid's "Filter
// editions…", the alerts option picker, the trophy picker and three concierge
// board filters. All now call `textIncludes()` (lib/filter-match.ts), which is
// exactly the old test for plain ASCII and folds accents otherwise.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
// A BAN AT ZERO on `<expr>.toLowerCase().includes(<identifier>)` across app/,
// components/ and lib/. A literal argument (`msg.toLowerCase().includes("slow
// down")`) is an error-string check, not a search, and is not matched.
//
// ⚠ What this is structurally SILENT about: the two-step form — lowercase a
// haystack into a variable, then `hay.includes(q)` on a later line. The walk
// cannot tell that from any other `.includes`. Use `textIncludes(hay, q)`.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOTS = ["app", "components", "lib"]
const SHAPE = /\.toLowerCase\(\)\s*\.includes\(\s*[A-Za-z_$][\w$]*\s*\)/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe("a search box matches accented names", () => {
  const files = ROOTS.flatMap((r) => walk(r))

  it("walks the tree (a guard that inspected nothing has not passed)", () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it("no `x.toLowerCase().includes(q)` search remains — use textIncludes()", () => {
    const hits: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"))
      for (const m of src.matchAll(SHAPE)) hits.push(`${f}: ${m[0]}`)
    }
    expect(hits).toEqual([])
  })

  it("the shape regex is live (planted positives and negatives)", () => {
    const has = (s: string) => new RegExp(SHAPE.source).test(s)
    expect(has(`d.playerName.toLowerCase().includes(q)`)).toBe(true)
    expect(has(`(x || "").toLowerCase() .includes( needle )`)).toBe(true)
    expect(has(`raw.toLowerCase().includes("slow down")`)).toBe(false)
    expect(has(`textIncludes(d.playerName, q)`)).toBe(false)
  })
})
