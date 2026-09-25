// lib/franchise-hub.ts
//
// Data layer for the franchise hub, /teams/<league>/<slug> (2026-09-23).
//
// A franchise hub is ONE page per real-world team that gathers every collection
// carrying that team. The registry is `teams_master` (the franchise) +
// `league_collections` (which collections carry a league), resolved in one call
// by `get_franchise_hub`. Each collection's numbers then come from the SAME
// `get_team_detail` the per-collection team page reads, so the hub can never
// disagree with the page it links to.
//
// ⚠ THREE STATES PER PANEL, never two. A collection panel is:
//   ok     — the read answered with this team's detail
//   empty  — the read answered NULL: this collection has no cards for the team
//   failed — we could not ask (error or budget). This must NOT render as
//            "no cards" — that would publish our timeout as a catalogue fact.
//
// ⚠ AND TWO STATES FOR THE HUB ITSELF: `{ hub: null, ok: true }` is "no such
// franchise" (404); `{ ok: false }` is "we could not ask" (a retryable page,
// never a 404 — a crawler must not learn a real franchise is gone).

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { fetchEntityDetailRaw, firstEntityRow, type EntityDetailResult } from "@/lib/entity-detail-gate"
import { getCollectionByUuid, type CollectionSlugInfo } from "@/lib/collection-slug"
import { isLeague, type League } from "@/lib/teams"

const HUB_TIMEOUT_MS = 4_000
const PANEL_TIMEOUT_MS = 10_000

export interface FranchiseHub {
  league: League
  team_slug: string
  team_name: string
  /** slugify(team_name) — the per-collection team page's URL key. */
  route_slug: string
  abbreviation: string | null
  external_id: string | null
  primary_color: string | null
  secondary_color: string | null
  collections: Array<{ collection_id: string; collection_slug: string }>
}

export interface FranchiseTeamDetail {
  team_name?: string | null
  player_count?: number | null
  edition_count?: number | null
  total_circulation?: number | null
  fmv_total_usd?: number | string | null
  floor_total_usd?: number | string | null
  sales_30d?: number | null
  volume_30d_usd?: number | string | null
}

export type HubPanel =
  | { state: "ok"; collection: CollectionSlugInfo; detail: FranchiseTeamDetail }
  | { state: "empty"; collection: CollectionSlugInfo }
  | { state: "failed"; collection: CollectionSlugInfo }

export interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

/** URL params -> a lookup key, or null when they cannot name a franchise. */
export function parseHubParams(rawLeague: string, rawSlug: string): { league: League; slug: string } | null {
  let slug: string
  try {
    slug = decodeURIComponent(rawSlug)
  } catch {
    return null
  }
  const league = rawLeague.toUpperCase()
  if (!isLeague(league)) return null
  // teams_master short slugs are lowercase ascii words joined by hyphens.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null
  return { league, slug }
}

/** Canonical path for a franchise hub. */
export function franchiseHubPath(league: string, teamSlug: string): string {
  return `/teams/${league.toLowerCase()}/${encodeURIComponent(teamSlug)}`
}

export async function fetchFranchiseHub(
  league: League,
  slug: string,
  db: RpcClient = supabaseAdmin as unknown as RpcClient,
): Promise<{ hub: FranchiseHub | null; ok: boolean }> {
  try {
    const { data, error } = await withBoardBudget(
      Promise.resolve(db.rpc("get_franchise_hub", { p_league: league, p_team_slug: slug })),
      `franchise-hub:${league}:${slug}`,
      HUB_TIMEOUT_MS,
      "teams/",
    )
    if (error) {
      console.error("[teams/franchise-hub] get_franchise_hub error:", error.message)
      return { hub: null, ok: false }
    }
    const row = firstEntityRow<FranchiseHub>(data)
    if (!row || typeof row !== "object" || !row.team_name) return { hub: null, ok: true }
    return { hub: { ...row, collections: Array.isArray(row.collections) ? row.collections : [] }, ok: true }
  } catch (e) {
    console.error("[teams/franchise-hub] get_franchise_hub bound:", e instanceof Error ? e.message : e)
    return { hub: null, ok: false }
  }
}

/**
 * One panel per enabled collection the app can route to. A mapped collection
 * the registry does not know (no URL slug) is SKIPPED, not rendered as empty —
 * we have nowhere to send the reader, and "no cards" would be a claim we did
 * not measure.
 */
