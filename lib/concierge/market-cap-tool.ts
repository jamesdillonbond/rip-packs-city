// lib/concierge/market-cap-tool.ts
//
// The concierge's get_market_cap tool. Market cap = FMV x COLLECTOR-HELD supply
// (minted - burned - issuer-held), read from the same SQL the /insights/market-cap
// board and the entity-page tiles use, so the bot and the site never disagree.
//
//   name given  → ONE entity (player / team / set / series / edition) with its rank,
//                 matched by the slug that entity's page resolves (players and teams
//                 go through the person / franchise resolvers first)
//   no name     → a leaderboard for the grain (collections, players, teams, sets,
//                 series, tiers, badges, editions)
//
// Honesty: an unknown cap (no burn source — UFC Strike) is returned as null with
// the minted-supply upper bound, never as 0; a missing row is "no_results", never a
// $0 answer; a failed read is an error the model must say out loud.

import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { pinnacleFranchiseName } from "@/lib/entity-href"
import { slugifyName } from "@/lib/entity-labels"
import {
  METHOD_NOTE,
  fetchMarketCapBoard,
  fetchMarketCapEntity,
  isMarketCapGroup,
  rowHref,
  rowLabel,
  sevenDayChange,
  type MarketCapEntityGroup,
  type MarketCapRow,
} from "@/lib/insights/market-cap-board"
import { SERIES_DISPLAY } from "@/lib/series-label"

const ENTITY_GRAINS: ReadonlySet<string> = new Set(["player", "team", "set", "series", "edition"])

type Resolved = { status: "ok"; slug: string; label: string } | { status: "stop"; payload: Record<string, unknown> }

export interface MarketCapToolDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  siteBase: string
  /** Person resolver (resolve_player_name). Returns the page slug, or a stop payload (ambiguous / failed). */
  resolvePlayerSlug: (collectionUuid: string, name: string) => Promise<Resolved>
  /** Franchise resolver (resolve_team_name). Returns the team page slug, or a stop payload. */
  resolveTeamSlug: (collectionUuid: string, name: string) => Promise<Resolved>
}

function round2(n: number | null): number | null {
  return n == null ? null : Math.round(n * 100) / 100
}

function compactRow(r: MarketCapRow, grain: Parameters<typeof rowLabel>[1], base: string) {
  const href = rowHref(r, grain)
  return {
    name: rowLabel(r, grain),
    collection: r.collection_slug,
    market_cap_usd: round2(r.mcap_usd),
    market_cap_status: r.mcap_usd == null ? "unknown — no published burn count" : "known",
    minted_supply_upper_bound_usd: r.mcap_usd == null ? round2(r.mcap_minted_usd) : undefined,
    high_confidence_share: r.mcap_usd && r.mcap_high_conf_usd != null ? Math.round((r.mcap_high_conf_usd / r.mcap_usd) * 1000) / 1000 : null,
    collector_held: r.collector_held,
    minted: r.minted,
    burned: r.burned,
    issuer_held: r.issuer_held,
    editions: r.editions,
    editions_with_supply_split: r.editions_supply_known,
    change_7d: sevenDayChange(r.mcap_usd, r.mcap_usd_7d_ago),
    url: href ? `${base}${href}` : null,
  }
}

/** Top Shot series are on-chain numbers (0 = Series 1); accept either form. */
function seriesKey(collectionDbSlug: string, raw: string): string {
  const t = raw.trim()
  if (/^\d+$/.test(t)) return t
  if (collectionDbSlug === "nba_top_shot") {
    const hit = Object.entries(SERIES_DISPLAY).find(([, label]) => label.toLowerCase() === t.toLowerCase())
    if (hit) return hit[0]
  }
  if (collectionDbSlug !== "disney_pinnacle") {
    const m = /^series\s+(\d+)$/i.exec(t)
    if (m) return m[1]
  }
  return t
}

