import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  badgePlatform,
  officialBadgeArtUrl,
  officialSpecialSerialArt,
  topShotSpecialSvg,
  BADGE_ART_SLUGS,
} from "@/lib/badges/official-art"
import { trophyMarks } from "@/lib/og/trophy-marks"
import { GOLD_HEX } from "@/lib/badges/glyphs"
import { clip, contextLine, serialLine, trophyDetail } from "@/lib/og/trophy-detail"

// ─────────────────────────────────────────────────────────────────────────────
// OFFICIAL BADGE ART ON THE SHARE CARDS.
//
// Until 2026-09-12 four parallel badge implementations were live and the cards
// had picked the only INVENTED one — so the PDF of a collector's trophy case
// drew Dapper's badges while the share card of the SAME six Moments drew RPC's.
// These tests pin the tiering that reconciles them, and the two properties that
// make it safe: official art NEVER costs a Moment its badge when the fetch
// fails, and a badge title is NEVER resolved without its collection.
// ─────────────────────────────────────────────────────────────────────────────

const TS_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

describe("badgePlatform — both vocabularies, because the callers differ", () => {
  it("resolves a collection UUID as well as every slug spelling", () => {
    // The moment card has `collection_slug`; the profile card's typed row
    // carries `collection_id`. One resolver has to answer for both or one of
    // the three cards silently falls back to glyphs.
    for (const v of [TS_ID, "nba_top_shot", "nba-top-shot", "topshot", "TOPSHOT"]) {
      expect(badgePlatform(v), String(v)).toBe("topshot")
    }
    for (const v of [AD_ID, "nfl_all_day", "nfl-all-day", "allday"]) {
      expect(badgePlatform(v), String(v)).toBe("allday")
    }
  })

  it("returns null for the platforms that publish no badge art", () => {
    // ⚠ A REAL ANSWER, NOT A GAP. Golazos / UFC / Pinnacle have no official
    // badges, so RPC's mark there is RPC's own notation and must not be dressed
    // up as a platform credential — the line SpecialSerialGlyph already draws.
    for (const v of ["laliga_golazos", "ufc_strike", "disney_pinnacle", "", null, undefined]) {
      expect(badgePlatform(v), String(v)).toBeNull()
    }
  })
})

describe("officialBadgeArtUrl — collection-aware, because titles COLLIDE", () => {
  it("⚠ gives the two leagues DIFFERENT art for the SAME badge title", () => {
    // THE TRAP this whole signature exists for. All Day and Top Shot both have
    // a "Rookie Year" and a "Championship Year" badge with different artwork
    // (badge_art_overrides, keyed on collection_id). Resolving a title without
    // its collection draws the wrong league's badge on a named collector's
    // Moment — the same class of wrong as the caption bug these cards were
    // just fixed for, and just as invisible in a rendered PNG.
    const ts = officialBadgeArtUrl("Rookie Year", "nba_top_shot")
    const ad = officialBadgeArtUrl("Rookie Year", "nfl_all_day")
    expect(ts).toBeTruthy()
    expect(ad).toBeTruthy()
    expect(ts).not.toBe(ad)
    expect(ts).toContain("src=topshot")
    expect(ad).toContain("src=allday")
  })

  it("normalizes the title the same way Postgres does", () => {
    // get_badge_display_metadata keys on
    // regexp_replace(lower(unaccent(t)), '[^a-z0-9]+', '', 'g'), so every
    // spelling of a title has to land on one entry.
    const want = officialBadgeArtUrl("Rookie of the Year", TS_ID)
    for (const spelling of ["ROOKIE OF THE YEAR", "rookie_of_the_year", "Rookie Of The Year"]) {
      expect(officialBadgeArtUrl(spelling, TS_ID), spelling).toBe(want)
    }
  })

  it("returns null rather than GUESSING a slug for a badge with no art", () => {
    // ⚠ 44 of the 53 badge_taxonomy rows carry no icon_url. A guessed slug
    // would 400 at the proxy and degrade to the same glyph — but it would spend
    // a crawler's connection to get there. Null is the cheaper truth.
    expect(officialBadgeArtUrl("Some Future Badge", TS_ID)).toBeNull()
    expect(officialBadgeArtUrl("Hall of Fame", TS_ID)).toBeNull() // All Day only
  })

  it("claims no art at all on the platforms that have none", () => {
    for (const c of ["disney_pinnacle", "ufc_strike", "laliga_golazos"]) {
      expect(officialBadgeArtUrl("Rookie Year", c), c).toBeNull()
    }
  })

  it("emits a SITE-RELATIVE url so preview deployments resolve their own host", () => {
    // Hardcoding the apex here would point every preview card's badges at
    // production. lib/og/img-data.ts resolves "/..." against the site URL.
    const url = officialBadgeArtUrl("Rookie Mint", TS_ID)!
    expect(url.startsWith("/api/badge-image?")).toBe(true)
    expect(url).not.toMatch(/https?:/)
  })
})

