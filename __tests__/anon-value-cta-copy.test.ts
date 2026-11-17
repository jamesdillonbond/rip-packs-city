import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { anonValueCtaCopy } from "@/lib/auth/anon-value-cta-copy"

// 2026-11-16: the signed-out account prompt on every collection's edition page.
describe("anonValueCtaCopy", () => {
  it("Panini keeps its 11-08 surface and wording", () => {
    expect(anonValueCtaCopy("panini-blockchain")).toEqual({ identityNoun: "Panini username", itemNoun: "card", surface: "panini_edition" })
  })
  it("names the identity each collection's add-wallet form takes", () => {
    expect(anonValueCtaCopy("nba-top-shot")).toMatchObject({ identityNoun: "Top Shot username", itemNoun: "moment" })
    expect(anonValueCtaCopy("disney-pinnacle")).toMatchObject({ identityNoun: "Dapper username", itemNoun: "pin" })
    expect(anonValueCtaCopy("candy-mlb")).toMatchObject({ identityNoun: "Candy wallet address", itemNoun: "card" })
  })
  it("an unlisted collection gets no prompt (never a guessed identity)", () => {
    expect(anonValueCtaCopy("ufc")).toBeNull()
    expect(anonValueCtaCopy("rwa")).toBeNull()
    expect(anonValueCtaCopy("nope")).toBeNull()
  })
  it("surfaces are unique, so clicks per collection stay separable", () => {
    const s = ["panini-blockchain", "nba-top-shot", "nfl-all-day", "laliga-golazos", "disney-pinnacle", "candy-mlb"].map((c) => anonValueCtaCopy(c)!.surface)
    expect(new Set(s).size).toBe(s.length)
  })
  it("the edition page renders the prompt from the registry, not behind isPanini", () => {
    const src = readFileSync("app/(collections)/[collection]/edition/[slug]/page.tsx", "utf8")
    expect(src).toMatch(/const copy = anonValueCtaCopy\(collection\)\s*\n\s*return copy \? <AnonCollectionValueCta \{\.\.\.copy\} \/> : null/)
    expect(src).not.toMatch(/isPanini && <AnonCollectionValueCta/)
  })
})
