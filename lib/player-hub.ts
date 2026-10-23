// lib/player-hub.ts
//
// Data layer for the player hub, /players/<slug> (2026-10-22).
//
// A player hub is ONE page per player name that gathers every collection
// carrying it: Damian Lillard = Top Shot Moments + Panini cards. Before it,
// searching "damian lillard" listed two separate player rows and Enter opened
// whichever scored higher (Panini, by 0.012).
//
// The registry is `get_player_hub(slug)` (migration 20261023053026). Each
// collection's numbers then come from the SAME `get_player_detail` /
// `get_player_editions` the per-collection player page reads, so the hub can
// never disagree with the page it links to.
//
// ⚠ A NAME IS NOT A PERSON (CLAUDE.md concierge rule 2). No person key spans
// collections (Panini carries no player_identities), so the hub matches by
// NAME and the page GROUPS BY SPORT: /players/larry-johnson is a Top Shot
// basketball player and an All Day + Panini football player, two people. The
// page says so rather than stacking them as one.
//
// ⚠ THREE STATES PER PANEL, never two: ok · empty (the read answered NULL) ·
// failed (could not ask — never rendered as "no editions").
// ⚠ TWO STATES FOR THE HUB: `{ hub: null, ok: true }` is "no such player" (404);
// `{ ok: false }` is "could not ask" (retryable, never a 404).

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { fetchEntityDetailRaw, firstEntityRow, type EntityDetailResult } from "@/lib/entity-detail-gate"
import { getCollectionByDbSlug, type CollectionSlugInfo } from "@/lib/collection-slug"

const HUB_TIMEOUT_MS = 4_000
const PANEL_TIMEOUT_MS = 10_000

export const PLAYER_HUB_TOP_EDITIONS = 6

export interface PlayerHubCollection {
  collection_id: string
  /** long-form DB slug ("nba_top_shot") */
  collection_slug: string
  /** the player's name AS THIS COLLECTION SPELLS IT ("Steph Curry" vs "Stephen Curry") */
  name: string
  /** the per-collection /player/<slug> key */
  player_slug: string
  edition_count: number
  headshot_url: string | null
  /** basketball | football | soccer | baseball | mma | racing; [] when unknown */
  sports: string[]
}

export interface PlayerHub {
  slug: string
  canonical_slug: string
  name: string
  collections: PlayerHubCollection[]
}

export interface PlayerHubDetail {
  name?: string | null
  team?: string | null
  edition_count?: number | null
  total_circulation?: number | null
  fmv_total_usd?: number | string | null
  fmv_ask_derived_usd?: number | string | null
  floor_total_usd?: number | string | null
}

export type PlayerHubPanel =
  | { state: "ok"; collection: CollectionSlugInfo; entry: PlayerHubCollection; detail: PlayerHubDetail }
  | { state: "empty"; collection: CollectionSlugInfo; entry: PlayerHubCollection }
  | { state: "failed"; collection: CollectionSlugInfo; entry: PlayerHubCollection }

export interface SportGroup {
  sport: string
  label: string
  entries: PlayerHubCollection[]
}

export interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

const SPORT_LABELS: Record<string, string> = {
  basketball: "Basketball",
  football: "Football",
  soccer: "Soccer",
  baseball: "Baseball",
  mma: "MMA",
  racing: "Racing",
}

export function sportLabel(sport: string): string {
  return SPORT_LABELS[sport] ?? (sport ? sport.charAt(0).toUpperCase() + sport.slice(1) : "Other")
}

/**
 * A URL segment -> a lookup slug, or null when it cannot name a player.
 * Player slugs are the site's slugification (`[^a-z0-9]+` -> "-", unaccented),
 * which can lead or trail with "-" ("marvin-harrison-jr-").
 */
export function parsePlayerHubSlug(raw: string): string | null {
  let slug: string
  try {
    slug = decodeURIComponent(raw)
  } catch {
    return null
  }
  slug = slug.trim().toLowerCase()
  if (slug.length < 2 || slug.length > 120) return null
  if (!/^[a-z0-9-]+$/.test(slug) || !/[a-z0-9]/.test(slug)) return null
  return slug
}

export { playerHubPath } from "@/lib/player-hub-path"

export async function fetchPlayerHub(
  slug: string,
  db: RpcClient = supabaseAdmin as unknown as RpcClient,
): Promise<{ hub: PlayerHub | null; ok: boolean }> {
  try {
    const { data, error } = await withBoardBudget(
      Promise.resolve(db.rpc("get_player_hub", { p_slug: slug })),
      `player-hub:${slug}`,
      HUB_TIMEOUT_MS,
      "players/",
    )
    if (error) {
      console.error("[players/player-hub] get_player_hub error:", error.message)
      return { hub: null, ok: false }
    }
    const row = firstEntityRow<PlayerHub>(data)
    if (!row || typeof row !== "object" || !row.name) return { hub: null, ok: true }
    const collections = Array.isArray(row.collections)
      ? row.collections.map((c) => ({ ...c, sports: Array.isArray(c.sports) ? c.sports : [] }))
      : []
    return { hub: { ...row, collections }, ok: true }
  } catch (e) {
    console.error("[players/player-hub] get_player_hub bound:", e instanceof Error ? e.message : e)
    return { hub: null, ok: false }
  }
}