describe("special serials — tiered by platform, exactly as the site already is", () => {
  it("⭐ costs Top Shot NO network: the official paths are in the repo", () => {
    // The single best trade in this change — the most-shared platform gets its
    // REAL badges for the same zero fetches the invented glyphs cost.
    for (const cat of ["first", "jersey", "perfect"] as const) {
      const art = officialSpecialSerialArt(cat, "nba_top_shot", GOLD_HEX)
      expect(art, cat).toEqual({ kind: "inline", svg: expect.any(String) })
    }
  })

  it("asks the proxy for All Day's official badgesV3 art", () => {
    const art = officialSpecialSerialArt("first", "nfl_all_day", GOLD_HEX)
    expect(art).toEqual({ kind: "url", url: expect.stringContaining("name=first-serial") })
  })

  it("claims nothing on a platform with no official art", () => {
    for (const c of ["disney_pinnacle", "ufc_strike", "laliga_golazos", null]) {
      expect(officialSpecialSerialArt("first", c, GOLD_HEX), String(c)).toBeNull()
    }
  })

  it("⚠ bakes the colour in — `currentColor` would render BLACK on a black card", () => {
    // The component inherits its colour from CSS. A data: URI has no CSS
    // context, so a surviving `currentColor` resolves to black — an INVISIBLE
    // badge, which is the failure mode that looks like "no badge" rather than
    // like an error. Asserting the absence of the false state, not the presence
    // of the right one.
    for (const cat of ["first", "jersey", "perfect"] as const) {
      const svg = topShotSpecialSvg(cat, GOLD_HEX)
      expect(svg, cat).not.toContain("currentColor")
      expect(svg, cat).toContain(GOLD_HEX)
    }
  })

  it("is self-contained — nothing in a lifted glyph can be fetched", () => {
    // Same property lib/badges/glyphs.ts is held to. These paths came from a
    // React component where a <use>, a font or a remote gradient would have
    // been fine; inlined into a data: URI on a crawler's connection they would
    // not be.
    for (const cat of ["first", "jersey", "perfect"] as const) {
      const body = topShotSpecialSvg(cat, GOLD_HEX).replace(/\sxmlns="[^"]*"/g, "")
      expect(body, cat).not.toMatch(/https?:/i)
      expect(body, cat).not.toMatch(/<image|xlink:href|@font-face|<text/i)
    }
  })
})

