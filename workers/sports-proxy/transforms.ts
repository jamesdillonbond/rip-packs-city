// Pure DK/NBA transforms lifted out of index.ts so they can be unit-tested
// under Node/vitest (the worker's default export pulls in Cloudflare globals +
// live fetch, which can't be imported cleanly). These are the deterministic
// string/date/stat helpers that shape the DraftKings projections + NBA rolling
// stats feeds (Fast Break / Road to the Ring consume the output) — a regression
// in any of them silently corrupts a projection or points a stats request at
// the wrong season, and none of it runs in CI today. Pure + dependency-free:
// no fetch, no env, no Cloudflare/Deno globals (Intl + URL are standard).

// Format an epoch-ms instant as a YYYY-MM-DD calendar date in US Eastern time
// (the timezone the NBA slate + DK contests are keyed on).
export function dateInETFromMs(ms: number): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dateInETFromIso(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return dateInETFromMs(ms);
}

// DK competition.name arrives as "MIN @ SAS" (away @ home); some legacy contests
// use " vs " — accept either. For "@", the right-hand token is always home.
export function parseCompetitionTeams(
  name: string | undefined | null,
): { homeAbbr: string | null; awayAbbr: string | null } {
  if (!name) return { homeAbbr: null, awayAbbr: null };
  const at = name.match(/^\s*([A-Z]{2,4})\s*@\s*([A-Z]{2,4})\s*$/i);
  if (at) return { homeAbbr: at[2].toUpperCase(), awayAbbr: at[1].toUpperCase() };
  const vs = name.match(/^\s*([A-Z]{2,4})\s+vs\.?\s+([A-Z]{2,4})\s*$/i);
  if (vs) return { homeAbbr: vs[2].toUpperCase(), awayAbbr: vs[1].toUpperCase() };
  return { homeAbbr: null, awayAbbr: null };
}

// DK ships dates as the legacy Microsoft-JSON "/Date(1699999999999)/" form.
export function parseMsJsonDate(sd: string | undefined): number | null {
  if (!sd) return null;
  const m = sd.match(/\/Date\((\d+)\)\//);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Normalize DK injury-status codes to the vocabulary the app renders.
export function mapStatus(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const u = v.toUpperCase();
  if (u === "NONE") return "ACTIVE";
  if (u === "Q" || u === "GTD") return "QUESTIONABLE";
  if (u === "O" || u === "OUT") return "OUT";
  if (u === "IR") return "INACTIVE";
  return v;
}

// Given a competition name ("PHI @ NYK" / "PHI vs NYK") and one team abbr,
// return the other team's abbr, or null when the team isn't in the matchup.
export function extractOpponent(compName: string | undefined, teamAbbr: string | null): string | null {
  if (!compName || !teamAbbr) return null;
  const m = compName.match(/([A-Z]{2,4})\s+(?:@|vs)\s+([A-Z]{2,4})/i);
  if (!m) return null;
  const ta = teamAbbr.toUpperCase();
  if (m[1].toUpperCase() === ta) return m[2].toUpperCase();
  if (m[2].toUpperCase() === ta) return m[1].toUpperCase();
  return null;
}

// etDate is YYYY-MM-DD. NBA seasons run Oct (year N) → Jun (year N+1); Jul–Sep
// have no games but pin to the most-recent season to keep the request valid.
export function nbaSeasonStringFromETDate(etDate: string): string {
  const [yStr, mStr] = etDate.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const startYear = m >= 10 ? y : y - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYY}`;
}

// Mid-April → mid-June is Playoffs; everything else (incl. the Jul–Sep
// off-season, which returns an empty upstream rowSet) is Regular Season.
export function nbaSeasonTypeFromETDate(etDate: string): "Playoffs" | "Regular Season" {
  const parts = etDate.split("-");
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (m === 4 && d >= 15) return "Playoffs";
  if (m === 5 || m === 6) return "Playoffs";
  return "Regular Season";
}

// stats.nba.com/leaguedashplayerstats requires EVERY parameter present (a
// missing field 400s with "The field <X> is required"), filled exactly the way
// the official site does. Only Season + SeasonType vary per request.
export function buildPlayerStatsUrl(season: string, seasonType: "Regular Season" | "Playoffs"): string {
  const url = new URL("https://stats.nba.com/stats/leaguedashplayerstats");
  const params: Record<string, string> = {
    College: "",
    Conference: "",
    Country: "",
    DateFrom: "",
    DateTo: "",
    Division: "",
    DraftPick: "",
    DraftYear: "",
    GameScope: "",
    GameSegment: "",
    Height: "",
    LastNGames: "5",
    LeagueID: "00",
    Location: "",
    MeasureType: "Base",
    Month: "0",
    OpponentTeamID: "0",
    Outcome: "",
    PORound: "0",
    PaceAdjust: "N",
    PerMode: "PerGame",
    Period: "0",
    PlayerExperience: "",
    PlayerPosition: "",
    PlusMinus: "N",
    Rank: "N",
    Season: season,
    SeasonSegment: "",
    SeasonType: seasonType,
    ShotClockRange: "",
    StarterBench: "",
    TeamID: "0",
    VsConference: "",
    VsDivision: "",
    Weight: "",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}
