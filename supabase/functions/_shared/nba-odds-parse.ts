// Shared pure logic for sync-nba-odds — the edge fn that pulls NBA moneyline /
// spread / totals from the-odds-api.com (via the odds-proxy worker) and writes
// per-game odds + a de-vigged home win probability that feeds the Fast Break /
// Road-to-the-Ring projections. Everything here is pure (no Deno / fetch /
// Supabase), so it is unit-testable under vitest even though the edge fn itself
// runs on Deno and is outside the CI coverage measure.
//
// What these decide is load-bearing:
//   • americanToImplied — American odds → implied probability. A sign or
//     denominator slip here silently produces a wrong win probability on every
//     game (the fabricated-signal class — the number still renders, it's just
//     wrong).
//   • devigPair — removes the bookmaker's vig by normalizing the home/away
//     implied pair to sum to 1, returning the home-side probability ∈ [0,1].
//     This is THE number the projections consume.
//   • pickBookmaker — the preference ladder (FanDuel → DraftKings → BetMGM →
//     first available). A regression that reordered it would silently change
//     which book's line the whole platform quotes.
//   • parseEvents — maps a raw the-odds-api event array into canonical per-game
//     rows (team-abbr resolution, h2h/spreads/totals extraction, ET game date).
//
// Ported VERBATIM from sync-nba-odds/index.ts (only the `export` keyword is
// added). The deployed edge fn keeps its inline copies; the source-drift guard
// in __tests__/edge-nba-odds-parse.test.ts fails CI if an inline copy is edited
// without mirroring it here. Intl / Date.parse are available in both Deno and
// Node ≥16, so this module imports cleanly under vitest.

// map covers all 30 NBA franchises. Verified against scoreboard payloads.
export const TEAM_NAME_TO_ABBR: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "Charlotte Hornets": "CHA",
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "Los Angeles Clippers": "LAC",
  "LA Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Pelicans": "NOP",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
}

export interface OddsApiOutcome {
  name?: string
  price?: number
  point?: number | null
}
export interface OddsApiMarket {
  key?: "h2h" | "spreads" | "totals" | string
  outcomes?: OddsApiOutcome[]
}
export interface OddsApiBookmaker {
  key?: string
  title?: string
  last_update?: string
  markets?: OddsApiMarket[]
}
export interface OddsApiEvent {
  id?: string
  commence_time?: string
  home_team?: string
  away_team?: string
  bookmakers?: OddsApiBookmaker[]
}

export const PREFERRED_BOOKMAKERS = ["fanduel", "draftkings", "betmgm"] as const

export function pickBookmaker(books: OddsApiBookmaker[]): OddsApiBookmaker | null {
  if (!books?.length) return null
  for (const key of PREFERRED_BOOKMAKERS) {
    const hit = books.find(b => (b.key ?? "").toLowerCase() === key)
    if (hit) return hit
  }
  return books[0] ?? null
}

export function americanToImplied(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds) || odds === 0) return null
  if (odds < 0) {
    const a = Math.abs(odds)
    return a / (a + 100)
  }
  return 100 / (odds + 100)
}

export function devigPair(home: number | null, away: number | null): number | null {
  // Returns home-side de-vigged probability ∈ [0,1]. Sums to 1 with the
  // away side, so callers don't need to store the away probability —
  // 1 - home covers it. Returns null if either side is missing.
  const homeRaw = americanToImplied(home)
  const awayRaw = americanToImplied(away)
  if (homeRaw == null || awayRaw == null) return null
  const total = homeRaw + awayRaw
  if (total <= 0) return null
  return Math.round((homeRaw / total) * 10000) / 10000
}

export interface ParsedEvent {
  oddsEventId: string | null
  commenceTime: string
  gameDate: string
  homeAbbr: string | null
  awayAbbr: string | null
  bookmakerKey: string
  homeMl: number | null
  awayMl: number | null
  homeSpread: number | null
  totalPoints: number | null
}

export function isoDateInET(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function parseEvents(events: OddsApiEvent[]): { parsed: ParsedEvent[]; bookmakerCounts: Record<string, number> } {
  const parsed: ParsedEvent[] = []
  const bookmakerCounts: Record<string, number> = {}

  for (const ev of events) {
    const book = pickBookmaker(ev.bookmakers ?? [])
    if (!book) continue

    const bookKey = (book.key ?? "unknown").toLowerCase()
    bookmakerCounts[bookKey] = (bookmakerCounts[bookKey] ?? 0) + 1

    const homeName = ev.home_team ?? ""
    const awayName = ev.away_team ?? ""
    const homeAbbr = TEAM_NAME_TO_ABBR[homeName] ?? null
    const awayAbbr = TEAM_NAME_TO_ABBR[awayName] ?? null

    const markets = book.markets ?? []
    const h2h = markets.find(m => m.key === "h2h")
    const spreads = markets.find(m => m.key === "spreads")
    const totals = markets.find(m => m.key === "totals")

    let homeMl: number | null = null
    let awayMl: number | null = null
    for (const o of h2h?.outcomes ?? []) {
      if (o.name === homeName) homeMl = typeof o.price === "number" ? o.price : null
      else if (o.name === awayName) awayMl = typeof o.price === "number" ? o.price : null
    }

    let homeSpread: number | null = null
    for (const o of spreads?.outcomes ?? []) {
      if (o.name === homeName) homeSpread = typeof o.point === "number" ? o.point : null
    }

    let totalPoints: number | null = null
    for (const o of totals?.outcomes ?? []) {
      if (typeof o.point === "number") {
        totalPoints = o.point
        break
      }
    }

    parsed.push({
      oddsEventId: ev.id ?? null,
      commenceTime: ev.commence_time ?? "",
      gameDate: isoDateInET(ev.commence_time),
      homeAbbr,
      awayAbbr,
      bookmakerKey: bookKey,
      homeMl,
      awayMl,
      homeSpread,
      totalPoints,
    })
  }

  return { parsed, bookmakerCounts }
}
