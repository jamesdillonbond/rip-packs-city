import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-07: /profile/<u>/trophy-case's sticky header painted
// `rgba(8,8,8,0.97)` — the DARK value of --rpc-header-bg, hardcoded. In light
// mode the page body flipped white, --rpc-red-text flipped to its light shade
// (#B52A21) and the header stayed black: FULL PROFILE → read 3.02:1 (axe). The
// theme-aware token is `var(--rpc-header-bg)` (GlobalSiteHeader, TopNav,
// HomePageMarketing). This walks every .tsx under app/ and components/ for a
// near-black rgba/hex `background` inside a style object that also declares
// `position: "sticky"` — the sticky-header shape — and bans it at zero.
//
// Deliberately NOT a ban on every dark literal: admin pages and the
// transaction-history page paint a whole dark canvas with white text on
// purpose (consistent in both themes, so no contrast defect), and that is
// Phase-2 brand-token debt, measured elsewhere (scripts/check-brand-tokens).

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

const DARK_LITERAL = /background(Color)?\s*:\s*["'`]\s*(rgba?\(\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})[^)]*\)|#0[0-9a-fA-F]{5}|#[01][0-9a-fA-F]{2})\s*["'`]/

/** Line numbers of style objects that are sticky AND paint a hardcoded near-black background. */
export function findStickyDarkSlabs(src: string): number[] {
  const text = stripComments(src)
  const lines = text.split("\n")
  const hits: number[] = []
  lines.forEach((ln: string, i: number) => {
    const m = DARK_LITERAL.exec(ln)
    if (!m) return
    if (m[3] !== undefined && Math.max(+m[3], +m[4], +m[5]) > 40) return
    // the same style object: walk out to the nearest enclosing `{` … `}` pair
    let depth = 0, start = i
    for (let j = i; j >= 0; j--) {
      for (const ch of [...lines[j]].reverse()) { if (ch === "}") depth++; else if (ch === "{") { if (depth === 0) { start = j; j = -1; break } depth-- } }
    }
    depth = 0
    let end = i
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === "{") depth++; else if (ch === "}") { if (depth === 0) { end = j; j = lines.length; break } depth-- } }
    }
    const block = lines.slice(start, end + 1).join("\n")
    if (/position\s*:\s*["'`]sticky["'`]/.test(block)) hits.push(i + 1)
  })
  return hits
}

describe("sticky headers paint var(--rpc-header-bg), not a hardcoded dark slab", () => {
  it("catches a planted defect", () => {
    expect(findStickyDarkSlabs(`<header style={{\n  position: "sticky",\n  top: 0,\n  background: "rgba(8,8,8,0.97)",\n}} />`)).toEqual([4])
    expect(findStickyDarkSlabs(`<header style={{ position: "sticky", background: "#080808" }} />`)).toEqual([1])
    expect(findStickyDarkSlabs(`<header style={{ position: "sticky", background: "var(--rpc-header-bg)" }} />`)).toEqual([])
    // a dark literal that is NOT sticky is the whole-canvas shape, not this one
    expect(findStickyDarkSlabs(`<div style={{ minHeight: "100vh", background: "#080808", color: "#fff" }} />`)).toEqual([])
    // a light rgba is not a slab
    expect(findStickyDarkSlabs(`<header style={{ position: "sticky", background: "rgba(247,247,245,0.97)" }} />`)).toEqual([])
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    expect(files.length).toBeGreaterThan(400)
    const bad: string[] = []
    for (const f of files) for (const n of findStickyDarkSlabs(readFileSync(f, "utf8"))) bad.push(`${relative(ROOT, f)}:${n}`)
    expect(bad, "use var(--rpc-header-bg) on a sticky header (theme-aware)").toEqual([])
  })
})
