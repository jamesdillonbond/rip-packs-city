import { describe, it, expect } from "vitest"
import {
  BADGE_GLYPH_BODY,
  GOLD_HEX,
  badgeGlyphDataUri,
  badgeGlyphBody,
  glyphDataUri,
  glyphSvg,
  normBadgeKey,
  specialCats,
  specialGlyphDataUri,
} from "@/lib/badges/glyphs"
import { editionKey, trophyMarks } from "@/lib/og/trophy-marks"

// ─────────────────────────────────────────────────────────────────────────────
// THE BADGES A SHARE CARD DRAWS FOR A MOMENT.
//
// Trevor, 2026-09-12: the Twitter/X image "needs to also include edition-wide
// badges (debut, rookie, championship, etc) along with special serial badges,
// for each moment displayed."
//
// Two kinds, sourced differently and failing differently, so they are pinned
// separately — and the sharpest cases here are the ones where a badge would be
// drawn that the Moment has NOT earned. A card asserting a jersey match that
// is not one is a false claim about a named collector's property, published to
// a timeline where nobody reading it can check.
// ─────────────────────────────────────────────────────────────────────────────

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd" // nba_top_shot
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070" // nfl_all_day

describe("specialCats — the canonical #1 / jersey / perfect definition", () => {
  it("⚠ treats jersey_number 0 as NO NUMBER, not as a serial to match", () => {
    // THE TRAP, and it is live data: `editions.jersey_number` is 0 — not null —
    // for a player with no number on file. Damian Lillard's row reads 0 today.
    // Without the `> 0` guard nothing matches serial 0 (there is no serial 0),
    // but the guard is what keeps it that way if the column ever holds a 0
    // serial, and it documents that 0 is a sentinel rather than a number.
    expect(specialCats(0, 28, 0)).toEqual([])
    expect(specialCats(28, 28, 0)).toEqual(["perfect"])
    expect(specialCats(28, 28, 28)).toEqual(["jersey", "perfect"])
  })

  it("a 1-of-1 is FIRST, and is not also a perfect mint", () => {
    // Two glyphs for one fact would read as two achievements. `circ > 1` is
    // what stops it.
    expect(specialCats(1, 1, null)).toEqual(["first"])
    expect(specialCats(1, 100, null)).toEqual(["first"])
    expect(specialCats(100, 100, null)).toEqual(["perfect"])
  })

  it("claims nothing when the serial is unknown", () => {
    expect(specialCats(null, 50, 23)).toEqual([])
  })

  it("matches a jersey only on the actual number", () => {
    expect(specialCats(23, 50, 23)).toEqual(["jersey"])
    expect(specialCats(24, 50, 23)).toEqual([])
  })
})

describe("trophyMarks — order, precedence and what is refused", () => {
  const kd = {
    badges: ["Rookie of the Year", "Rookie Premiere", "Rookie Year"],
    serial_number: 35,
    circulation_count: 40,
  }

  it("draws gold special serials FIRST, then the edition badges", () => {
    // The order the Trophy Case PDF already draws them in, so the PDF and the
    // three cards of the same Moment read the same way.
    const marks = trophyMarks(kd, 35, 6)
    expect(marks.map((m) => m.label)).toEqual([
      "Jersey Match",
      "Rookie of the Year",
      "Rookie Premiere",
      "Rookie Year",
    ])
    expect(marks[0].special).toBe(true)
    expect(marks.slice(1).every((m) => !m.special)).toBe(true)
  })

  it("⚠ truncates the EDITION badges, never the special serial", () => {
    // A tile holds three marks. The rarest thing about this Moment is the
    // jersey match; dropping it to keep a third "Rookie Year" would be the
    // wrong three.
    const marks = trophyMarks(kd, 35, 2)
    expect(marks.map((m) => m.label)).toEqual(["Jersey Match", "Rookie of the Year"])
  })

  it("draws nothing at all for a Moment that has earned nothing", () => {
    expect(trophyMarks({ badges: null, serial_number: 214, circulation_count: 299 }, null)).toEqual([])
  })

  it("suppresses ONLY the jersey glyph when the jersey number is unavailable", () => {
    // The jersey number comes from a separate read; the other two specials are
    // computed from the row. A failed read must not cost the whole row.
    const oneOfOne = { badges: ["Three-Star Rookie"], serial_number: 1, circulation_count: 1 }
    expect(trophyMarks(oneOfOne, null, 6).map((m) => m.label)).toEqual([
      "First Mint",
      "Three-Star Rookie",
    ])
  })

  it("⚠ refuses a badge entry that is not a non-empty string", () => {
    // `badges` is jsonb. A glyph drawn for a badge that is not there is a
    // fabricated one, and the `generic` fallback would happily draw it.
    const marks = trophyMarks(
      { badges: [null, "", "   ", 7, { title: "Rookie Year" }, "Rookie Year"] as unknown[], serial_number: 5, circulation_count: 9 },
      null,
      6,
    )
    expect(marks.map((m) => m.label)).toEqual(["Rookie Year"])
  })

  it("survives a badges value that is not an array at all", () => {
    expect(trophyMarks({ badges: "Rookie Year", serial_number: 5, circulation_count: 9 }, null)).toEqual([])
    expect(trophyMarks({ badges: undefined, serial_number: 5, circulation_count: 9 }, null)).toEqual([])
  })

  it("still DRAWS an unrecognised badge rather than dropping it", () => {
    // The mirror of the case above. The Moment really does carry this badge —
    // we just have no geometry for it, and a Moment with a badge must never
    // render as a Moment with none.
    const marks = trophyMarks({ badges: ["Some Future Badge"], serial_number: 5, circulation_count: 9 }, null)
    expect(marks.map((m) => m.label)).toEqual(["Some Future Badge"])
    expect(marks[0].uri.length).toBeGreaterThan(50)
  })
})

