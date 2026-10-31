// NBA / WNBA league derivation from a Top Shot set name.
//
// The WNBA_ONLY_SETS list below is mirrored inside the `upsert_wallet_moments`
// Postgres RPC, which derives `wallet_moments_cache.league` server-side at
// ingest time. The two MUST be kept in sync — when adding a WNBA set here,
// also publish a Supabase migration that updates the RPC's set list. Drifting
// the two will cause the sniper feed (which uses this file) and the wallet /
// collection pages (which read the column) to disagree about the same moment.

export const WNBA_ONLY_SETS: ReadonlySet<string> = new Set([
  "Rise With Us",
  "Rise With Us 2023",
  "In Her Bag",
  "In Their Bag",
  "Shining Stars",
  "Chasing the Trophy",
  "For the Cup",
]);

export function leagueForSetName(name: string | null | undefined): "NBA" | "WNBA" | null {
  if (!name) return null;
  if (/wnba/i.test(name)) return "WNBA";
  if (WNBA_ONLY_SETS.has(name)) return "WNBA";
  return "NBA";
}

/**
 * League of a Top Shot EDITION, from its team label OR its set (known-issues #219,
 * 2026-10-30). The set rule alone misfiles the WNBA moments that sit in MIXED sets
 * (Fresh Gems, Level Up, Road To Royalty, Signature Style, Throne Room, Vintage
 * Vibes — 110 editions on the ≥ 50 % squeeze board at measurement), so a caller
 * that knows the edition's team passes the WNBA team labels it resolved from the
 * registry (`league_team_abbr('wnba')` + `get_teams_for_league('WNBA')`) and the
 * label decides first. An empty label set (a failed registry read) falls back to
 * the set rule — the pre-#219 behaviour, never a guess from a partial list.
 * The squeeze views' `league` column (20261031040755) applies the same OR in SQL.
 */
export function leagueForEdition(
  setName: string | null | undefined,
  teamName: string | null | undefined,
  wnbaTeamLabels: ReadonlySet<string>,
): "NBA" | "WNBA" | null {
  if (teamName && wnbaTeamLabels.has(teamName)) return "WNBA";
  return leagueForSetName(setName);
}
