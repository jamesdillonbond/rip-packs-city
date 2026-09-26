// Player-name resolution for the concierge (batch 55, 2026-09-25).
//
// A collector types a NAME; the catalog holds PEOPLE. Between the two sit
// every variation the crosswalk work surfaced: a first-name alias ("Joseph
// Flacco" → Joe Flacco), the league's spelling ("Mike Vick" → Michael Vick,
// "Kenny Gainwell" → Kenneth Gainwell), a suffix the user drops ("Patrick
// Surtain" → Patrick Surtain II), a name change ("Josh Allen" was the
// Jaguars edge rusher until 2024 — now Josh Hines-Allen — and is the Bills
// quarterback), and a father and son who share a name (Marvin Harrison /
// Marvin Harrison Jr., Gary Payton / Gary Payton II, Tim Hardaway / Jr.).
//
// public.resolve_player_name(collection, name) answers all of that in one
// read: 'one' with the person, their aliases, crosswalk identity (league id,
// ESPN id, seasons, latest team, whether stats exist), every RECORDED
// relation (parent_of / child_of / unrelated_namesake / also_known_as, from
// player_relations) and every namesake in the collection; 'ambiguous' with
// the candidates; 'none'. This module is the typed wrapper plus the compact
// shape the tools hand the model — and the FOURTH state the RPC cannot
// return: 'unavailable', a failed read, which the caller must never render
// as "no such player".

export type PlayerRelation = {
  relation: "parent_of" | "child_of" | "unrelated_namesake" | "also_known_as" | string
  name: string
  slug: string
  note: string | null
}

export type PlayerIdentity = {
  league: string
  league_player_id: string
  espn_id: string | null
  league_name: string
  league_name_differs: boolean
  position: string | null
  status: string | null
  rookie_season: number | null
  last_season: number | null
  latest_team: string | null
  matched_by: string | null
  stats_seasons: number
  stats_refreshed_at: string | null
} | null

export type PlayerSummary = {
  player: { id: string; name: string; slug: string; team: string | null; edition_count: number }
  aliases: Array<{ slug: string; note: string | null }>
  identity: PlayerIdentity
  relations: PlayerRelation[]
  matched_query_as: string
}

export type PlayerResolution =
  | ({ status: "one"; query: string; query_slug: string; matched_via: string; namesakes: PlayerSummary[]; note?: string } & PlayerSummary)
  | { status: "ambiguous"; query: string; query_slug: string; candidates: PlayerSummary[]; note: string }
  | { status: "none"; query: string; query_slug?: string; note?: string; reason?: string }
  | { status: "unavailable"; query: string; error: string }

