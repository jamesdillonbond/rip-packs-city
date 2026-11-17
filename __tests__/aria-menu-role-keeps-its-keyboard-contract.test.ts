import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-07: the header's five group panels and the Me panel were role="menu"
// (items role="menuitem", trigger aria-haspopup="menu") while behaving as
// plain lists of links — Tab walked the items, arrow keys and Escape did
// nothing, the Me panel had no menuitem children at all. The ARIA menu role is
// a PROMISE of that keyboard contract; markup that makes it without keeping it
// is a false claim to assistive tech that axe's structural rules cannot see.
// Rule: a file that declares role="menu" (or aria-haspopup="menu") must also
// handle ArrowDown and Escape. A disclosure of links uses role="group".

const ROOT = join(__dirname, "..")
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(e)) out.push(p)
  }
  return out
}
const CLAIMS = /role\s*=\s*["'{]\s*["']?menu["']?|aria-haspopup\s*=\s*["'{]\s*["']?menu["']?/
export function menuClaimWithoutContract(src: string): boolean {
  const s = stripComments(src)
  if (!CLAIMS.test(s)) return false
  return !(/ArrowDown/.test(s) && /Escape/.test(s))
}

// 2026-11-07 (same pass): `aria-haspopup="listbox"` on a button whose popup is a
// plain div of buttons (analytics FilterBar window picker, ListingsDashboard
// sort) — a listbox that never rendered. The claim needs a role="listbox" in
// the same file.
export function listboxClaimWithoutListbox(src: string): boolean {
  const s = stripComments(src)
  if (!/aria-haspopup\s*=\s*["'{]\s*["']?listbox["']?/.test(s)) return false
  return !/role\s*=\s*["']listbox["']/.test(s)
}

describe("aria-haspopup=\"listbox\" is only claimed where a listbox renders", () => {
  it("catches a planted defect", () => {
    expect(listboxClaimWithoutListbox(`<button aria-haspopup="listbox" aria-expanded={o} /><div>{opts.map(o => <button>{o}</button>)}</div>`)).toBe(true)
    expect(listboxClaimWithoutListbox(`<input role="combobox" aria-haspopup="listbox" /><ul role="listbox" />`)).toBe(false)
    expect(listboxClaimWithoutListbox(`<button aria-expanded={o} />`)).toBe(false)
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    const bad = files.filter((f) => listboxClaimWithoutListbox(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))
    expect(bad, "render a role=\"listbox\" or drop aria-haspopup (keep aria-expanded)").toEqual([])
  })
})

describe("role=\"menu\" is only claimed where arrow keys and Escape are handled", () => {
  it("catches a planted defect", () => {
    expect(menuClaimWithoutContract(`<div role="menu"><a role="menuitem" href="/x">x</a></div>`)).toBe(true)
    expect(menuClaimWithoutContract(`<a aria-haspopup="menu" href="/x">x</a>`)).toBe(true)
    expect(menuClaimWithoutContract(`<div role="menu" onKeyDown={(e) => { if (e.key === "ArrowDown") next(); if (e.key === "Escape") close() }} />`)).toBe(false)
    expect(menuClaimWithoutContract(`<div role="group" aria-label="Market"><a href="/x">x</a></div>`)).toBe(false)
    expect(menuClaimWithoutContract(`<select aria-haspopup="listbox" />`)).toBe(false)
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    expect(files.length).toBeGreaterThan(400)
    const bad = files.filter((f) => menuClaimWithoutContract(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f))
    expect(bad, 'use role="group" + aria-label for a disclosure of links, or implement ArrowDown/Escape').toEqual([])
  })
})
