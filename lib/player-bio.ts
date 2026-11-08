// lib/player-bio.ts
//
// Shape + pure helpers for get_player_bio (migrations 20261108210431 / 20261108211235 /
// 20261108224157): one person's date of birth, birthplace, citizenship and college. ESPN's athlete
// record is the primary source (only when exactly one ESPN id is linked to the person); first-party
// and league sources fill gaps — Top Shot's on-chain moment metadata (player_birthdate /
// player_birthplace, "City, State, CTRY"), nflverse's birth_date, and the league's own athlete page
// (UFC.com, LALIGA — `official`, each row identity-verified by a second source before it is stored).
// No crowdsourced source (Wikidata, Wikipedia, fan databases) is read.
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
  /** The league's own athlete page (20261108224157). */
  official?: {
    source: "ufc.com" | "laliga.com" | string
    url: string | null
    date_of_birth: string | null
    birth_place: string | null
    verified_by: string | null
    fetched_at: string | null
  } | null
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

/** Collections whose players can carry a bio (Pinnacle characters cannot). UFC fighters link through ESPN search (20261108213822). */
export const PLAYER_BIO_COLLECTIONS = new Set(["nba_top_shot", "nfl_all_day", "candy_mlb", "laliga_golazos", "panini_blockchain", "ufc_strike"])

const OFFICIAL_LABEL: Record<string, string> = {
  "ufc.com": "UFC.com", "laliga.com": "LALIGA", "realmadrid.com": "Real Madrid", "fcbarcelona.com": "FC Barcelona",
}

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

// ESPN spells one country several ways across sports (NBA/NFL "USA", MLB "United States"); UFC.com
// says "United States" too.
const COUNTRY_ALIASES: Record<string, string> = { "united states": "USA", "united states of america": "USA", "us": "USA" }

function country(c: string | null): string | null {
  return c ? COUNTRY_ALIASES[c.toLowerCase()] ?? c : null
}

export function formatBirthplace(city: string | null, state: string | null, countryName: string | null): string | null {
  const parts = [clean(city), clean(state), country(clean(countryName))].filter((p): p is string => p != null)
  return parts.length > 0 ? parts.join(", ") : null
}

/** A league page's free-text place ("Galveston, TX, United States", "Montevideo") — the last part's country spelling normalised. */
export function formatOfficialBirthplace(raw: string | null | undefined): string | null {
  const parts = (raw ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) return null
  if (parts.length > 1) parts[parts.length - 1] = country(parts[parts.length - 1])!
  return parts.join(", ")
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
  const official = r.official ?? null
  const officialLabel = official ? OFFICIAL_LABEL[official.source] ?? official.source : null
  const sources = new Set<string>()

  // Measured 2026-11-08: ESPN and nflverse disagree on 34 of 1,382 All Day birth dates (same
  // person, different date — a year off, a day off, month/day swapped). The first source wins the
  // headline; a disagreeing source is named beside it rather than hidden.
  const dobs: Array<[string, string]> = []
  if (espn?.date_of_birth && ISO_DATE.test(espn.date_of_birth)) dobs.push(["ESPN", espn.date_of_birth.slice(0, 10)])
  if (official?.date_of_birth && officialLabel && ISO_DATE.test(official.date_of_birth)) dobs.push([officialLabel, official.date_of_birth.slice(0, 10)])
  if (r.onchain?.date_of_birth && ISO_DATE.test(r.onchain.date_of_birth)) dobs.push(["Top Shot on-chain", r.onchain.date_of_birth.slice(0, 10)])
  if (r.nflverse_date_of_birth && ISO_DATE.test(r.nflverse_date_of_birth)) dobs.push(["nflverse", r.nflverse_date_of_birth.slice(0, 10)])
  const dob = dobs[0]?.[1] ?? null
  if (dobs[0]) sources.add(dobs[0][0])
  const other = dobs.find(([, d]) => d !== dob)
  const dateOfBirthConflict = other ? `${other[0]} says ${formatBirthDate(other[1])}` : null

  let birthplace: string | null = null
  const espnPlace = espn ? formatBirthplace(espn.birth_city, espn.birth_state, espn.birth_country) : null
  const officialPlace = official ? formatOfficialBirthplace(official.birth_place) : null
  const chainPlace = formatOnchainBirthplace(r.onchain?.birthplace)
  if (espnPlace) { birthplace = espnPlace; sources.add("ESPN") }
  else if (officialPlace && officialLabel) { birthplace = officialPlace; sources.add(officialLabel) }
  else if (chainPlace) { birthplace = chainPlace; sources.add("Top Shot on-chain") }

  const citizenship = clean(espn?.citizenship)
  const college = clean(espn?.college)
  if (citizenship || college) sources.add("ESPN")

  const view: PlayerBioView = { dateOfBirth: formatBirthDate(dob), dateOfBirthConflict, birthplace, citizenship, college, sources: Array.from(sources) }
  return view.dateOfBirth || view.birthplace || view.citizenship || view.college ? view : null
}
