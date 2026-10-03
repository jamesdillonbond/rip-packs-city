// lib/insights/market-cap-board.ts
//
// Shared fetch + shape for the public Market Cap board (/insights/market-cap and
// /api/public/insights/market-cap). Reads get_market_cap_board() — one SQL
// definition for every grain, so a collection total is by construction the sum of
// its editions (migration 20261003201018).
//
//   market cap = edition FMV x COLLECTOR-HELD supply
//   collector-held = minted - burned - held by the issuer (sealed / unsold packs,
//                    reserve never packed)
//
// ⚠ HONESTY — three states per figure, never two:
//   · mcap_usd is a number   → the supply split is known for at least one edition;
//   · mcap_usd is null       → NO burn / issuer-held source for this group. It is NOT
//                              $0, and must never render as one (Golazos, UFC,
//                              Pinnacle, Candy today). mcap_minted_usd is the
//                              labelled upper bound for those.
//   · editions_supply_known < editions → the number covers only part of the group.
// Every nullable numeric below stays null through `numOrNull`; nothing here
// defaults a missing value to 0.

import { getCollectionByDbSlug, getCollectionByUrlSlug } from "@/lib/collection-slug"
import { editionHref, setEntityHref } from "@/lib/entity-href"
import { slugifyName, slugifyPlayerName } from "@/lib/entity-labels"
import { analyticsSeriesLabel } from "@/lib/series-label"
import { collectionDisplayName } from "./market-cap-format"

export { fmtCount, fmtUsdCompact } from "@/lib/insights/market-cap-format"

export const MARKET_CAP_GROUPS = ["collection", "edition", "player", "team", "set", "series", "tier", "badge"] as const
export type MarketCapGroup = (typeof MARKET_CAP_GROUPS)[number]

export const GROUP_LABELS: Record<MarketCapGroup, string> = {
  collection: "Collections",
  edition: "Editions",
  player: "Players",
  team: "Teams",
  set: "Sets",
  series: "Series",
  tier: "Tiers",
  badge: "Badges",
}

export const MAX_LIMIT = 500
export const DEFAULT_LIMIT = 100

export interface MarketCapRow {
  collection_slug: string
  group_key: string
  group_label: string
  set_name: string | null
  tier: string | null
  series_num: number | null
  series_name: string | null
  edition_external_id: string | null
  editions: number
  editions_supply_known: number
  editions_priced: number
  minted: number | null
  burned: number | null
  issuer_held: number | null
  collector_held: number | null
  mcap_usd: number | null
  mcap_high_conf_usd: number | null
  mcap_minted_usd: number | null
  /** The same group's cap 7 PT-days ago (collection grain only); null = no history yet. */
  mcap_usd_7d_ago: number | null
}

export interface MarketCapBoard {
  group: MarketCapGroup
  /** DB slug the board is scoped to, or null for every collection. */
  collection: string | null
  rows: MarketCapRow[]
}

export const METHOD_NOTE =
  "Market cap = each edition's fair market value x its collector-held supply: minted, minus burned, minus Moments the issuer still holds (sealed and unsold packs, and reserve never packed). Top Shot, All Day, LaLiga Golazos and Disney Pinnacle supply comes from the marketplace's own per-edition counts, Panini from its card supply, Candy MLB from the treasury's on-chain holdings. UFC Strike publishes no burn count we can read, so its market cap is shown as unknown, with the minted-supply figure as an upper bound. Serial premiums (#1s, jersey matches) are not included — every copy is valued at the edition's FMV."

export function isMarketCapGroup(v: string | null | undefined): v is MarketCapGroup {
  return v != null && (MARKET_CAP_GROUPS as readonly string[]).includes(v)
}

/**
 * Resolve a `collection` query param (URL slug or DB slug) to its DB slug.
 * Returns undefined for an UNKNOWN value — callers must refuse it, never fall back to
 * another collection (SUBSTITUTION: "?collection=x" answered with Top Shot's numbers
 * is the failure where nothing fails). An absent / empty param is `null` = all.
 */
export function resolveCollectionParam(v: string | null | undefined): string | null | undefined {
  const t = v?.trim()
  if (!t) return null
  const info = getCollectionByUrlSlug(t) ?? getCollectionByDbSlug(t)
  return info ? info.dbSlug : undefined
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`market-cap: non-numeric count ${String(v)}`)
  return n
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v)
}

export function shapeRow(r: Record<string, unknown>): MarketCapRow {
  return {
    collection_slug: String(r.collection_slug ?? ""),
    group_key: String(r.group_key ?? ""),
    group_label: String(r.group_label ?? ""),
    set_name: strOrNull(r.set_name),
    tier: strOrNull(r.tier),
    series_num: numOrNull(r.series_num),
    series_name: strOrNull(r.series_name),
    edition_external_id: strOrNull(r.edition_external_id),
    editions: int(r.editions),
    editions_supply_known: int(r.editions_supply_known),
    editions_priced: int(r.editions_priced),
    minted: numOrNull(r.minted),
    burned: numOrNull(r.burned),
    issuer_held: numOrNull(r.issuer_held),
    collector_held: numOrNull(r.collector_held),
    mcap_usd: numOrNull(r.mcap_usd),
    mcap_high_conf_usd: numOrNull(r.mcap_high_conf_usd),
    mcap_minted_usd: numOrNull(r.mcap_minted_usd),
    mcap_usd_7d_ago: numOrNull(r.mcap_usd_7d_ago),
  }
}

/**
 * `supabase` is the service-role client (typed any per the repo convention).
 * THROWS on a failed read — the route maps that to boardUnavailable() and the page
 * to its degraded branch; an error never becomes an empty board here.
 */
