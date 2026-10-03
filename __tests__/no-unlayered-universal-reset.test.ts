import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// 2026-10-03: eight client files injected `*{box-sizing:border-box;margin:0;padding:0;}`
// through an inline <style>, UNLAYERED. In the CSS cascade an unlayered rule
// outranks every cascade layer regardless of specificity, so under those
// layouts (every collection page, the dashboard, login, profile, admin, the
// marketing homepage) EVERY Tailwind spacing utility — p-*, px-*, m-*, mt-* …
// — rendered as 0. Measured live in Chrome: a fresh <div class="p-4"> computed
// padding 0px; `w-4` and `gap-4` (no base reset for width/gap) worked. The
// pack table had been shipping with p-3 cells and no padding; the collection
// analytics cards had no padding; the header nav fix of the same morning
// shipped with md:px-1.5 and no padding. The fix wraps the reset in
// `@layer base` (where Tailwind preflight already keeps the same reset).
//
// This walks the tree so a ninth copy cannot come back by paste. The planted
// defect that proves it: drop the `@layer base{` wrapper in any one file.

const ROOTS = ["app", "components"]
const RESET = /\*\s*\{[^}]*(?:margin\s*:\s*0|padding\s*:\s*0)[^}]*\}/g

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out) }
    else if (/\.(tsx|ts|jsx|js)$/.test(name)) out.push(p)
  }
  return out
}

/** Every `* { … margin:0 / padding:0 … }` block in a file that is NOT inside an `@layer` block. */
function unlayeredResets(src: string): string[] {
  const hits: string[] = []
  for (const m of src.matchAll(RESET)) {
    const before = src.slice(0, m.index)
    // inside an @layer block iff an unmatched `@layer name{` precedes it
    const opens = (before.match(/@layer\s+[a-z-]+\s*\{/g) || []).length
    const lastOpen = before.lastIndexOf("@layer")
    const closedSince = lastOpen >= 0 ? (before.slice(lastOpen).match(/\}/g) || []).length : 0
    const openedSince = lastOpen >= 0 ? (before.slice(lastOpen).match(/\{/g) || []).length : 0
    const inLayer = opens > 0 && lastOpen >= 0 && openedSince > closedSince
    if (!inLayer) hits.push(m[0])
  }
  return hits
}

describe("no file injects an UNLAYERED universal margin/padding reset", () => {
  const files = ROOTS.flatMap(r => walk(r, []))

  it("walks a real population", () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it("every `*{…margin:0/padding:0…}` in app/ and components/ sits inside @layer", () => {
    const offenders: string[] = []
    let layered = 0
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      if (!/\*\s*\{/.test(src)) continue
      const bad = unlayeredResets(src)
      if (bad.length) offenders.push(`${f}: ${bad[0].slice(0, 60)}`)
      if ((src.match(RESET) || []).length > bad.length) layered++
    }
    // the eight fixed on 2026-10-03 must still be present (layered) — the guard
    // is not vacuous
    expect(layered).toBeGreaterThanOrEqual(8)
    expect(offenders).toEqual([])
  })

  it("the detector itself tells layered from unlayered", () => {
    expect(unlayeredResets("<style>{`*{margin:0;padding:0;}`}</style>")).toHaveLength(1)
    expect(unlayeredResets("<style>{`@layer base{*{margin:0;padding:0;}}`}</style>")).toHaveLength(0)
    expect(unlayeredResets("@layer base{.x{color:red}} *{padding:0}")).toHaveLength(1)
  })
})