export async function runMarketCapTool(
  input: Record<string, unknown>,
  collectionUrlSlug: string,
  deps: MarketCapToolDeps,
): Promise<Record<string, unknown>> {
  const grain = String(input.grain ?? "collection").trim().toLowerCase()
  if (!isMarketCapGroup(grain)) {
    return { status: "error", message: `Unknown grain '${grain}'. Use collection, player, team, set, series, tier, badge or edition.` }
  }
  const name = String(input.name ?? "").trim()
  const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 10, 1), 25)
  const info = getCollectionByUrlSlug(collectionUrlSlug)
  // An unknown collection is refused — never answered with another collection's numbers.
  if (!info) return { status: "error", message: `Unknown collection '${collectionUrlSlug}'.` }

  // ── Leaderboard ──────────────────────────────────────────────────────────
  if (!name || grain === "collection" || grain === "tier" || grain === "badge") {
    const scope = grain === "collection" ? null : info.dbSlug
    const board = await fetchMarketCapBoard(deps.supabase, grain, scope, grain === "collection" ? 50 : limit)
    return {
      status: board.rows.length ? "ok" : "no_results",
      kind: "leaderboard",
      grain,
      collection: scope,
      rows: board.rows.map((r) => compactRow(r, grain, deps.siteBase)),
      board_url: `${deps.siteBase}/insights/market-cap`,
      definition: METHOD_NOTE,
    }
  }

  // ── One entity ───────────────────────────────────────────────────────────
  if (!ENTITY_GRAINS.has(grain)) return { status: "error", message: `A single ${grain} cannot be looked up by name.` }
  const isPinnacle = info.dbSlug === "disney_pinnacle"
  let match: string
  let label = name
  if (grain === "player") {
    if (isPinnacle) {
      match = slugifyName(name)
    } else {
      const r = await deps.resolvePlayerSlug(info.id, name)
      if (r.status === "stop") return r.payload
      match = r.slug
      label = r.label
    }
  } else if (grain === "team") {
    if (isPinnacle) {
      match = slugifyName(pinnacleFranchiseName(name))
    } else {
      const r = await deps.resolveTeamSlug(info.id, name)
      if (r.status === "stop") return r.payload
      match = r.slug
      label = r.label
    }
  } else if (grain === "set") {
    match = slugifyName(name)
  } else if (grain === "series") {
    match = seriesKey(info.dbSlug, name)
  } else {
    match = name
  }

  const row = await fetchMarketCapEntity(deps.supabase, grain as MarketCapEntityGroup, info.dbSlug, match)
  if (!row) {
    return {
      status: "no_results",
      kind: "entity",
      grain,
      name: label,
      collection: info.dbSlug,
      message: `No market-cap row for ${grain} "${label}" in ${info.displayName}. Check the spelling, or call without a name for the ${grain} leaderboard.`,
    }
  }
  return {
    status: "ok",
    kind: "entity",
    grain,
    name: row.group_label || label,
    collection: info.dbSlug,
    market_cap_usd: round2(row.mcap_usd),
    market_cap_status: row.mcap_usd == null ? "unknown — no published burn count" : "known",
    minted_supply_upper_bound_usd: row.mcap_usd == null ? round2(row.mcap_minted_usd) : undefined,
    rank: row.mcap_rank,
    ranked_out_of: row.groups_ranked,
    high_confidence_share: row.mcap_usd && row.mcap_high_conf_usd != null ? Math.round((row.mcap_high_conf_usd / row.mcap_usd) * 1000) / 1000 : null,
    collector_held: row.collector_held,
    minted: row.minted,
    burned: row.burned,
    issuer_held: row.issuer_held,
    editions: row.editions,
    editions_with_supply_split: row.editions_supply_known,
    change_7d: sevenDayChange(row.mcap_usd, row.mcap_usd_7d_ago),
    change_7d_note: row.mcap_usd_7d_ago == null ? "No 7-day history yet (daily snapshots began Oct 3, 2026)." : undefined,
    refreshed_at: row.refreshed_at,
    board_url: `${deps.siteBase}/insights/market-cap`,
    definition: METHOD_NOTE,
  }
}
