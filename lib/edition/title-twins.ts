// lib/edition/title-twins.ts
//
// 2026-10-21 SEO pass, step 2. lib/edition-title-context.ts names the set,
// parallel, play, date and (All Day / Golazos) mint size, which took duplicate
// edition titles from 10,308 → 82 (Top Shot), 2,543 → 50 (All Day) and
// 188 → 88 (Golazos). What is left is not a missing field — it is editions that
// are GENUINELY identical on every field a title can name:
//   • Golazos 293 / 350: "GOAL by Abdón Prats", Knock Knock, 2023-01-07, /1500,
//     UNCOMMON — two plays (291 / 347), two different video captures.
//   • Top Shot 141:5149 / 141:5150 / 141:5177: Celtics Champion's Path 2024
//     Redemptions; two FANDOM /4347 and one RARE /999.
// So the tie-break is decided by the SIBLINGS, not by the edition alone: this
// reads the editions that would render the same title and returns the fewest
// words that separate this one — tier, then (Top Shot) mint size, then the
// edition number, which is unique by construction.
//
// Honesty: a FAILED or timed-out read returns null and the title renders
// exactly as before (a shared title is the status quo, not a false claim).
// Never a guessed tie-break.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { editionTitleContext } from "@/lib/edition-title-context"

export const TITLE_TWINS_TIMEOUT_MS = 2_000

type Payload = Record<string, unknown>

/** The collections whose titles carry play + date (the only ones measured). */
const TWIN_COLLECTIONS = new Set(["nba-top-shot", "nfl-all-day", "laliga-golazos"])

export interface TwinRow {
  external_id: string
  player_name: string | null
  team_name: string | null
  set_name: string | null
  play_category: string | null
  play_type: string | null
  game_date: string | null
  circulation_count: number | null
  tier: string | null
  subedition_name: string | null
  badges?: unknown
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

function titleCase(t: string): string {
  return t.toLowerCase().replace(/(^|[\s_-])([a-z])/g, (_m, a: string, b: string) => (a === "_" ? " " : a) + b.toUpperCase())
}

function rowPayload(r: TwinRow): Payload {
  return { ...r, route_slug: r.external_id }
}

/** Pure: the tie-break words for `self` against the rows that share its title. */
export function titleDisambiguator(self: Payload, rows: TwinRow[], collectionUrlSlug: string): string | null {
  if (!TWIN_COLLECTIONS.has(collectionUrlSlug)) return null
  const selfId = str(self.route_slug) ?? str(self.external_id)
  if (!selfId) return null
  const selfSubject = str(self.player_name) ?? str(self.team_name)
  const selfContext = editionTitleContext(self, collectionUrlSlug)
  let twins = rows.filter(
    (r) =>
      r.external_id !== selfId &&
      (str(r.player_name) ?? str(r.team_name)) === selfSubject &&
      editionTitleContext(rowPayload(r), collectionUrlSlug) === selfContext,
  )
  if (twins.length === 0) return null
  const parts: string[] = []
  const tier = str(self.tier)
  if (tier && twins.some((t) => str(t.tier) !== tier)) {
    parts.push(titleCase(tier))
    twins = twins.filter((t) => str(t.tier) === tier)
  }
  const circ = typeof self.circulation_count === "number" ? self.circulation_count : null
  if (twins.length && collectionUrlSlug === "nba-top-shot" && circ != null && circ > 0 && twins.some((t) => t.circulation_count !== circ)) {
    parts.push(`/${circ}`)
    twins = twins.filter((t) => t.circulation_count === circ)
  }
  if (twins.length) parts.push(`#${selfId}`)
  return parts.join(" · ")
}

/** Reads the siblings and returns the tie-break, or null (none needed, or the read failed). */
export async function fetchTitleDisambiguator(collectionId: string, payload: Payload, collectionUrlSlug: string): Promise<string | null> {
  if (!TWIN_COLLECTIONS.has(collectionUrlSlug)) return null
  const setName = str(payload.set_name)
  const player = str(payload.player_name)
  const team = str(payload.team_name)
  if (!setName || (!player && !team)) return null
  try {
    let q = supabaseAdmin
      .from("editions")
      .select("external_id,player_name,team_name,set_name,play_category,play_type,game_date,circulation_count,tier,subedition_name,badges")
      .eq("collection_id", collectionId)
      .eq("set_name", setName)
    q = player ? q.eq("player_name", player) : q.is("player_name", null).eq("team_name", team as string)
    const { data, error } = await withBoardBudget(
      Promise.resolve(q.order("external_id").limit(200)),
      "edition-title-twins",
      TITLE_TWINS_TIMEOUT_MS,
      "edition/",
    )
    if (error || !Array.isArray(data)) return null
    // At the cap the sibling set may be partial — no tie-break rather than one
    // computed over rows we did not all see.
    if (data.length >= 200) return null
    return titleDisambiguator(payload, data as TwinRow[], collectionUrlSlug)
  } catch {
    return null
  }
}
