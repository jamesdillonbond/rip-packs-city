import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  pickBookmaker,
  americanToImplied,
  devigPair,
  isoDateInET,
  parseEvents,
  TEAM_NAME_TO_ABBR,
  type OddsApiEvent,
} from "@/supabase/functions/_shared/nba-odds-parse"

// Pins the pure core of sync-nba-odds — the NBA odds → de-vigged win-probability
// math + event parser that feeds the Fast Break / RTR projections. The edge fn
// runs on Deno (outside CI coverage), so this is unit tests + a source-drift
// guard over the inline copies. A bug in americanToImplied/devigPair is the
// fabricated-signal class: a wrong probability still renders as if it were real.

describe("americanToImplied — American odds → implied probability", () => {
  it("favorite (negative) odds: -110 → 110/210", () => {
    expect(americanToImplied(-110)).toBeCloseTo(110 / 210, 10)
  })
  it("even -100 → 0.5", () => {
    expect(americanToImplied(-100)).toBeCloseTo(0.5, 10)
  })
  it("underdog (positive) odds: +150 → 100/250 = 0.4", () => {
    expect(americanToImplied(150)).toBeCloseTo(0.4, 10)
  })
  it("+100 → 0.5 (the even-money crossover matches -100)", () => {
    expect(americanToImplied(100)).toBeCloseTo(0.5, 10)
  })
  it("returns null for 0 / null / undefined / non-finite (0 odds is not a real line)", () => {
    expect(americanToImplied(0)).toBeNull()
    expect(americanToImplied(null)).toBeNull()
    expect(americanToImplied(undefined)).toBeNull()
    expect(americanToImplied(Infinity)).toBeNull()
    expect(americanToImplied(NaN)).toBeNull()
  })
})

describe("devigPair — vig-removed home probability ∈ [0,1]", () => {
  it("two -110 sides de-vig to exactly 0.5 (symmetric book)", () => {
    expect(devigPair(-110, -110)).toBe(0.5)
  })
  it("a favorite/underdog pair de-vigs to the normalized home share, rounded to 4dp", () => {
    // home -200 (0.6667), away +170 (0.3704); total 1.0371; home share ≈ 0.6429
    const p = devigPair(-200, 170)!
    expect(p).toBeCloseTo(0.6429, 4)
    // 4-decimal rounding contract
    expect(Number.isInteger(p * 10000)).toBe(true)
  })
  it("home + (1 - home) reconstructs the away side (sums to 1 by construction)", () => {
    const home = devigPair(-150, 130)!
    expect(home + (1 - home)).toBeCloseTo(1, 10)
  })
  it("returns null when either side is missing (never a half-formed probability)", () => {
    expect(devigPair(null, -110)).toBeNull()
    expect(devigPair(-110, null)).toBeNull()
    expect(devigPair(0, 0)).toBeNull()
  })
})

describe("pickBookmaker — FanDuel → DraftKings → BetMGM → first-available ladder", () => {
  const bk = (key: string) => ({ key, markets: [] })
  it("prefers FanDuel when present", () => {
    expect(pickBookmaker([bk("betmgm"), bk("draftkings"), bk("fanduel")])?.key).toBe("fanduel")
  })
  it("falls to DraftKings when FanDuel is absent", () => {
    expect(pickBookmaker([bk("caesars"), bk("betmgm"), bk("draftkings")])?.key).toBe("draftkings")
  })
  it("is case-insensitive on the book key", () => {
    expect(pickBookmaker([bk("FanDuel")])?.key).toBe("FanDuel")
  })
  it("falls back to the first book when none preferred, and null on empty", () => {
    expect(pickBookmaker([bk("pinnacle"), bk("caesars")])?.key).toBe("pinnacle")
    expect(pickBookmaker([])).toBeNull()
  })
})

describe("isoDateInET — ET calendar date for the game", () => {
  it("a late-UTC tipoff maps back to the prior ET calendar day", () => {
    // 2026-01-16T00:30:00Z = 2026-01-15 19:30 ET
    expect(isoDateInET("2026-01-16T00:30:00Z")).toBe("2026-01-15")
  })
  it("returns '' for empty / unparseable input", () => {
    expect(isoDateInET(null)).toBe("")
    expect(isoDateInET("")).toBe("")
    expect(isoDateInET("not-a-date")).toBe("")
  })
})