describe("trophyMarks — the art tier, and what survives losing it", () => {
  // Trevor's Kevin Durant, live data 2026-09-12: #9 of 10 — three earned
  // badges and, deliberately, NO special serial. 9 is not 10, so this row also
  // pins that an almost-perfect mint claims nothing.
  const kdRow = {
    badges: ["Rookie of the Year", "Rookie Premiere", "Rookie Year"],
    serial_number: 9,
    circulation_count: 10,
    collection_slug: "nba_top_shot",
  }

  it("every mark carries a drawable uri BEFORE any official art is fetched", () => {
    // ⚠ THE PROPERTY THAT MAKES THE WHOLE CHANGE SAFE. Official art is an
    // upgrade applied on top of a complete, zero-network badge row — never a
    // prerequisite for having one. A card that fetched nothing still draws
    // every badge the Moment earned.
    const marks = trophyMarks(kdRow, null, 6)
    expect(marks.map((m) => m.label)).toEqual([
      "Rookie of the Year",
      "Rookie Premiere",
      "Rookie Year",
    ])
    for (const m of marks) {
      expect(m.uri.startsWith("data:image/svg+xml"), m.label).toBe(true)
    }
  })

  it("routes Top Shot edition badges to official art and specials to inline art", () => {
    // A genuine perfect mint (#10 of 10) so the special tier is exercised.
    const marks = trophyMarks({ ...kdRow, serial_number: 10 }, null, 6)
    const perfect = marks.find((m) => m.special)!
    expect(perfect.label).toBe("Perfect Mint")
    // Top Shot's special serial needs no fetch at all — the paths are in the repo.
    expect(perfect.officialUrl).toBeNull()
    expect(perfect.uri).toContain("data:image/svg+xml")
    // Its edition badges all have official art.
    for (const m of marks.filter((x) => !x.special)) {
      expect(m.officialUrl, m.label).toContain("src=topshot")
    }
  })

  it("⚠ asks for NOTHING when the collection is unknown", () => {
    // Degrades to RPC glyphs rather than guessing a league. Wrong-looking is
    // recoverable; wrong-claiming is not.
    const marks = trophyMarks({ ...kdRow, collection_slug: null }, null, 6)
    expect(marks.every((m) => m.officialUrl === null)).toBe(true)
    expect(marks.length).toBe(3)
  })

  it("keeps RPC's marks on a Pinnacle Moment, and claims no platform art", () => {
    // Simba: no badges, serial 214 of 299 — nothing earned, nothing drawn.
    const marks = trophyMarks(
      {
        badges: null,
        serial_number: 214,
        circulation_count: 299,
        collection_slug: "disney_pinnacle",
      },
      null,
      4,
    )
    expect(marks).toEqual([])
  })

  it("draws a 1-of-1 as a FIRST mint with Top Shot's own art", () => {
    // Trevor's Donovan Clingan, live data 2026-09-12.
    const marks = trophyMarks(
      {
        badges: ["Three-Star Rookie"],
        serial_number: 1,
        circulation_count: 1,
        collection_slug: "nba_top_shot",
      },
      null,
      4,
    )
    expect(marks.map((m) => m.label)).toEqual(["First Mint", "Three-Star Rookie"])
    expect(marks[0].officialUrl).toBeNull() // inline, no fetch
    expect(marks[1].officialUrl).toContain("threeStars")
  })
})

