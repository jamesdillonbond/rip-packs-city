// lib/insights/squeeze-board.ts
//
// The single query behind the Top Shot lock-rate squeeze board, shared by BOTH
// consumers: `app/insights/squeeze/page.tsx` (server-renders the default view so
// the ranked rows and their per-edition drill-down links are crawlable) and
// `app/api/public/insights/squeeze/route.ts` (the client's filtered refetches).
//
// Same rationale as lib/insights/allday-scarcity-board.ts, which this follows:
// both consumers carried their own copy of the query and the page's comment
// claimed it read the view "exactly as the API route does" — a claim nothing
// enforced. The copies were verified equivalent when this was extracted
// (2026-08-15), so this fixes no live defect; it removes the way they drift.
// Adding a column to the route alone would leave the SERVER-RENDERED html
// missing it while the client's first refetch silently filled it in.
//
// It also takes the page off `__tests__/server-page-data-access-ratchet.test.ts`,
// which is the other half: `app/**/page.tsx` is measured by NEITHER coverage
// gate, so the page's copy was untestable where the route's is not.
//
// ⚠ DEFAULTS ARE NOT SHARED, DELIBERATELY. The page pins `limit: 200` and
// `minSqueeze: 50`; the route defaults to `limit: 50` for a direct API caller.
// That looks like drift and is not — the client refetches with its own explicit
// limit. This module owns the QUERY, not the policy.

import { supabaseAdmin } from "@/lib/supabase"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Columns both consumers select. Duplicating this list was the drift risk. */
export const SQUEEZE_COLS =
  "edition_id, external_id, player_name, set_name, tier, circulation, locked, burned, lock_pct, burn_pct, squeeze_pct, effectively_buyable, low_ask, low_ask_disconnected, fmv_usd, confidence, game_date, thumbnail_url, team_name"

/** Top Shot's collection row — the only collection this board serves. */
export const SQUEEZE_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

export interface TeamResolution {
  /** "one" = a franchise; "many" = several matched (all their labels are used); "none" = no team label matched. */
  status: "one" | "many" | "none"
  /** Every team_name label the matched franchise(s) have minted under (historic names included). */
  labels: string[]
  /** The franchise's current name, when exactly one matched. */
  currentName: string | null
}

/**
 * Resolve a typed team to its FRANCHISE's labels through resolve_team_name()
 * (beta feedback 10253, 2026-10-03). A team label is not a franchise: "LA
 * Clippers", "Los Angeles Clippers" and "Buffalo Braves" are one team, so a
 * filter on the typed label alone would silently drop the historic eras
 * (CLAUDE.md concierge rule 2). Several franchises matching ("New York") all
 * count — the board then shows all of them, the same breadth the player ilike
 * gives. No match → `none` with no labels; the caller answers an honest empty
 * board naming the query, never the unfiltered one. A failed RPC is returned
 * as an error, never as "no team".
 */
export async function resolveSqueezeTeam(
  team: string,
  db: Db = supabaseAdmin,
): Promise<{ data: TeamResolution | null; error: { message: string } | null }> {
  const { data, error } = await db.rpc("resolve_team_name", { p_collection_id: SQUEEZE_COLLECTION_ID, p_name: team })
  if (error) return { data: null, error }
  // Shapes (measured 2026-10-03): status "one" carries `names[]` + `current_name`;
  // status "ambiguous" carries `franchises[]`, each with its own `names[]`;
  // status "none" carries nothing. Anything else is treated as no match.
  const r = (data ?? {}) as {
    status?: string
    names?: { team_name?: string }[]
    current_name?: string | null
    franchises?: { names?: { team_name?: string }[] }[]
  }
  const fromNames = (ns: { team_name?: string }[] | undefined) =>
    (ns ?? []).map((n) => n.team_name).filter((x): x is string => typeof x === "string" && x.trim() !== "")
  if (r.status === "one") return { data: { status: "one", labels: fromNames(r.names), currentName: r.current_name ?? null }, error: null }
  if (r.status === "ambiguous") {
    const labels = [...new Set((r.franchises ?? []).flatMap((f) => fromNames(f.names)))]
    return { data: { status: "many", labels, currentName: null }, error: null }
  }
  return { data: { status: "none", labels: [], currentName: null }, error: null }
}

