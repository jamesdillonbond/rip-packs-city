// lib/player-bio.ts
//
// Shape + pure helpers for get_player_bio (migrations 20261108210431 / 20261108211235): one
// person's date of birth, birthplace, citizenship and college. ESPN's athlete record is the
// primary source (only when exactly one ESPN id is linked to the person); two first-party
// fallbacks already in the database fill gaps — Top Shot's on-chain moment metadata
// (player_birthdate / player_birthplace, "City, State, CTRY") and nflverse's birth_date.
//
// Honesty: every field is shown only when a source states it. A missing college means "ESPN
// names none", never "did not attend"; citizenship is never shown as a country of birth.

export interface PlayerBioResult {
  linked: number
  espn: {
    espn_id: string
    date_of_birth: string | null
    birth_city: string | null
    birth_state: string | null
    birth_country: string | null
    citizenship?: string | null
    college: string | null
    college_id: string | null
    fetched_at: string | null
  } | null
  onchain: { date_of_birth: string | null; birthplace: string | null } | null
  nflverse_date_of_birth: string | null
}

export interface PlayerBioView {
  dateOfBirth: string | null
  /** Another source states a DIFFERENT date of birth — shown beside it, never silently dropped. */
  dateOfBirthConflict: string | null
  birthplace: string | null
  citizenship: string | null
  college: string | null
  sources: string[]
}

/** Collections whose players can carry a bio (Pinnacle characters cannot; UFC has no person link yet). */
export const PLAYER_BIO_COLLECTIONS = new Set(["nba_top_shot", "nfl_all_day", "candy_mlb", "laliga_golazos", "panini_blockchain"])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim()
  return t.length > 0 ? t : null
}

/** "Zurich,, CHE" / "Akron, OH, USA" → "Zurich, CHE" / "Akron, OH, USA" (empty parts dropped). */
export function formatOnchainBirthplace(raw: string | null | undefined): string | null {
  const parts = (raw ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0)
  return parts.length > 0 ? parts.join(", ") : null
}

export function formatBirthplace(city: string | null, state: string | null, country: string | null): string | null {
  const parts = [clean(city), clean(state), clean(country)].filter((p): p is string => p != null)
  return parts.length > 0 ? parts.join(", ") : null
}

/** "1998-03-03" → "March 3, 1998" (UTC — a calendar date, never shifted by a viewer's zone). */
export function formatBirthDate(iso: string | null | undefined): string | null {
  if (!iso || !ISO_DATE.test(iso)) return null
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
}

/** One view from the sources, ESPN first, field by field. Null when no source states anything. */
export function buildPlayerBio(r: PlayerBioResult | null): PlayerBioView | null {
  if (!r) return null
  const espn = r.linked === 1 ? r.espn : null
  const sources = new Set<string>()

  // Measured 2026-11-08: ESPN and nflverse disagree on 34 of 1,382 All Day birth dates (same
  // person, different date — a year off, a day off, month/day swapped). The first source wins the
  // headline; a disagreeing source is named beside it rather than hidden.
  const dobs: Array<[string, string]> = []
  if (espn?.date_of_birth && ISO_DATE.test(espn.date_of_birth)) dobs.push(["ESPN", espn.date_of_birth.slice(0, 10)])
  if (r.onchain?.date_of_birth && ISO_DATE.test(r.onchain.date_of_birth)) dobs.push(["Top Shot on-chain", r.onchain.date_of_birth.slice(0, 10)])
  if (r.nflverse_date_of_birth && ISO_DATE.test(r.nflverse_date_of_birth)) dobs.push(["nflverse", r.nflverse_date_of_birth.slice(0, 10)])
  const dob = dobs[0]?.[1] ?? null
  if (dobs[0]) sources.add(dobs[0][0])
  const other = dobs.find(([, d]) => d !== dob)
  const dateOfBirthConflict = other ? `${other[0]} says ${formatBirthDate(other[1])}` : null

  let birthplace: string | null = null
  const espnPlace = espn ? formatBirthplace(espn.birth_city, espn.birth_state, espn.birth_country) : null
  if (espnPlace) { birthplace = espnPlace; sources.add("ESPN") }
  else {
    const chain = formatOnchainBirthplace(r.onchain?.birthplace)
    if (chain) { birthplace = chain; sources.add("Top Shot on-chain") }
  }

  const citizenship = clean(espn?.citizenship)
  const college = clean(espn?.college)
  if (citizenship || college) sources.add("ESPN")

  const view: PlayerBioView = { dateOfBirth: formatBirthDate(dob), dateOfBirthConflict, birthplace, citizenship, college, sources: Array.from(sources) }
  return view.dateOfBirth || view.birthplace || view.citizenship || view.college ? view : null
}