describe("withOfficialArt — dedupes, and never costs a Moment its badge", () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function load() {
    const mod = await import("@/lib/og/official-mark-art")
    mod.__resetOfficialArtMemo()
    return mod
  }

  it("fetches each distinct badge ONCE across the whole card", async () => {
    // ⚠ THE COST ARGUMENT, PINNED. `lib/badges/glyphs.ts` feared "24 image
    // fetches" — that counts MARKS. What a render pays for is DISTINCT URLs,
    // and badges repeat hard across a case: six Top Shot Moments share one
    // vocabulary. If this ever regresses to per-mark fetching, the reason the
    // cards were allowed to use official art at all is gone.
    const seen: string[] = []
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(String(u))
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    })
    const { withOfficialArt } = await load()

    const row = () =>
      trophyMarks(
        { badges: ["Rookie Year"], serial_number: 5, circulation_count: 9, collection_slug: "nfl_all_day" },
        null,
        4,
      )
    const out = await withOfficialArt([row(), row(), row(), row(), row(), row()])

    // Six Moments, six "Rookie Year" marks, ONE fetch.
    expect(out.length).toBe(6)
    expect(seen.filter((u) => u.includes("rookie-year")).length).toBe(1)
  })

  it("⚠ falls back to the RPC glyph when official art fails — never to nothing", async () => {
    // The badge was EARNED. Losing its artwork must cost the badge's LOOK and
    // never the badge, which is the mirror of this repo's named #80 defect.
    vi.stubGlobal("fetch", async () => new Response(null, { status: 502 }))
    const { withOfficialArt } = await load()

    const before = trophyMarks(
      { badges: ["Rookie Year"], serial_number: 5, circulation_count: 9, collection_slug: "nfl_all_day" },
      null,
      4,
    )
    const [after] = await withOfficialArt([before])

    expect(after.length).toBe(before.length)
    expect(after.map((m) => m.label)).toEqual(before.map((m) => m.label))
    for (const m of after) {
      expect(m.uri.startsWith("data:image/svg+xml"), m.label).toBe(true)
    }
  })

  it("does not fetch at all for a card whose marks have no official art", async () => {
    // A Pinnacle / UFC / Golazos case must cost exactly zero requests — the
    // fallback tier is not a degraded state there, it is the correct one.
    const seen: string[] = []
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(String(u))
      return new Response(null, { status: 200 })
    })
    const { withOfficialArt } = await load()

    const marks = trophyMarks(
      { badges: ["Rookie Year"], serial_number: 1, circulation_count: 50, collection_slug: "disney_pinnacle" },
      null,
      4,
    )
    const [out] = await withOfficialArt([marks])
    expect(seen).toEqual([])
    expect(out.map((m) => m.label)).toEqual(marks.map((m) => m.label))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE DETAIL LINES — the facts the card already held and threw away.
// ─────────────────────────────────────────────────────────────────────────────

describe("serialLine", () => {
  it("renders the ratio a collector actually reads", () => {
    expect(serialLine(1, 1)).toBe("#1 / 1")
    expect(serialLine(5, 28)).toBe("#5 / 28")
    expect(serialLine(56, 99)).toBe("#56 / 99")
  })

  it("drops the denominator rather than inventing one", () => {
    // ⚠ "#56 / 0" would be a fabricated circulation. The three states are
    // known-both, known-serial-only, and unknown — never two.
    expect(serialLine(56, null)).toBe("#56")
    expect(serialLine(56, 0)).toBe("#56")
    expect(serialLine(null, 99)).toBe("")
    expect(serialLine(undefined, undefined)).toBe("")
  })

  it("groups thousands, because five-figure serials exist", () => {
    expect(serialLine(12000, 15000)).toBe("#12,000 / 15,000")
  })
})

describe("trophyDetail", () => {
  it("marks a 1-of-1 as special so the serial line is drawn GOLD", () => {
    // The most impressive object in Trevor's case, and the card was silent
    // about it until 2026-09-12.
    const d = trophyDetail({ serial_number: 1, circulation_count: 1, tier: "ULTIMATE" })
    expect(d.serial).toBe("#1 / 1")
    expect(d.special).toBe(true)
    expect(d.tier).toBe("ULTIMATE")
  })

  it("marks a perfect mint and a jersey match special too", () => {
    expect(trophyDetail({ serial_number: 28, circulation_count: 28 }).special).toBe(true)
    expect(trophyDetail({ serial_number: 23, circulation_count: 99 }, 23).special).toBe(true)
  })

  it("⚠ does NOT call an ordinary serial special", () => {
    // The whole value of the gold treatment is that it is rare. LeBron's
    // #56/99 is a great Moment and an ordinary serial.
    expect(trophyDetail({ serial_number: 56, circulation_count: 99 }).special).toBe(false)
    expect(trophyDetail({ serial_number: 9, circulation_count: 10 }).special).toBe(false)
  })

  it("⚠ inherits the jersey_number=0 sentinel from the canonical definition", () => {
    // `editions.jersey_number` is 0 — not null — for a player with no number
    // on file (Damian Lillard's row reads 0). Re-deriving this locally instead
    // of reusing specialCats is how the card and the badge row end up
    // disagreeing about the same Moment.
    expect(trophyDetail({ serial_number: 5, circulation_count: 28 }, 0).special).toBe(false)
  })

  it("⚠ trims a set name that arrives with a leading space", () => {
    // Live data: Disney Pinnacle set names do exactly this, and at 10px an
    // untrimmed one reads as a misaligned line rather than as a space.
    const d = trophyDetail({ set_name: " Walt Disney Animation Studios" }, null, 40)
    expect(d.set.startsWith("W")).toBe(true)
  })

  it("returns empty strings rather than omitting fields, so rows stay the same height", () => {
    // ⚠ THE BASELINE TRAP. Tiles are centred, so a Moment with one fewer line
    // is a shorter column that satori centres LOWER — Simba sat 10px below his
    // neighbours before the badge row was height-reserved. A fixed-shape return
    // is what lets the caller reserve every line.
    const d = trophyDetail({})
    expect(d).toEqual({ serial: "", tier: "", set: "", context: "", special: false })
  })
})