export interface SqueezeBoardOptions {
  tier?: string | null
  set?: string | null
  player?: string | null
  /** Floor on squeeze_pct. The board's whole premise, so it has no null default. */
  minSqueeze?: number
  maxBuyable?: number | null
  maxCirculation?: number | null
  /** Floor on circulation — hides 1/1s and other ultra-low mints that are 100 % squeezed by arithmetic (beta feedback 10250/10252). */
  minCirculation?: number | null
  /** Floor on effectively_buyable — same ask, on the supply that is actually buyable. */
  minBuyable?: number | null
  /** team_name labels to keep (a franchise's every label — see resolveSqueezeTeam). An EMPTY list matches nothing. */
  teamNames?: string[] | null
  sort?: string
  limit: number
}


/**
 * Build and run the board query.
 *
 * Returns supabase-js's `{ data, error }` UNTOUCHED so each caller keeps its own
 * failure policy: the route needs `boardUnavailable(error, …)` to publish a 503
 * without leaking the driver message, the page needs `ok:false` to render the
 * degraded notice. Normalising here would force one of them to re-derive what
 * it lost.
 */
export async function fetchSqueezeBoard(
  opts: SqueezeBoardOptions,
  db: Db = supabaseAdmin,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const {
    tier = null,
    set = null,
    player = null,
    minSqueeze = 50,
    maxBuyable = null,
    maxCirculation = null,
    minCirculation = null,
    minBuyable = null,
    teamNames = null,
    sort = "squeeze",
    limit,
  } = opts

  let q = db.from("topshot_squeeze_board").select(SQUEEZE_COLS).gte("squeeze_pct", minSqueeze)

  if (tier) q = q.eq("tier", tier.toUpperCase())
  if (set) q = q.ilike("set_name", `%${set}%`)
  if (player) q = q.ilike("player_name", `%${player}%`)
  if (maxBuyable != null && Number.isFinite(maxBuyable)) q = q.lte("effectively_buyable", maxBuyable)
  if (maxCirculation != null && Number.isFinite(maxCirculation)) q = q.lte("circulation", maxCirculation)
  if (minCirculation != null && Number.isFinite(minCirculation)) q = q.gte("circulation", minCirculation)
  if (minBuyable != null && Number.isFinite(minBuyable)) q = q.gte("effectively_buyable", minBuyable)
  // A resolved team with NO labels must match nothing — never fall through to
  // the unfiltered board (a filter that silently widens is the #146 shape).
  if (teamNames != null) q = q.in("team_name", teamNames)

  // ⚠ EVERY sort carries a SECONDARY ordering, and they are not decoration.
  // Without a tiebreak, rows equal on the primary key order arbitrarily, so the
  // server-rendered html and the client's first refetch can disagree on row
  // order for identical data — a flash that looks like the board reshuffling
  // itself. The squeeze_pct secondary also does real work on the non-default
  // sorts: it surfaces trophy-circ editions above commons at the same value.
  if (sort === "circulation") {
    q = q.order("circulation", { ascending: true }).order("squeeze_pct", { ascending: false })
  } else if (sort === "fmv") {
    q = q
      .order("fmv_usd", { ascending: false, nullsFirst: false })
      .order("squeeze_pct", { ascending: false })
  } else if (sort === "buyable") {
    q = q.order("effectively_buyable", { ascending: true }).order("squeeze_pct", { ascending: false })
  } else {
    q = q.order("squeeze_pct", { ascending: false }).order("circulation", { ascending: true })
  }

  return q.limit(limit)
}