/** One RPC read. A driver error is the fourth state, never 'none'. */
export async function resolvePlayerName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  collectionUuid: string | null,
  name: string,
): Promise<PlayerResolution> {
  const query = String(name ?? "").trim()
  if (!collectionUuid) return { status: "unavailable", query, error: "no collection in scope" }
  if (!query) return { status: "none", query, reason: "empty name" }
  try {
    const { data, error } = await supabase.rpc("resolve_player_name", { p_collection_id: collectionUuid, p_name: query })
    if (error) return { status: "unavailable", query, error: String(error.message ?? error) }
    if (!data || typeof data !== "object" || typeof data.status !== "string") {
      return { status: "unavailable", query, error: "resolver returned no verdict" }
    }
    return data as PlayerResolution
  } catch (err) {
    return { status: "unavailable", query, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Slugs compare with a trailing dash folded: the site keeps the dash a trailing "." leaves ("marvin-harrison-jr-"), the query slug does not. */
const sameSlug = (a: string, b: string): boolean => a.replace(/-+$/, "") === b.replace(/-+$/, "")

/** The relation between the resolved player and one namesake, as the model should read it. */
function relationLabel(resolved: PlayerSummary, other: PlayerSummary, querySlug: string): string {
  const fromResolved = resolved.relations.find((r) => sameSlug(r.slug, other.player.slug))
  if (fromResolved) {
    if (fromResolved.relation === "parent_of") return `${other.player.name} is the CHILD of ${resolved.player.name}`
    if (fromResolved.relation === "child_of") return `${other.player.name} is the PARENT of ${resolved.player.name}`
    if (fromResolved.relation === "unrelated_namesake") return `${other.player.name} is UNRELATED to ${resolved.player.name} (same name only)`
  }
  const aka = other.relations.find((r) => r.relation === "also_known_as" && sameSlug(r.slug, querySlug))
  if (aka) return `${other.player.name} also played under the name "${aka.name}" — ${aka.note ?? "a recorded name change"}`
  return `${other.player.name} shares the base name; kinship NOT recorded — do not assert a relation`
}

function compactIdentity(i: PlayerIdentity) {
  if (!i) return null
  return {
    league: i.league,
    league_player_id: i.league_player_id,
    espn_id: i.espn_id,
    league_name: i.league_name_differs ? i.league_name : undefined,
    position: i.position,
    seasons: i.rookie_season != null && i.last_season != null ? `${i.rookie_season}–${i.last_season}` : null,
    latest_team: i.latest_team,
    stats_available: i.stats_seasons > 0,
    stats_seasons: i.stats_seasons,
  }
}

function compactSummary(s: PlayerSummary) {
  return {
    name: s.player.name,
    player_slug: s.player.slug,
    team: s.player.team,
    edition_count: s.player.edition_count,
    matched_query_as: s.matched_query_as,
    identity: compactIdentity(s.identity),
    aliases: s.aliases.map((a) => a.slug),
    relations: s.relations.map((r) => ({ relation: r.relation, name: r.name, note: r.note })),
  }
}

/**
 * The block a player tool attaches so the model sees what the name alone
 * hides. Compact on purpose — it rides along with every get_player_editions
 * and get_fmv answer.
 */
export function identityContextFor(res: PlayerResolution): Record<string, unknown> {
  if (res.status === "unavailable") {
    return { status: "unavailable", note: `The player-identity read FAILED (${res.error}); aliases, namesakes and name changes could not be checked this call — say so if the name could be more than one person.` }
  }
  if (res.status === "none") return { status: "none", query: res.query, note: res.note ?? null }
  if (res.status === "ambiguous") {
    return { status: "ambiguous", query: res.query, candidates: res.candidates.map(compactSummary), note: res.note }
  }
  const warnings: string[] = []
  if (res.matched_via !== "exact") {
    const how: Record<string, string> = {
      alias: "a registered alias (another spelling of the same person)",
      league_spelling: "the league's spelling of the same person",
      former_name: "a name this person USED before a recorded name change",
      base_name: "the base name with the suffix (Jr./Sr./II) dropped or added",
      partial: "a partial that matches exactly one player in this collection",
    }
    warnings.push(`"${res.query}" resolved to ${res.player.name} via ${how[res.matched_via] ?? res.matched_via}. Say the catalog name when it differs from what the user typed.`)
  }
  if (res.identity?.league_name_differs) {
    warnings.push(`The league lists this player as "${res.identity.league_name}"; RPC labels the moments "${res.player.name}". Same person.`)
  }
  for (const r of res.relations) {
    if (r.relation === "also_known_as") warnings.push(`${res.player.name} has also gone by "${r.name}"${r.note ? ` — ${r.note}` : ""}.`)
  }
  const namesakes = res.namesakes.map((n) => ({ ...compactSummary(n), relation_to_resolved: relationLabel(res, n, res.query_slug) }))
  if (namesakes.length > 0) {
    warnings.push(`${namesakes.length === 1 ? "Another player shares" : `${namesakes.length} other players share`} this name in this collection — the answer below is for ${res.player.name} ONLY. If the user may have meant ${namesakes.map((n) => n.name).join(" or ")}, say which one you priced and offer the other; never pool them.`)
  }
  return {
    status: "one",
    query: res.query,
    matched_via: res.matched_via,
    resolved: compactSummary(res),
    namesakes,
    warnings,
  }
}