/**
 * The hub's collections the app can route to. A collection the registry does
 * not know is SKIPPED — there is no page to send the reader to.
 */
export function routableEntries(hub: Pick<PlayerHub, "collections">): Array<{ entry: PlayerHubCollection; collection: CollectionSlugInfo }> {
  return hub.collections
    .map((entry) => ({ entry, collection: getCollectionByDbSlug(entry.collection_slug) }))
    .filter((x): x is { entry: PlayerHubCollection; collection: CollectionSlugInfo } => x.collection != null)
}

/**
 * Group the hub's collections by sport — one group per (probable) PERSON.
 * A collection spanning two sports (4 Panini rows today) appears in both.
 * Groups order by total editions, entries keep the RPC's order (editions desc).
 */
export function groupBySport(entries: PlayerHubCollection[]): SportGroup[] {
  const groups = new Map<string, PlayerHubCollection[]>()
  for (const e of entries) {
    const sports = e.sports.length > 0 ? e.sports : ["other"]
    for (const s of sports) {
      const list = groups.get(s) ?? []
      list.push(e)
      groups.set(s, list)
    }
  }
  const total = (list: PlayerHubCollection[]) => list.reduce((n, e) => n + (Number(e.edition_count) || 0), 0)
  return [...groups.entries()]
    .map(([sport, list]) => ({ sport, label: sportLabel(sport), entries: list }))
    .sort((a, b) => total(b.entries) - total(a.entries) || a.sport.localeCompare(b.sport))
}

/**
 * Index a hub only when one sport group GATHERS 2+ collections. A
 * one-collection hub is the per-collection page in a different frame, and a
 * name shared by two unrelated people is not a page a search engine should
 * rank as one player.
 */
export function playerHubIsIndexable(hub: Pick<PlayerHub, "collections">): boolean {
  return groupBySport(hub.collections).some((g) => g.entries.length >= 2)
}

export async function fetchPlayerHubPanels(
  hub: Pick<PlayerHub, "collections">,
  fetchDetail: (collectionId: string, slug: string) => Promise<EntityDetailResult> = (c, s) =>
    fetchEntityDetailRaw("player", c, s),
): Promise<PlayerHubPanel[]> {
  return Promise.all(
    routableEntries(hub).map(async ({ entry, collection }): Promise<PlayerHubPanel> => {
      try {
        const { data, error } = await withBoardBudget(
          fetchDetail(collection.id, entry.player_slug),
          `player-panel:${collection.dbSlug}:${entry.player_slug}`,
          PANEL_TIMEOUT_MS,
          "players/",
        )
        if (error) {
          console.error(`[players/player-hub] panel ${collection.dbSlug} error:`, error.message)
          return { state: "failed", collection, entry }
        }
        const detail = firstEntityRow<PlayerHubDetail>(data)
        if (!detail) return { state: "empty", collection, entry }
        return { state: "ok", collection, entry, detail }
      } catch (e) {
        console.error(`[players/player-hub] panel ${collection.dbSlug} bound:`, e instanceof Error ? e.message : e)
        return { state: "failed", collection, entry }
      }
    }),
  )
}

export type SectionFetcher = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ rows: unknown[]; ok: boolean }>

async function defaultSectionFetcher(fn: string, args: Record<string, unknown>): Promise<{ rows: unknown[]; ok: boolean }> {
  const { sectionRowsResult } = await import("@/lib/entity-section-rpc")
  const res = await sectionRowsResult<unknown>(`player-hub ${fn}`, fn, args)
  return { rows: res.rows, ok: res.ok }
}

/**
 * Top editions per ok panel, keyed by collection id, from the SAME
 * get_player_editions the per-collection page's grid reads. Three-state:
 * `ok:false` renders as unavailable; `ok:true, rows:[]` is a measured absence.
 */
export async function fetchPlayerHubEditions(
  panels: PlayerHubPanel[],
  fetchSection: SectionFetcher = defaultSectionFetcher,
): Promise<Map<string, { rows: unknown[]; ok: boolean }>> {
  const out = new Map<string, { rows: unknown[]; ok: boolean }>()
  await Promise.all(
    panels
      .filter((p) => p.state === "ok")
      .map(async (p) => {
        try {
          const r = await withBoardBudget(
            fetchSection("get_player_editions", {
              p_collection_id: p.collection.id,
              p_player_slug: p.entry.player_slug,
              p_limit: PLAYER_HUB_TOP_EDITIONS,
              p_offset: 0,
            }),
            `player-hub-editions:${p.collection.dbSlug}:${p.entry.player_slug}`,
            PANEL_TIMEOUT_MS,
            "players/",
          )
          out.set(p.collection.id, { rows: Array.isArray(r.rows) ? r.rows : [], ok: r.ok === true })
        } catch (e) {
          console.error(`[players/player-hub] editions ${p.collection.dbSlug} bound:`, e instanceof Error ? e.message : e)
          out.set(p.collection.id, { rows: [], ok: false })
        }
      }),
  )
  return out
}
