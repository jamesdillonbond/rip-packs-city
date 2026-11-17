// @vitest-environment node
//
// Tree-walk guard (#33, 2026-11-02): ISR can serve a cached FAILED regeneration for the whole revalidate
// window. Every client board that skips its mount refetch for the "server already gave us the default view"
// case (the `isFirstRun` shortcut) must NOT take that shortcut when the server seed failed — otherwise the
// cached failure is what every visitor sees until the next regeneration.
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOT = path.resolve(__dirname, "..")
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith(".tsx")) out.push(p)
  }
  return out
}

const boards = ["app", "components"]
  .flatMap((d) => walk(path.join(ROOT, d)))
  .map((abs) => ({ rel: path.relative(ROOT, abs).split(path.sep).join("/"), src: stripComments(readFileSync(abs, "utf8")) }))
  .filter((f) => /isFirstRun\s*=\s*useRef\(true\)/.test(f.src))

describe("boards with a skip-first-fetch shortcut refetch a failed seed", () => {
  it("finds the population (measured 14 boards on 2026-11-02)", () => {
    expect(boards.length).toBeGreaterThanOrEqual(14)
  })

  it("every such board captures the seed's failure and checks it before the shortcut", () => {
    const offenders = boards
      .filter((b) => {
        const captures = /seedFailedOnArrival\s*=\s*useRef\(/.test(b.src)
        const guard = /isFirstRun\.current\s*=\s*false\s*\n\s*if\s*\(\s*seedFailedOnArrival\.current\s*\)/.test(b.src)
        return !(captures && guard)
      })
      .map((b) => b.rel)
    expect(offenders).toEqual([])
  })
})
