import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-07: the binder's failed-lookup box, the pack page's and the analytics
// tab's error boxes were painted red with no live region — a screen-reader
// user who submitted a wallet and got an error heard nothing. The shape is
// specific enough to walk: a red Tailwind error box (`bg-red-950…`) rendering
// `{error}` must carry role="alert" or role="status". Banned at zero.

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
export function silentErrorBoxes(src: string): number[] {
  const lines = stripComments(src).split("\n")
  const hits: number[] = []
  lines.forEach((ln: string, i: number) => {
    if (!/bg-red-950/.test(ln) || !/\{error\}/.test(ln)) return
    if (!/role\s*=\s*["'](alert|status)["']/.test(ln)) hits.push(i + 1)
  })
  return hits
}
describe("a red error box that renders {error} is a live region", () => {
  it("catches a planted defect", () => {
    expect(silentErrorBoxes(`<div className="border-red-800 bg-red-950 p-3">{error}</div>`)).toEqual([1])
    expect(silentErrorBoxes(`<div role="alert" className="bg-red-950/30">{error}</div>`)).toEqual([])
    expect(silentErrorBoxes(`<div role="status" aria-live="polite" className="bg-red-950">{error}</div>`)).toEqual([])
    // a red chip that is not an error box
    expect(silentErrorBoxes(`cls: "bg-red-950 text-red-300"`)).toEqual([])
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    expect(files.length).toBeGreaterThan(400)
    const bad: string[] = []
    for (const f of files) for (const n of silentErrorBoxes(readFileSync(f, "utf8"))) bad.push(`${relative(ROOT, f)}:${n}`)
    expect(bad, 'add role="alert" (or role="status" for a box that also carries progress)').toEqual([])
  })
})
