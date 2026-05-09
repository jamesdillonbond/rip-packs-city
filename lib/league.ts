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
