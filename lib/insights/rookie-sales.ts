// lib/insights/rookie-sales.ts
//
// The 2026 NBA rookie class on Top Shot, ranked by marketplace sales SINCE RELEASE across every
// edition of each rookie, with the draft pick, the season's per-game line and a standard Rookie
// Debut moment for the image. Backs /api/public/insights/rookie-sales and the @RipPacksCity
// Wednesday rookie post (Trevor, 11-14: the top-10 post he ran that day, made weekly).
//
// Why not /api/public/insights/rookies: that board's views are 30-day windows. The first 2026
// rookie sale was 10-22, so "since release" and "30 days" part ways from 11-21 on.
//
// Population and joins — each one is a claim, so each is stated:
//   • Cohort = `topshot_2026_rookie_players` (the same list the rookies board uses).
//   • Editions = every Top Shot edition whose player_name is a cohort name (parallels included —
//     "across all of their editions").
//   • Sales = every `sales` row on those editions with price_usd > 0, all time.
//   • Image = a sold moment of the player's STANDARD Rookie Debut edition: set_name 'Rookie Debut'
//     and an external_id with no '::' (a parallel's key is '<set>:<play>::<parallel>'). Trevor,
//     11-14: "use their standard Rookie Debut moment image, some seem to use parallel images".
//   • Season line = ESPN box scores (player_game_stats), regular season, the newest season present,
//     games actually played (did_not_play rows excluded). The ESPN athlete is matched by exact
//     display name; a name with zero or several ESPN athletes gets NO season line (null), never
//     one of them.
//   • Draft pick = lib/insights/draft-2026.ts (null = not drafted in 2026).
//
// Every read is paged past PostgREST's 1,000-row cap, and a failed or truncated read THROWS —
// a partial count must never publish as the class total.

import { fetchAllPaged } from "@/lib/supabase-paginate"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { draftPick2026 } from "@/lib/insights/draft-2026"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const TOP_SHOT = COLLECTION_UUID_BY_SLUG["nba-top-shot"]

export type EditionRow = { id: string; player_name: string; team_name: string | null; external_id: string; set_name: string | null }
export type SaleRow = { id: string; edition_id: string; price_usd: number | string; nft_id: string | null; sold_at: string }
export type AthleteRow = { espn_id: string; display_name: string }
export type GameRow = {
  espn_id: string
  event_id: string
  game_date: string
  season: number
  season_type: number
  did_not_play: boolean | null
  stats: Record<string, string> | null
}

export type SeasonLine = { games: number; ppg: number; rpg: number; apg: number; through: string | null }

export type RookieSalesRow = {
  rank: number
  player_name: string
  team_name: string | null
  draft_pick: number | null
  sales: number
  gmv_usd: number
  first_sale_at: string | null
  image_nft_id: string | null
  season: SeasonLine | null
}

