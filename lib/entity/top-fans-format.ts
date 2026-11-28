// lib/entity/top-fans-format.ts
//
// Client-safe half of Top Fans (types, ranking, links, copy). The server fetch lives in
// lib/entity/top-fans.ts — never import that one from a client component (it pulls the
// service-role client).

import { getEntityLabels } from "@/lib/entity-labels"

export type TopFansKind = "team" | "player" | "franchise"
export type TopFansMetric = "items" | "fmv" | "special"

export interface TopFanRow {
  owner: string
  username: string | null
  items: number
  special_items: number | null
  fmv_usd: number | null
  fmv_items: number
}

export interface TopFansData {
  refreshed_at: string
  source: string
  special_tracked: boolean
  /**
   * The owner source is a census of EVERY holder (Panini serials, Candy's census, or the Dune census).
   * null = the reader predates the flag (migration audit_20261127_top_collector_census not applied yet);
   * the page then falls back to TOP_COLLECTORS_FULL_CENSUS.
   */
  census_complete: boolean | null
  /** Owners seen holding this entity; null when it spans several labels (an owner may be under each). */
  holders: number | null
  items: number
  rows: TopFanRow[]
}

/** One collection's table, as the client component renders it. */
export interface TopFansPanel {
  collectionId: string
  /** URL slug ("nba-top-shot"). */
  urlSlug: string
  /** Display name ("NBA Top Shot"). */
  label: string
  /** "Moments" | "Pins" | "Cards". */
  units: string
  ok: boolean
  data: TopFansData | null
  /** true = this collection has no full holder census yet; no ranking is shown, only that it is coming. */
  pending?: boolean
}

export const TOP_FANS_LIMIT = 10

/**
 * FALLBACK (used only when the reader returns no census_complete flag): collections whose owner source is a FULL census of every holder (Trevor, 2026-11-27: "We need to
 * have this for every possible wallet, not just the ones we've captured"). Every other collection's
 * ranking is built from the wallets RPC happens to know, so it can name the wrong #1 — it renders as
 * "full count in progress" until the on-chain census (Dune, every Deposit since 2020) lands.
 *   panini-blockchain — every serial Panini's API returns, by owner
 *   candy-mlb         — Candy's daily on-chain wallet census
 * Not full (11-27): Top Shot / All Day / Golazos / UFC (walked wallets only), Pinnacle (owner map sees
 * 477k of 1.62M minted pins — it only reaches back to the Dec 2025 spork).
 */
export const TOP_COLLECTORS_FULL_CENSUS: ReadonlySet<string> = new Set(["panini-blockchain", "candy-mlb"])

export function hasFullCollectorCensus(urlSlug: string): boolean {
  return TOP_COLLECTORS_FULL_CENSUS.has(urlSlug)
}

/**
 * Whether a read may be shown as a ranking. The reader's own census_complete decides (it flips to true when
 * the Dune census lands, source 'dune_census'); a reader without the flag falls back to the static set.
 */
export function rankingIsCensus(urlSlug: string, data: Pick<TopFansData, "census_complete"> | null): boolean {
  if (!data) return false
  return data.census_complete ?? hasFullCollectorCensus(urlSlug)
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function normalizeTopFans(raw: unknown): TopFansData | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const rows = Array.isArray(r.rows) ? r.rows : []
  return {
    refreshed_at: String(r.refreshed_at ?? ""),
    source: String(r.source ?? ""),
    special_tracked: r.special_tracked !== false,
    census_complete: r.census_complete === true ? true : r.census_complete === false ? false : null,
    holders: num(r.holders),
    items: num(r.items) ?? 0,
    rows: rows
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).owner === "string")
      .map((x) => ({
        owner: x.owner as string,
        username: typeof x.username === "string" && x.username.trim() ? (x.username as string) : null,
        items: num(x.items) ?? 0,
        special_items: num(x.special_items),
        fmv_usd: num(x.fmv_usd),
        fmv_items: num(x.fmv_items) ?? 0,
      })),
  }
}

export function unitsFor(urlSlug: string): string {
  return getEntityLabels(urlSlug).units
}

/**
 * Rank rows by one metric; ties break on FMV, then count, then owner, so the order is stable.
 * The special ranking keeps only owners with at least one special serial — a list of zeros
 * ranked against each other is not a ranking.
 */
export function rankTopFans(rows: TopFanRow[], metric: TopFansMetric, limit = TOP_FANS_LIMIT): TopFanRow[] {
  const fmv = (r: TopFanRow) => r.fmv_usd ?? -1
  const pool = metric === "special" ? rows.filter((r) => (r.special_items ?? 0) > 0) : rows.slice()
  pool.sort((a, b) => {
    const d =
      metric === "items" ? b.items - a.items
      : metric === "fmv" ? fmv(b) - fmv(a)
      : (b.special_items ?? 0) - (a.special_items ?? 0)
    if (d !== 0) return d
    const f = fmv(b) - fmv(a)
    if (f !== 0) return f
    if (b.items !== a.items) return b.items - a.items
    return a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0
  })
  return pool.slice(0, limit)
}

/**
 * Where a fan's name links: the collection's anon-public wallet analyzer (robots-disallowed,
 * rel=nofollow at the link). Panini owners are USERNAMES, never wallets.
 */
export function topFanHref(urlSlug: string, owner: string): string {
  if (urlSlug === "panini-blockchain") return `/panini-blockchain/collection?username=${encodeURIComponent(owner)}`
  return `/${urlSlug}/collection?wallet=${encodeURIComponent(owner)}`
}

/** What the table is counted from, said plainly — never implied complete when it is not. */
export function topFansSourceNote(urlSlug: string): string {
  switch (urlSlug) {
    case "nba-top-shot":
      return "From wallets RPC has looked up plus RPC's on-chain Top Shot ownership index. A collector neither has seen won't appear."
    case "nfl-all-day":
    case "laliga-golazos":
    case "ufc-strike":
      return "From wallets RPC has looked up. A collector nobody has looked up on RPC won't appear."
    case "candy-mlb":
      return "From Candy's daily on-chain wallet census. Candy's unsold stock and Magic Eden's listing escrow are left out."
    case "panini-blockchain":
      return "From every serial Panini's marketplace has shown RPC, by owner username. Cards still in packs are left out."
    case "disney-pinnacle":
      return "From RPC's on-chain owner map of pins minted since Dec 2025. Disney Pinnacle's own accounts are left out. Serials aren't tracked for every pin, so there's no special-serial count."
    default:
      return "From the owners RPC can see."
  }
}

/** The calendar day a refresh ran, in Pacific time (pinned zone: same on server and client). */
export function topFansUpdatedLabel(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })
}
