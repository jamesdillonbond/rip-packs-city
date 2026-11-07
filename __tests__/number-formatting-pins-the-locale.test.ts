import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-07: a de-DE visitor saw "4.000" for a 4,000 circulation on the
// market tab (client-formatted) beside "$6,836" on the edition page
// (server-formatted, Node's en-US) — and "$4.000" reads as four dollars.
// `toLocaleString()` with no locale follows the RUNTIME, so server HTML and
// client renders disagree per visitor. lib/collection-overview-format.ts
// learned this on 09-28 for one helper; 126 sites across 62 files had not.
// Number formatting is pinned to "en-US" (the product's figures are USD).
// Dates/times (toLocaleDateString / toLocaleTimeString) are deliberately
// NOT covered — a visitor's own date format and zone are what they want.

const ROOT = join(__dirname, "..")
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}
export function bareLocaleCalls(src: string): number[] {
  const lines = stripComments(src).split("\n")
  const hits: number[] = []
  lines.forEach((ln: string, i: number) => {
    if (/\.toLocaleString\(\s*\)/.test(ln) || /\.toLocaleString\(\s*undefined\b/.test(ln)) hits.push(i + 1)
  })
  return hits
}

describe("number formatting names its locale", () => {
  it("catches a planted defect", () => {
    expect(bareLocaleCalls(`const s = n.toLocaleString()`)).toEqual([1])
    expect(bareLocaleCalls(`const s = n.toLocaleString(undefined, { maximumFractionDigits: 0 })`)).toEqual([1])
    expect(bareLocaleCalls(`const s = n.toLocaleString("en-US")`)).toEqual([])
    expect(bareLocaleCalls(`const s = d.toLocaleDateString()`)).toEqual([])
    // a comment is not a call
    expect(bareLocaleCalls(`// a bare toLocaleString() follows the runtime`)).toEqual([])
  })
  it("finds none in app/, components/ or lib/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components")), ...walk(join(ROOT, "lib"))]
    expect(files.length).toBeGreaterThan(600)
    const bad: string[] = []
    for (const f of files) for (const n of bareLocaleCalls(readFileSync(f, "utf8"))) bad.push(`${relative(ROOT, f)}:${n}`)
    expect(bad, 'pass "en-US" (figures are USD and must match between server and client)').toEqual([])
  })
})