export type RookieSalesBoard = {
  rows: RookieSalesRow[]
  totals: { players: number; sales: number; gmv_usd: number }
  latest_sale_at: string | null
  stats_season: number | null
  stats_through: string | null
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/** True for a STANDARD Rookie Debut edition (not a parallel). */
export function isStandardRookieDebut(e: Pick<EditionRow, "external_id" | "set_name">): boolean {
  return e.set_name === "Rookie Debut" && !String(e.external_id).includes("::")
}

/** Pure: build the ranked board from the four reads. Exported for tests. */
export function buildRookieSalesBoard(input: {
  cohort: string[]
  editions: EditionRow[]
  sales: SaleRow[]
  athletes: AthleteRow[]
  games: GameRow[]
}): RookieSalesBoard {
  const cohort = new Set(input.cohort)
  const edById = new Map(input.editions.filter((e) => cohort.has(e.player_name)).map((e) => [e.id, e]))

  type Acc = { team: string | null; sales: number; gmv: number; first: string | null; img: { nft: string; at: string } | null }
  const acc = new Map<string, Acc>()
  for (const name of cohort) acc.set(name, { team: null, sales: 0, gmv: 0, first: null, img: null })
  // Team: the newest edition's team is no better than any other for a rookie, so take any non-null.
  for (const e of edById.values()) {
    const a = acc.get(e.player_name)!
    if (!a.team && e.team_name) a.team = e.team_name
  }
  let latest: string | null = null
  for (const s of input.sales) {
    const e = edById.get(s.edition_id)
    const price = Number(s.price_usd)
    if (!e || !(price > 0)) continue
    const a = acc.get(e.player_name)!
    a.sales += 1
    a.gmv += price
    if (!a.first || s.sold_at < a.first) a.first = s.sold_at
    if (!latest || s.sold_at > latest) latest = s.sold_at
    if (s.nft_id && isStandardRookieDebut(e) && (!a.img || s.sold_at > a.img.at)) a.img = { nft: s.nft_id, at: s.sold_at }
  }

  // ESPN match: exactly one athlete per display name, or none.
  const idsByName = new Map<string, string[]>()
  for (const a of input.athletes) idsByName.set(a.display_name, [...(idsByName.get(a.display_name) ?? []), a.espn_id])
  const regular = input.games.filter((g) => g.season_type === 2)
  const season = regular.length ? Math.max(...regular.map((g) => g.season)) : null
  const played = regular.filter((g) => g.season === season && !g.did_not_play && g.stats)
  const byEspn = new Map<string, GameRow[]>()
  for (const g of played) byEspn.set(g.espn_id, [...(byEspn.get(g.espn_id) ?? []), g])
  let through: string | null = null
  for (const g of played) if (!through || g.game_date > through) through = g.game_date

  const seasonLine = (name: string): SeasonLine | null => {
    const ids = idsByName.get(name) ?? []
    if (ids.length !== 1) return null
    const gs = byEspn.get(ids[0]) ?? []
    if (!gs.length) return null
    const avg = (k: string) => round1(gs.reduce((t, g) => t + (Number(g.stats?.[k]) || 0), 0) / gs.length)
    const last = gs.reduce((m, g) => (g.game_date > m ? g.game_date : m), gs[0].game_date)
    return { games: gs.length, ppg: avg("points"), rpg: avg("rebounds"), apg: avg("assists"), through: last }
  }

  const rows = [...acc.entries()]
    .map(([player_name, a]) => ({
      rank: 0,
      player_name,
      team_name: a.team,
      draft_pick: draftPick2026(player_name),
      sales: a.sales,
      gmv_usd: round2(a.gmv),
      first_sale_at: a.first,
      image_nft_id: a.img?.nft ?? null,
      season: seasonLine(player_name),
    }))
    .sort((x, y) => y.gmv_usd - x.gmv_usd || y.sales - x.sales || x.player_name.localeCompare(y.player_name))
    .map((r, i) => ({ ...r, rank: i + 1 }))

  return {
    rows,
    totals: {
      players: rows.length,
      sales: rows.reduce((t, r) => t + r.sales, 0),
      gmv_usd: round2(rows.reduce((t, r) => t + r.gmv_usd, 0)),
    },
    latest_sale_at: latest,
    stats_season: season,
    stats_through: through,
  }
}

function must<T>(label: string, r: { rows: T[]; truncated: boolean; error: string | null }): T[] {
  if (r.error) throw new Error(`${label}: ${r.error}`)
  if (r.truncated) throw new Error(`${label}: read truncated (page cap hit) — refusing a partial total`)
  return r.rows
}

/** Read the 2026 rookie class's since-release sales board. Throws on any failed or partial read. */
export async function fetchRookieSales2026(db: Db): Promise<RookieSalesBoard> {
  const cohortRes = await db.from("topshot_2026_rookie_players").select("player_name").order("player_name").limit(500)
  if (cohortRes.error) throw new Error(`topshot_2026_rookie_players: ${cohortRes.error.message}`)
  const cohort: string[] = (cohortRes.data ?? []).map((r: { player_name: string }) => r.player_name)
  if (!cohort.length) return buildRookieSalesBoard({ cohort, editions: [], sales: [], athletes: [], games: [] })

  const editions = must<EditionRow>(
    "editions",
    await fetchAllPaged<EditionRow>(
      (from, to) =>
        db.from("editions").select("id, player_name, team_name, external_id, set_name")
          .eq("collection_id", TOP_SHOT).in("player_name", cohort).order("id").range(from, to),
      { label: "rookie-sales/editions" },
    ),
  )
  const edIds = editions.map((e) => e.id)

  const [salesRes, athletesRes] = await Promise.all([
    edIds.length
      ? fetchAllPaged<SaleRow>(
          (from, to) =>
            db.from("sales").select("id, edition_id, price_usd, nft_id, sold_at")
              .in("edition_id", edIds).gt("price_usd", 0).order("id").range(from, to),
          { label: "rookie-sales/sales", maxPages: 200 },
        )
      : Promise.resolve({ rows: [] as SaleRow[], truncated: false, error: null }),
    fetchAllPaged<AthleteRow>(
      (from, to) =>
        db.from("espn_athletes").select("espn_id, display_name")
          .eq("league", "nba").in("display_name", cohort).order("espn_id").range(from, to),
      { label: "rookie-sales/espn_athletes" },
    ),
  ])
  const sales = must("sales", salesRes)
  const athletes = must("espn_athletes", athletesRes)

  const espnIds = [...new Set(athletes.map((a) => a.espn_id))]
  const games = espnIds.length
    ? must<GameRow>(
        "player_game_stats",
        await fetchAllPaged<GameRow>(
          (from, to) =>
            db.from("player_game_stats").select("espn_id, event_id, game_date, season, season_type, did_not_play, stats")
              .eq("league", "nba").eq("season_type", 2).in("espn_id", espnIds)
              .order("event_id").order("espn_id").order("category").range(from, to),
          { label: "rookie-sales/player_game_stats", maxPages: 50 },
        ),
      )
    : []

  return buildRookieSalesBoard({ cohort, editions, sales, athletes, games })
}
