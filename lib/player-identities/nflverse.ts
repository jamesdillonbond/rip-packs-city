// lib/player-identities/nflverse.ts — the NFL half of the league-id crosswalk.
//
// 2026-09-25 (#139 follow-up). NFL All Day keys players on a NAME slug, and its
// labels drift ("Patrick Mahomes II" → "Patrick Mahomes"; the Colts "Marvin
// Harrison" and the Cardinals "Marvin Harrison" on one row). The NFL publishes
// a player id — the GSIS id — and the open nflverse `players.csv` (a GitHub
// release, refreshed weekly) carries it for every player with the NFL.com
// spelling, birth date, latest team, seasons and the ESPN / PFR ids a stats
// feed joins on. Measured 2026-09-25: 24,830 rows, 7.2 MB, 200 from the cloud
// sandbox and the laptop VM.
//
// This module is the pure part: parse the CSV, shape the rows the
// upsert_player_identities RPC takes. It THROWS when the header lacks the two
// columns the crosswalk cannot exist without — a changed upstream schema is a
// failed read, not an empty one (honesty canon: a failed read must not render
// as zero rows).

export const NFLVERSE_PLAYERS_CSV_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"

export interface IdentityRow {
  league_player_id: string
  display_name: string
  first_name: string | null
  last_name: string | null
  birth_date: string | null
  position: string | null
  latest_team: string | null
  rookie_season: number | null
  last_season: number | null
  status: string | null
  espn_id: string | null
  pfr_id: string | null
  nfl_id: string | null
  headshot_url: string | null
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. No embedded-newline surprises in nflverse, but handled. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      field = ""
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const REQUIRED = ["gsis_id", "display_name"] as const

function blankToNull(v: string | undefined): string | null {
  if (v == null) return null
  const t = v.trim()
  return t === "" || t === "NA" ? null : t
}

function intOrNull(v: string | undefined): number | null {
  const t = blankToNull(v)
  if (t == null) return null
  const n = Number(t)
  return Number.isInteger(n) ? n : null
}

/** ISO date or null — nflverse writes YYYY-MM-DD; anything else is not a date we will store. */
function dateOrNull(v: string | undefined): string | null {
  const t = blankToNull(v)
  if (t == null) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null
}

export interface NflverseParse {
  rows: IdentityRow[]
  /** data lines the file carried (header excluded) */
  source_rows: number
  /** lines dropped for lacking a GSIS id or a display name */
  skipped: number
}

export function nflverseToIdentityRows(csv: string): NflverseParse {
  const table = parseCsv(csv)
  if (table.length === 0) throw new Error("nflverse players.csv: empty file")
  const header = table[0].map((h) => h.trim())
  const col = new Map<string, number>()
  header.forEach((h, i) => col.set(h, i))
  for (const r of REQUIRED) {
    if (!col.has(r)) throw new Error(`nflverse players.csv: header lacks "${r}" (got ${header.length} columns)`)
  }
  const at = (line: string[], name: string): string | undefined => {
    const i = col.get(name)
    return i == null ? undefined : line[i]
  }

  const rows: IdentityRow[] = []
  let skipped = 0
  let source_rows = 0
  for (let i = 1; i < table.length; i++) {
    const line = table[i]
    if (line.length === 1 && line[0] === "") continue // trailing blank line
    source_rows++
    const id = blankToNull(at(line, "gsis_id"))
    const name = blankToNull(at(line, "display_name"))
    if (id == null || name == null) {
      skipped++
      continue
    }
    rows.push({
      league_player_id: id,
      display_name: name,
      first_name: blankToNull(at(line, "first_name")),
      last_name: blankToNull(at(line, "last_name")),
      birth_date: dateOrNull(at(line, "birth_date")),
      position: blankToNull(at(line, "position")),
      latest_team: blankToNull(at(line, "latest_team")),
      rookie_season: intOrNull(at(line, "rookie_season")),
      last_season: intOrNull(at(line, "last_season")),
      status: blankToNull(at(line, "status")),
      espn_id: blankToNull(at(line, "espn_id")),
      pfr_id: blankToNull(at(line, "pfr_id")),
      nfl_id: blankToNull(at(line, "nfl_id")),
      headshot_url: blankToNull(at(line, "headshot")),
    })
  }
  return { rows, source_rows, skipped }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk: size must be positive")
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