export async function fetchHubPanels(
  hub: FranchiseHub,
  fetchDetail: (collectionId: string, slug: string) => Promise<EntityDetailResult> = (c, s) =>
    fetchEntityDetailRaw("team", c, s),
): Promise<HubPanel[]> {
  const routable = hub.collections
    .map((c) => getCollectionByUuid(c.collection_id))
    .filter((c): c is CollectionSlugInfo => c != null)
  return Promise.all(
    routable.map(async (collection): Promise<HubPanel> => {
      try {
        const { data, error } = await withBoardBudget(
          fetchDetail(collection.id, hub.route_slug),
          `franchise-panel:${collection.dbSlug}:${hub.route_slug}`,
          PANEL_TIMEOUT_MS,
          "teams/",
        )
        if (error) {
          console.error(`[teams/franchise-hub] panel ${collection.dbSlug} error:`, error.message)
          return { state: "failed", collection }
        }
        const detail = firstEntityRow<FranchiseTeamDetail>(data)
        if (!detail) return { state: "empty", collection }
        return { state: "ok", collection, detail }
      } catch (e) {
        console.error(`[teams/franchise-hub] panel ${collection.dbSlug} bound:`, e instanceof Error ? e.message : e)
        return { state: "failed", collection }
      }
    }),
  )
}

// ── Panel extras: top editions + recent sales per collection (2026-09-24) ──
//
// The hub's first cut showed five stat cells and a link. Trevor's brief for
// the chain-agnostic hubs ("a greater Blazers hub = Top Shot Moments + Panini
// cards") needs the CARDS on the hub, not a count of them. Each ok panel now
// also carries its top editions and most recent sales, read from the SAME RPCs
// the per-collection team page uses (`get_team_top_editions`,
// `get_team_activity`), so the hub cannot disagree with that page.
//
// ⚠ Both are DECORATIVE and THREE-STATE: `ok:false` means "could not ask" and
// renders as unavailable; `ok:true, rows:[]` is a measured absence.

export const HUB_TOP_EDITIONS = 6
export const HUB_RECENT_SALES = 6

export interface HubPanelExtras {
  topEditions: { rows: unknown[]; ok: boolean }
  activity: { rows: unknown[]; ok: boolean }
}

export type SectionFetcher = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ rows: unknown[]; ok: boolean }>

async function defaultSectionFetcher(fn: string, args: Record<string, unknown>): Promise<{ rows: unknown[]; ok: boolean }> {
  const { sectionRowsResult } = await import("@/lib/entity-section-rpc")
  const res = await sectionRowsResult<unknown>(`franchise-hub ${fn}`, fn, args)
  return { rows: res.rows, ok: res.ok }
}

/** Per ok-panel extras, keyed by collection id. Failed/empty panels get nothing. */
export async function fetchHubPanelExtras(
  hub: Pick<FranchiseHub, "route_slug">,
  panels: HubPanel[],
  fetchSection: SectionFetcher = defaultSectionFetcher,
): Promise<Map<string, HubPanelExtras>> {
  const out = new Map<string, HubPanelExtras>()
  await Promise.all(
    panels
      .filter((p) => p.state === "ok")
      .map(async (p) => {
        const args = { p_collection_id: p.collection.id, p_team_slug: hub.route_slug }
        const safe = async (fn: string, extra: Record<string, unknown>) => {
          try {
            const r = await withBoardBudget(
              fetchSection(fn, { ...args, ...extra }),
              `franchise-extra:${fn}:${p.collection.dbSlug}:${hub.route_slug}`,
              PANEL_TIMEOUT_MS,
              "teams/",
            )
            return { rows: Array.isArray(r.rows) ? r.rows : [], ok: r.ok === true }
          } catch (e) {
            console.error(`[teams/franchise-hub] ${fn} ${p.collection.dbSlug} bound:`, e instanceof Error ? e.message : e)
            return { rows: [], ok: false }
          }
        }
        const [topEditions, activity] = await Promise.all([
          safe("get_team_top_editions", { p_limit: HUB_TOP_EDITIONS, p_offset: 0 }),
          safe("get_team_activity", { p_limit: HUB_RECENT_SALES, p_offset: 0 }),
        ])
        out.set(p.collection.id, { topEditions, activity })
      }),
  )
  return out
}

/**
 * Index a hub only when it actually GATHERS something. A one-collection hub is
 * the per-collection team page with a different frame — indexing it would hand
 * search engines a near-duplicate of a page they already have.
 */
export function hubIsIndexable(hub: Pick<FranchiseHub, "collections">): boolean {
  return hub.collections.length >= 2
}