describe("parseEvents — raw odds-api events → canonical per-game rows", () => {
  const event: OddsApiEvent = {
    id: "evt1",
    commence_time: "2026-01-16T00:30:00Z",
    home_team: "Los Angeles Lakers",
    away_team: "Golden State Warriors",
    bookmakers: [
      {
        key: "fanduel",
        markets: [
          { key: "h2h", outcomes: [{ name: "Los Angeles Lakers", price: -150 }, { name: "Golden State Warriors", price: 130 }] },
          { key: "spreads", outcomes: [{ name: "Los Angeles Lakers", point: -3.5 }, { name: "Golden State Warriors", point: 3.5 }] },
          { key: "totals", outcomes: [{ name: "Over", point: 225.5 }, { name: "Under", point: 225.5 }] },
        ],
      },
    ],
  }

  it("maps team names to abbreviations, extracts ml/spread/total, and ET date", () => {
    const { parsed, bookmakerCounts } = parseEvents([event])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      oddsEventId: "evt1",
      homeAbbr: "LAL",
      awayAbbr: "GSW",
      bookmakerKey: "fanduel",
      homeMl: -150,
      awayMl: 130,
      homeSpread: -3.5,
      totalPoints: 225.5,
      gameDate: "2026-01-15",
    })
    expect(bookmakerCounts).toEqual({ fanduel: 1 })
  })

  it("skips an event with no bookmaker (no phantom row)", () => {
    const { parsed } = parseEvents([{ id: "x", home_team: "Miami Heat", away_team: "Boston Celtics", bookmakers: [] }])
    expect(parsed).toHaveLength(0)
  })

  it("leaves unknown team names as null abbrs rather than guessing", () => {
    const { parsed } = parseEvents([{ ...event, home_team: "Paris Basketball", bookmakers: event.bookmakers }])
    expect(parsed[0].homeAbbr).toBeNull()
    expect(parsed[0].awayAbbr).toBe("GSW")
  })

  it("nulls ml/spread/total legs that are absent, without dropping the row", () => {
    const { parsed } = parseEvents([
      { id: "y", commence_time: "2026-01-16T00:30:00Z", home_team: "Miami Heat", away_team: "Boston Celtics", bookmakers: [{ key: "draftkings", markets: [] }] },
    ])
    expect(parsed[0]).toMatchObject({ homeMl: null, awayMl: null, homeSpread: null, totalPoints: null, bookmakerKey: "draftkings" })
  })

  it("TEAM_NAME_TO_ABBR maps both LA Clippers aliases to LAC", () => {
    expect(TEAM_NAME_TO_ABBR["Los Angeles Clippers"]).toBe("LAC")
    expect(TEAM_NAME_TO_ABBR["LA Clippers"]).toBe("LAC")
  })
})

// ── source-drift guard — sync-nba-odds inline copies ────────────────────────
// The deployed edge fn keeps its own inline copies of the functions mirrored in
// _shared/nba-odds-parse.ts. This fails CI if an inline copy is edited without
// mirroring it here (or the edge fn is migrated to import from _shared).
describe("edge-fn source-drift guard — sync-nba-odds inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(readFileSync(path.join(root, "supabase/functions/sync-nba-odds/index.ts"), "utf8"))
  const importsShared = /from\s+["'][^"']*_shared\/nba-odds-parse/.test(edgeSrc)

  const IMPLIED_NEG = norm("return a / (a + 100)")
  const IMPLIED_POS = norm("return 100 / (odds + 100)")
  const DEVIG = norm("return Math.round((homeRaw / total) * 10000) / 10000")
  const LADDER = norm('const PREFERRED_BOOKMAKERS = ["fanduel", "draftkings", "betmgm"]')
  const H2H = norm('const h2h = markets.find(m => m.key === "h2h")')

  it.each([
    ["americanToImplied favorite branch", IMPLIED_NEG],
    ["americanToImplied underdog branch", IMPLIED_POS],
    ["devigPair 4dp rounding", DEVIG],
    ["bookmaker preference ladder", LADDER],
    ["parseEvents h2h market select", H2H],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
