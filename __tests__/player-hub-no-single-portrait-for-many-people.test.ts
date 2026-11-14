import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-14 (fresh-eyes review of the entity pages). /players/<slug> spans every
// collection; when the name belongs to more than one athlete (an NBA and an NFL
// Larry Johnson) the hero says so — and still showed ONE of them as "<name> portrait".
// A NAME is not a PERSON (CLAUDE.md, concierge rule 2). The JSON-LD already drops
// its Person node for this case; the visible hero must not pick a face either.
const src = stripComments(readFileSync("app/players/[slug]/page.tsx", "utf8"))

describe("player hub — no single portrait when the name is several people", () => {
  it("the portrait is null whenever manyPeople", () => {
    expect(src).toMatch(/const portrait = manyPeople\s*\?\s*null/)
  })
  it("manyPeople is derived before the portrait", () => {
    expect(src.indexOf("const manyPeople")).toBeGreaterThan(-1)
    expect(src.indexOf("const manyPeople")).toBeLessThan(src.indexOf("const portrait"))
  })
})
