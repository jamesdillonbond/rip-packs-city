import { describe, it, expect, vi, afterEach } from "vitest"
import {
  decodeMomentId,
  fmtUsd,
  fmtRelDate,
  fmtAbsDate,
  tierColorVar,
  collectionLabel,
  urlSlugForCollection,
  slugifyTeam,
} from "@/lib/moment-detail-format"

// Pure display helpers extracted from app/moment/[id]/page.tsx. These carry the
// null/branch logic behind every price, date, tier colour and drill-down link on
// the public moment page — the "silent $0 / wrong date / broken link" class.

describe("decodeMomentId", () => {
  it("decodes a percent-encoded Pinnacle legacy key", () => {
    expect(decodeMomentId("STAR-OEV1-SWHM%3ADigital%20Display%3A1")).toBe(
      "STAR-OEV1-SWHM:Digital Display:1"
    )
  })
  it("is a no-op for numeric ids and uuids", () => {
    expect(decodeMomentId("123456")).toBe("123456")
    expect(decodeMomentId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    )
  })
  it("falls back to the raw input on a malformed sequence (never throws)", () => {
    expect(decodeMomentId("%E0%A4%A")).toBe("%E0%A4%A")
    expect(decodeMomentId("100%")).toBe("100%")
  })
})

describe("fmtUsd", () => {
  it("returns em-dash for null / undefined / non-finite (never a fake $0)", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(undefined)).toBe("—")
    expect(fmtUsd(NaN)).toBe("—")
    expect(fmtUsd(Infinity)).toBe("—")
  })
  it("keeps cents below 1000", () => {
    expect(fmtUsd(0)).toBe("$0.00")
    expect(fmtUsd(12.5)).toBe("$12.50")
    expect(fmtUsd(999.99)).toBe("$999.99")
  })
  it("rounds to whole dollars with grouping at/above 1000", () => {
    expect(fmtUsd(1000)).toBe("$1,000")
    expect(fmtUsd(12345.67)).toBe("$12,346")
    expect(fmtUsd(1000000)).toBe("$1,000,000")
  })
  it("handles negatives via absolute-value threshold", () => {
    expect(fmtUsd(-1500)).toBe("$-1,500")
    expect(fmtUsd(-12.5)).toBe("$-12.50")
  })
})

describe("fmtRelDate (relative age)", () => {
  afterEach(() => vi.useRealTimers())
  const NOW = "2026-07-29T12:00:00.000Z"
  const at = (iso: string) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    return fmtRelDate(iso)
  }
  it("returns empty string for missing / unparseable input", () => {
    expect(fmtRelDate(null)).toBe("")
    expect(fmtRelDate(undefined)).toBe("")
    expect(fmtRelDate("not-a-date")).toBe("")
  })
  it("crosses each boundary", () => {
    expect(at("2026-07-29T06:00:00.000Z")).toBe("today") // same day (<1 day)
    expect(at("2026-07-28T10:00:00.000Z")).toBe("1d ago")
    expect(at("2026-07-24T12:00:00.000Z")).toBe("5d ago")
    expect(at("2026-06-25T12:00:00.000Z")).toBe("1mo ago") // ~34 days
    expect(at("2026-03-01T12:00:00.000Z")).toBe("5mo ago") // ~150 days → floor(150/30)=5
    expect(at("2024-07-29T12:00:00.000Z")).toBe("2y ago")
  })
  it("treats a future date as today (days <= 0)", () => {
    expect(at("2026-08-15T12:00:00.000Z")).toBe("today")
  })
})

describe("fmtAbsDate (absolute date)", () => {
  it("returns empty string for missing / unparseable input", () => {
    expect(fmtAbsDate(null)).toBe("")
    expect(fmtAbsDate(undefined)).toBe("")
    expect(fmtAbsDate("garbage")).toBe("")
  })
  it("renders a non-empty localized date carrying the year (locale-robust)", () => {
    const out = fmtAbsDate("2026-01-05T00:00:00.000Z")
    expect(out).not.toBe("")
    expect(out).toContain("2026")
  })
})