describe("contextLine — formats the series, and refuses to remap it", () => {
  it("joins the series and the play description", () => {
    expect(contextLine(7, "Reel")).toBe("Series 7 · Reel")
    expect(contextLine(5, "3 Pointer")).toBe("Series 5 · 3 Pointer")
  })

  it("drops whichever half is missing", () => {
    expect(contextLine(7, null)).toBe("Series 7")
    expect(contextLine(null, "Reel")).toBe("Reel")
    expect(contextLine(null, null)).toBe("")
  })

  it("⚠ does NOT remap series 1 — that corrupts four collections", () => {
    // Top Shot has no on-chain series 1 (series 0 IS Series 1), but
    // `editions.series` here is the DISPLAY number and All Day / Golazos /
    // Pinnacle use 1 legitimately. A blanket 1→0 remap silently dropped
    // 385,734 Top Shot rows on 2026-08-05. Trevor's All Day Moment reads 1 and
    // is genuinely Series 1.
    expect(contextLine(1, null)).toBe("Series 1")
    expect(contextLine(0, null)).toBe("Series 0")
  })
})

describe("clip", () => {
  it("uses a single-character ellipsis, not three dots", () => {
    // Three dots cost three glyph slots in the budget they are meant to respect.
    const out = clip("2024 Rookie Ultimates Championship Edition", 12)
    expect(out.length).toBeLessThanOrEqual(12)
    expect(out.endsWith("…")).toBe(true)
    expect(out).not.toContain("...")
  })

  it("leaves a string that already fits completely alone", () => {
    expect(clip("Supernova", 24)).toBe("Supernova")
    expect(clip("  Supernova  ", 24)).toBe("Supernova")
  })
})

describe("the registry cannot emit a slug the proxy will not serve", () => {
  it("keeps every entry inside /api/badge-image's allowlist", async () => {
    // ⚠ The allowlist IS that route's injection guard, so a slug it does not
    // know is a 400 — a spent connection for a badge we could have drawn
    // locally. The LIVE half of this (does the DB still carry this art?) needs
    // credentials and lives in scripts/check-badge-art-registry-drift.mjs;
    // this half runs on every CI checkout with none.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("app/api/badge-image/route.ts", "utf-8"),
    )
    const allow = new Set(
      Array.from(src.matchAll(/'([A-Za-z0-9-]+)'/g)).map((m) => m[1]),
    )
    const entries = [
      ...Object.values(BADGE_ART_SLUGS.topshot),
      ...Object.values(BADGE_ART_SLUGS.allday),
    ]
    // ⚠ Asserts the COUNT it inspected: an empty registry would pass vacuously.
    expect(entries.length).toBeGreaterThanOrEqual(17)
    for (const slug of entries) {
      expect(allow.has(slug), slug).toBe(true)
    }
  })
})