describe("editionKey — external_id is unique per COLLECTION, not globally", () => {
  it("keeps two collections' identical external ids apart", () => {
    // Unqualified, a jersey lookup hands one collection's number to another
    // collection's Moment — and a wrong jersey match is a wrong badge on a
    // shared card, not a missing one.
    expect(editionKey(TS, "675")).not.toBe(editionKey(AD, "675"))
  })

  it("is stable for the same pair and tolerates nulls", () => {
    expect(editionKey(TS, "165:6563")).toBe(editionKey(TS, "165:6563"))
    expect(editionKey(null, null)).toBe(":")
  })
})

describe("the glyphs cost NO network, which is the whole reason they exist", () => {
  // ⚠ THE PROPERTY THAT MATTERS, and the one a render test cannot see. An OG
  // card renders while a social crawler holds the connection open, and six
  // Moments × four badges of remote SVG is up to 24 unbounded third-party
  // fetches on that path — the exact defect lib/og/marks.tsx was written to
  // remove. Every glyph must be self-contained.
  const everyUri = [
    ...Object.keys(BADGE_GLYPH_BODY).map((k) => badgeGlyphDataUri(k, "#A78BFA")),
    specialGlyphDataUri("first"),
    specialGlyphDataUri("jersey"),
    specialGlyphDataUri("perfect"),
  ]

  it("emits data: URIs and nothing that can be fetched", () => {
    expect(everyUri.length).toBeGreaterThan(8)
    for (const uri of everyUri) {
      expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true)
      const svg = decodeURIComponent(uri.slice("data:image/svg+xml;charset=utf-8,".length))
      // ⚠ The SVG namespace is a URI but NOT a fetch — `xmlns` names the
      // dialect, nothing resolves it. Dropping the attribute before the scan
      // rather than loosening the pattern, so a real `http://` anywhere else
      // still reds this.
      const body = svg.replace(/\sxmlns="[^"]*"/g, "")
      expect(body).not.toMatch(/https?:/i)
      // No <image>, no <use xlink:href>, no @font-face, no text to shape.
      expect(body).not.toMatch(/<image|xlink:href|@font-face|<text/i)
    }
  })

  it("⚠ percent-encodes rather than base64s, so it cannot depend on Buffer", () => {
    // `/api/og/profile/[username]` is `edge`. An encoder that works in vitest
    // and throws in production is the worst failure mode available here.
    expect(glyphDataUri(glyphSvg("<circle/>", "#fff"))).toContain("%3Csvg")
    expect(glyphDataUri(glyphSvg("<circle/>", "#fff"))).not.toContain("base64")
  })

  it("carries the colour it was asked for, since satori resolves no variables", () => {
    expect(decodeURIComponent(badgeGlyphDataUri("Rookie Year", "#A78BFA"))).toContain('stroke="#A78BFA"')
    expect(decodeURIComponent(specialGlyphDataUri("jersey"))).toContain(`stroke="${GOLD_HEX}"`)
  })

  it("has geometry for every badge the trophy population actually carries", () => {
    // The live titles, 2026-09-12. A miss here is not fatal — `generic` draws —
    // but it means a real badge lost its identity on the most-shared surface.
    for (const title of [
      "Three-Star Rookie",
      "Rookie Mint",
      "Rookie Year",
      "Rookie of the Year",
      "Rookie Premiere",
      "Top Shot Debut",
      "Championship Year",
    ]) {
      expect(badgeGlyphBody(title), title).not.toBe(BADGE_GLYPH_BODY.generic)
    }
    expect(badgeGlyphBody("Nothing Like This")).toBe(BADGE_GLYPH_BODY.generic)
  })

  it("normBadgeKey collapses the spellings the taxonomy actually uses", () => {
    expect(normBadgeKey("Rookie Of The Year")).toBe("rookie-of-the-year")
    expect(normBadgeKey("Three-Star Rookie")).toBe("three-star-rookie")
  })
})
