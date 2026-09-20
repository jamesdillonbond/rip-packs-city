import { describe, it, expect } from "vitest"
import { decodeUnicodeEscapes } from "@/lib/pack-drops-board"
import { slugifyPlayerName } from "@/lib/entity-labels"

// MEASURED ON THE LIVE BOARD 2026-09-20. /insights/pack-drops rendered four
// player names as the LITERAL escape — "Marine Johann\u{e8}s" printed to users,
// six rows across four names — because Vaultopolis ships some names undecoded
// and the board passed the string straight through.
//
// It broke three things at once, which is why the fix is at INGEST and not at
// render:
//   1. the name printed the escape on a public board;
//   2. the drill-down slug 404'd (`marine-johann-u-e8-s`);
//   3. the FMV match is a player_name ILIKE, which an escaped name can never
//      satisfy — so those rows priced off the name alone.
const LIVE_CASES: Array<[string, string, string]> = [
  ["Marine Johann\\u{e8}s", "Marine Johannès", "marine-johannes"],
  ["Janelle Sala\\u{fc}n", "Janelle Salaün", "janelle-salaun"],
  ["Azur\\u{e1} Stevens", "Azurá Stevens", "azura-stevens"],
  ["Luka Don\\u{10d}i\\u{107}", "Luka Dončić", "luka-doncic"],
]

describe("pack-drops: undecoded unicode escapes from Vaultopolis", () => {
  it.each(LIVE_CASES)("decodes %s", (raw, decoded) => {
    expect(decodeUnicodeEscapes(raw)).toBe(decoded)
  })

  // The three slugs on the right were confirmed 200 on production before this
  // test was written; the escaped forms were confirmed 404.
  it.each(LIVE_CASES)("%s slugs to a URL that resolves", (raw, _decoded, slug) => {
    expect(slugifyPlayerName(decodeUnicodeEscapes(raw) as string).replace(/^-+|-+$/g, "")).toBe(slug)
  })

  it("leaves ordinary names untouched, including the null case", () => {
    expect(decodeUnicodeEscapes("Cooper Flagg")).toBe("Cooper Flagg")
    expect(decodeUnicodeEscapes(null)).toBeNull()
    // Already-decoded accents must not be double-processed.
    expect(decodeUnicodeEscapes("Nikola Jokić")).toBe("Nikola Jokić")
  })

  it("handles the 4-digit \\uXXXX form as well as \\u{...}", () => {
    expect(decodeUnicodeEscapes("Joki\\u0107")).toBe("Joki\u0107")
  })

  it("leaves an out-of-range codepoint alone rather than throwing", () => {
    expect(decodeUnicodeEscapes("bad\\u{110000}")).toBe("bad\\u{110000}")
  })

  // Ban at population zero: a hand-rolled slug is what produced the 404, and
  // re-inlining one would reintroduce it silently.
  it("a hand-rolled slug WOULD have 404'd — this is why entity-labels owns it", () => {
    const handRolled = "Marine Johannès".toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    expect(handRolled).toBe("marine-johann-s")
    expect(handRolled).not.toBe("marine-johannes")
  })
})