export async function fetchMarketCapBoard(
  supabase: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  group: MarketCapGroup,
  collection: string | null,
  limit: number = DEFAULT_LIMIT,
): Promise<MarketCapBoard> {
  const { data, error } = await supabase.rpc("get_market_cap_board", {
    p_group: group,
    p_collection: collection,
    p_limit: Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT),
  })
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error("market-cap: RPC returned no row set")
  return { group, collection, rows: (data as Record<string, unknown>[]).map(shapeRow) }
}

// Re-exported for the board client and the OG route; the helper itself lives in
// market-cap-format.ts so a page can label a collection without reaching this
// module's reads (check-unbounded-server-reads, 2026-10-03).
export { collectionDisplayName, sevenDayChange } from "./market-cap-format"

/** The row's display label — series numbers decoded per collection, collections named. */
export function rowLabel(r: MarketCapRow, group: MarketCapGroup): string {
  if (group === "collection") return collectionDisplayName(r.collection_slug)
  if (group === "series") return r.series_name ?? analyticsSeriesLabel(r.series_num, r.collection_slug)
  return r.group_label || "—"
}

/** Secondary line under the label (set + series for a set, set + tier for an edition). */
export function rowDetail(r: MarketCapRow, group: MarketCapGroup): string | null {
  const series = r.series_name ?? (r.series_num != null ? analyticsSeriesLabel(r.series_num, r.collection_slug) : null)
  if (group === "set") return series
  if (group === "edition") return [r.set_name, r.tier, series].filter(Boolean).join(" · ") || null
  return null
}

/** Internal link for a row, or null where the site has no page for that grain. */
export function rowHref(r: MarketCapRow, group: MarketCapGroup): string | null {
  const info = getCollectionByDbSlug(r.collection_slug)
  if (!info) return null
  const base = info.urlSlug
  switch (group) {
    case "collection":
      return `/${base}/overview`
    case "edition":
      return r.edition_external_id ? editionHref(base, r.edition_external_id, r.edition_external_id) : null
    case "player":
      return r.group_label ? `/${base}/player/${encodeURIComponent(slugifyPlayerName(r.group_label))}` : null
    case "team":
      return r.group_label ? `/${base}/team/${encodeURIComponent(slugifyName(r.group_label))}` : null
    case "set":
      return setEntityHref(base, r.set_name ?? r.group_label)
    default:
      return null
  }
}

/** Share of the cap priced at HIGH/MEDIUM confidence, or null when the cap is unknown or zero. */
export function highConfidenceShare(r: MarketCapRow): number | null {
  if (r.mcap_usd == null || r.mcap_high_conf_usd == null || r.mcap_usd <= 0) return null
  return r.mcap_high_conf_usd / r.mcap_usd
}

/** Fractional change vs 7 days ago, or null when either side is unknown or the base is 0. */

// ── Entity tile (edition / player / team / set pages) ─────────────────────────

export type MarketCapEntityGroup = "edition" | "player" | "team" | "set" | "series"

export interface MarketCapEntityRow {
  collection_slug: string
  group_label: string
  editions: number
  editions_supply_known: number
  editions_priced: number
  minted: number | null
  burned: number | null
  issuer_held: number | null
  collector_held: number | null
  mcap_usd: number | null
  mcap_high_conf_usd: number | null
  mcap_minted_usd: number | null
  mcap_rank: number | null
  groups_ranked: number
  mcap_usd_7d_ago: number | null
  refreshed_at: string | null
}

/**
 * One entity's cap, read from market_cap_current (refreshed every 2 hours) by the
 * same slug the page itself resolves. `null` = the read worked and there is no row
 * (the tile renders nothing); a failed read THROWS so the caller can say so.
 */
export async function fetchMarketCapEntity(
  supabase: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  group: MarketCapEntityGroup,
  collectionDbSlug: string,
  match: string,
): Promise<MarketCapEntityRow | null> {
  const { data, error } = await supabase.rpc("get_market_cap_entity", {
    p_group: group,
    p_collection: collectionDbSlug,
    p_match: match,
  })
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error("market-cap: entity RPC returned no row set")
  const r = data[0] as Record<string, unknown> | undefined
  if (!r) return null
  return {
    collection_slug: String(r.collection_slug ?? ""),
    group_label: String(r.group_label ?? ""),
    editions: int(r.editions),
    editions_supply_known: int(r.editions_supply_known),
    editions_priced: int(r.editions_priced),
    minted: numOrNull(r.minted),
    burned: numOrNull(r.burned),
    issuer_held: numOrNull(r.issuer_held),
    collector_held: numOrNull(r.collector_held),
    mcap_usd: numOrNull(r.mcap_usd),
    mcap_high_conf_usd: numOrNull(r.mcap_high_conf_usd),
    mcap_minted_usd: numOrNull(r.mcap_minted_usd),
    mcap_rank: numOrNull(r.mcap_rank),
    groups_ranked: int(r.groups_ranked),
    mcap_usd_7d_ago: numOrNull(r.mcap_usd_7d_ago),
    refreshed_at: strOrNull(r.refreshed_at),
  }
}

/** The refresh runs every 2 hours; three missed runs (6 h) is "behind". */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * null = fresh; "unknown" = no refresh stamp; otherwise the PT time the figures are
 * from. Formatted in a fixed zone so a server render is deterministic.
 */
export function staleSince(refreshedAt: string | null, now: number): string | null {
  if (!refreshedAt) return "unknown"
  const t = Date.parse(refreshedAt)
  if (!Number.isFinite(t)) return "unknown"
  if (now - t <= STALE_AFTER_MS) return null
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(t)) + " PT"
}
