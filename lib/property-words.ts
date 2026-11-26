// lib/property-words.ts
//
// Client-safe words for the league / brand level (2026-11-26). No DB imports — lib/panini/properties.ts and
// lib/candy/properties.ts are server-only (service role) and re-use these.

const SUBJECT_PLURALS: Record<string, string> = {
  player: "Players",
  driver: "Drivers",
  character: "Characters",
  artist: "Artists",
  superstar: "Superstars",
}

/** "Players" / "Characters" / "Artists" … — the word a league or brand uses for who is on its cards. */
export function subjectPlural(word: string | null | undefined): string {
  return SUBJECT_PLURALS[(word ?? "").toLowerCase()] ?? "Players"
}

const GROUP_PLURALS: Record<string, string> = {
  team: "Teams",
  nation: "Nations",
  club: "Clubs",
  clan: "Clans",
  school: "Schools",
}

/** "Teams" / "Nations" / "Clubs" / "Clans" — what a league or brand groups its cards by; null when it has none. */
export function groupPlural(word: string | null | undefined): string | null {
  return GROUP_PLURALS[(word ?? "").toLowerCase()] ?? null
}
