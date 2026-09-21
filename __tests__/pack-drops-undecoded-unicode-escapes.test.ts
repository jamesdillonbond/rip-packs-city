import { describe, it, expect } from "vitest"
import { decodeUnicodeEscapes } from "@/lib/pack-drops-board"
import { slugifyPlayerName } from "@/lib/entity-labels"

// Vaultopolis ships some player names with the unicode escape UNDECODED — the
// literal characters `Johann\u{e8}s`, not `Johannès` — and /insights/pack-drops
// passed the string straight through to a public board.
//
// ⚠ THE POPULATION BELOW IS THE FEED, NOT THE BOARD, and the two differ.
// Re-derived 2026-09-20 ~5:2x PM PT directly from data.vaultopolis.com across
// all 8 drops: 13 asset rows carrying an escape, FIVE distinct names, 4 distinct
// codepoints (U+0107 carries two of the names). The board renders only the
// minted/listed drops, which was 6 of those 13 rows — so a board-only count is
// the narrower number, and the first write-up of this said "4 names" because it
// had counted codepoints. Every name here was read off the live feed; none is
// invented.
const FEED_CASES: Array<{ raw: string; decoded: string; slug: string }> = [
  { raw: "Marine Johann\\u{e8}s", decoded: "Marine Johannès", slug: "marine-johannes" },
  { raw: "Janelle Sala\\u{fc}n", decoded: "Janelle Salaün", slug: "janelle-salaun" },
  { raw: "Azur\\u{e1} Stevens", decoded: "Azurá Stevens", slug: "azura-stevens" },
  { raw: "Bojan Bogdanovi\\u{107}", decoded: "Bojan Bogdanović", slug: "bojan-bogdanovic" },
  { raw: "Jusuf Nurki\\u{107}", decoded: "Jusuf Nurkić", slug: "jusuf-nurkic" },
]

// The slugify the board USED to inline. Kept as the control arm, because the
// interesting question is which of the three spellings the player resolver can
// actually reach — not whether two strings differ.
const handRolled = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

describe("pack-drops: undecoded unicode escapes from Vaultopolis", () => {
  it.each(FEED_CASES)("decodes $raw", ({ raw, decoded }) => {
    expect(decodeUnicodeEscapes(raw)).toBe(decoded)
  })

  it.each(FEED_CASES)("$raw slugs to the canonical unaccented player URL", ({ raw, slug }) => {
    expect(slugifyPlayerName(decodeUnicodeEscapes(raw) as string).replace(/^-+|-+$/g, "")).toBe(slug)
  })

  // ⛔ THIS ARM REPLACES A FALSE ONE. The first version of this file asserted
  // "a hand-rolled slug WOULD have 404'd" — and asserted only that two strings
  // differ, which is true of any two spellings and proves nothing. Measured on
  // production and against `get_player_detail` on 2026-09-20, the claim in that
  // title is WRONG: the resolver matches the raw-slugified name as well as the
  // unaccented one (migration audit_20260906_player_slugs_resolve_unaccented…),
  // so `/nba-top-shot/player/marine-johann-s` returns 200 with a byte-identical
  // page to `…/marine-johannes`, and all five names below resolve BOTH ways.
  //
  // What is actually true — and what this file exists to hold — is the property
  // about the ESCAPE: it slugifies to a third form neither resolver arm can
  // produce, because the escape's own `u` and hex digits survive as slug
  // segments. `marine-johann-u-e8-s` was confirmed 404 on production; both
  // decoded forms were confirmed 200. Pin THAT.
  it.each(FEED_CASES)(
    "the ESCAPED form slugs to something no resolver arm can produce: $raw",
    ({ raw, decoded, slug }) => {
      const escapedSlug = handRolled(raw)
      // The resolver's two arms, spelled the way the SQL spells them.
      const rawArm = handRolled(decoded)
      const unaccentedArm = slug
      expect(escapedSlug).not.toBe(rawArm)
      expect(escapedSlug).not.toBe(unaccentedArm)
      // The tell: the escape leaves its `u` + hex behind as slug segments.
      expect(escapedSlug).toMatch(/-u-[0-9a-f]+-?/)
      // …and decoding first removes the difference, which is the whole fix.
      expect(handRolled(decodeUnicodeEscapes(raw) as string)).toBe(rawArm)
    },
  )

  // Both decoded spellings reach the page today, so neither is a 404 risk on its
  // own. slugifyPlayerName is still the one to use: the raw arm only matches
  // when the name being slugified is spelled the way the `players` row spells
  // it, and the Vaultopolis name is a third source for the same player. Pinning
  // the two forms as DISTINCT keeps a future reader from concluding the
  // resolver's unaccent arm is doing nothing.
  it.each(FEED_CASES)("the two decoded spellings are genuinely different strings: $raw", ({ decoded, slug }) => {
    expect(handRolled(decoded)).not.toBe(slug)
  })

  it("leaves ordinary names untouched, including the null case", () => {
    expect(decodeUnicodeEscapes("Cooper Flagg")).toBe("Cooper Flagg")
    expect(decodeUnicodeEscapes(null)).toBeNull()
    // Already-decoded accents must not be double-processed.
    expect(decodeUnicodeEscapes("Nikola Jokić")).toBe("Nikola Jokić")
  })

  it("is idempotent — a second pass over decoded output changes nothing", () => {
    for (const { raw } of FEED_CASES) {
      const once = decodeUnicodeEscapes(raw) as string
      expect(decodeUnicodeEscapes(once)).toBe(once)
    }
  })

  it("handles the 4-digit \\uXXXX form as well as \\u{...}", () => {
    expect(decodeUnicodeEscapes("Joki\\u0107")).toBe("Jokić")
  })

  it("leaves an out-of-range codepoint alone rather than throwing", () => {
    expect(decodeUnicodeEscapes("bad\\u{110000}")).toBe("bad\\u{110000}")
  })
})
