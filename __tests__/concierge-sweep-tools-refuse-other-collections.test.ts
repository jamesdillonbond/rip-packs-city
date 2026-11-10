import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-09 — a production probe on a LaLiga Golazos page asked "what are the hot floors right now"
// and the concierge answered with NBA Top Shot's sweep board. It said so, but a substituted subject
// is refused, not labelled (CLAUDE.md, Honesty: SUBSTITUTION). Pinnacle, All Day and Candy each had
// an arm; every OTHER named collection fell through to the Top Shot read. This pins the catch-all:
// in both sweep tools, the refusal for a named non-Top-Shot collection sits BEFORE the Top Shot read.
const src = readFileSync(join(process.cwd(), "app/api/support-chat/route.ts"), "utf8")

const handler = (name: string) => {
  const start = src.indexOf(`if (toolName === "${name}") {`)
  expect(start, name).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf("\n  if (toolName === ", start + 10))
}

describe("concierge sweep tools never answer a named collection with Top Shot rows", () => {
  it.each([
    ["get_hot_floors", 'rpc("get_topshot_hot_floors"'],
    ["get_edition_sweep", 'rpc("get_edition_sweep_signal"'],
  ])("%s refuses before its Top Shot read", (name, tsRead) => {
    const h = handler(name)
    const guard = h.indexOf('effectiveCollectionId !== "nba-top-shot"')
    const refuse = h.indexOf(`sweepNotApplicable("${name}", effectiveCollectionId)`)
    const read = h.indexOf(tsRead)
    expect(read, `${name}: Top Shot read not found — the pin's premise moved`).toBeGreaterThan(-1)
    expect(guard, `${name} has no catch-all collection guard`).toBeGreaterThan(-1)
    expect(refuse, `${name} does not refuse`).toBeGreaterThan(guard)
    expect(refuse).toBeLessThan(read)
  })

  it("the refusal names no Top Shot row and says how to ask for Top Shot explicitly", () => {
    const start = src.indexOf("function sweepNotApplicable(")
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf("\n}\n", start))
    expect(body).toContain('status: "not_applicable"')
    expect(body).toContain('collectionId "nba-top-shot"')
    // An ABSENT collection must still default to Top Shot: the guard tests a present, different slug.
    expect(src).toContain('if (effectiveCollectionId && effectiveCollectionId !== "nba-top-shot") {')
  })
})