describe("tierColorVar", () => {
  it("maps the Top Shot vocabulary", () => {
    expect(tierColorVar("ULTIMATE")).toBe("var(--rpc-ultimate, var(--rpc-red))")
    expect(tierColorVar("LEGENDARY")).toBe("var(--rpc-legendary, var(--rpc-red))")
    expect(tierColorVar("RARE")).toBe("var(--rpc-rare, var(--rpc-text-primary))")
    expect(tierColorVar("FANDOM")).toBe("var(--rpc-fandom, var(--rpc-text-muted))")
    expect(tierColorVar("COMMON")).toBe("var(--rpc-common, var(--rpc-text-muted))")
  })
  it("maps the UFC Strike vocabulary", () => {
    expect(tierColorVar("CHALLENGER")).toBe("var(--tier-challenger, var(--rpc-red))")
    expect(tierColorVar("CONTENDER")).toBe("var(--tier-contender, var(--rpc-text-muted))")
  })
  it("is case-insensitive and falls back to muted for null/unknown", () => {
    expect(tierColorVar("legendary")).toBe("var(--rpc-legendary, var(--rpc-red))")
    expect(tierColorVar(null)).toBe("var(--rpc-text-muted)")
    expect(tierColorVar("MYTHIC")).toBe("var(--rpc-text-muted)")
  })
})

describe("collectionLabel", () => {
  it("maps every published slug to its brand name", () => {
    expect(collectionLabel("nba_top_shot")).toBe("NBA TOP SHOT")
    expect(collectionLabel("nfl_all_day")).toBe("NFL ALL DAY")
    expect(collectionLabel("laliga_golazos")).toBe("LALIGA GOLAZOS")
    expect(collectionLabel("ufc_strike")).toBe("UFC STRIKE")
    expect(collectionLabel("disney_pinnacle")).toBe("DISNEY PINNACLE")
  })
  it("falls back to underscores→spaces, uppercased, and handles null", () => {
    expect(collectionLabel("candy_mlb")).toBe("CANDY MLB")
    expect(collectionLabel(null)).toBe("")
  })
})

describe("urlSlugForCollection", () => {
  it("maps every published DB slug to its URL slug", () => {
    expect(urlSlugForCollection("nba_top_shot")).toBe("nba-top-shot")
    expect(urlSlugForCollection("nfl_all_day")).toBe("nfl-all-day")
    expect(urlSlugForCollection("laliga_golazos")).toBe("laliga-golazos")
    expect(urlSlugForCollection("ufc_strike")).toBe("ufc-strike")
    expect(urlSlugForCollection("disney_pinnacle")).toBe("disney-pinnacle")
  })
  it("returns null for an unknown slug so the caller suppresses the link", () => {
    expect(urlSlugForCollection("candy_mlb")).toBeNull()
    expect(urlSlugForCollection(null)).toBeNull()
  })
})

describe("slugifyTeam", () => {
  it("lowercases and dashes non-alnum, byte-identically to the Postgres expression", () => {
    expect(slugifyTeam("Portland Trail Blazers")).toBe("portland-trail-blazers")
    // trim() first, then EVERY non-alnum run becomes a dash — including a
    // trailing one. That is exactly what
    // regexp_replace(lower(trim(x)), '[^a-z0-9]+', '-', 'g') produces, and the
    // team RPCs compare against that expression, so the slug must not be
    // "tidied" past it.
    expect(slugifyTeam("  Los Angeles Lakers!  ")).toBe("los-angeles-lakers-")
  })
  it("does NOT strip diacritics — the accented char dashes out like Postgres does", () => {
    // REGRESSION GUARD (2026-08-01). This used to NFKD-decompose and strip
    // combining marks, yielding "atletico-madrid". That slug resolves ONLY via
    // get_team_detail's unaccent FALLBACK lane; get_team_players /
    // _top_editions / _activity / _sets / _squeeze have no such lane and
    // returned 0 rows, so the linked team page rendered an EMPTY body.
    // Postgres dashes the accented character out instead — match it.
    expect(slugifyTeam("Atlético Madrid")).toBe("atl-tico-madrid")
    expect(slugifyTeam("Peñarol")).toBe("pe-arol")
  })
})
