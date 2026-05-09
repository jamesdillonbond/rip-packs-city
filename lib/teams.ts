// lib/teams.ts
//
// Shared types for the structured favorite-team system. Replaces the legacy
// free-text `profile_bio.favorite_team` field with per-league dropdown picks
// backed by `teams_master` and `user_favorite_teams`.

export type League = "NBA" | "WNBA" | "NFL" | "LALIGA";

export const LEAGUES: ReadonlyArray<{ value: League; label: string; emoji: string }> = [
  { value: "NBA",    label: "NBA",     emoji: "🏀" },
  { value: "WNBA",   label: "WNBA",    emoji: "🏀" },
  { value: "NFL",    label: "NFL",     emoji: "🏈" },
  { value: "LALIGA", label: "LaLiga",  emoji: "⚽" },
];

export function isLeague(value: unknown): value is League {
  return value === "NBA" || value === "WNBA" || value === "NFL" || value === "LALIGA";
}

// Row returned from get_teams_for_league(p_league) — used to populate the
// per-league dropdowns on the edit-profile page.
export interface TeamMaster {
  slug: string;
  team_name: string;
  abbreviation: string;
  external_id: string | null;
  primary_color: string;
  secondary_color: string;
  has_moments: boolean;
}

// A user's selected favorite team for a single league. The full set is
// projected through user_favorite_teams JOIN teams_master.
export interface UserFavoriteTeam {
  league: League;
  team_slug: string;
  team_name: string;
  abbreviation: string;
  primary_color: string;
  is_primary: boolean;
}

// Row returned from get_team_fan_leaderboard(p_league) — fan_count is the
// total number of users who picked this team in any slot, primary_fan_count
// counts only those who marked it as their cross-league primary.
export interface LeaderboardEntry {
  rank: number;
  team_slug: string;
  team_name: string;
  abbreviation: string;
  primary_color: string;
  secondary_color: string;
  external_id: string | null;
  fan_count: number;
  primary_fan_count: number;
}
