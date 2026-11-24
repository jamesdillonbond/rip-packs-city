// lib/insights/candy-parity-boards.ts
//
// The reads behind two Candy insights boards (2026-11-23 evening, Candy parity pass 1 — the boards Disney Pinnacle got
// that afternoon), each shared by its server page and its public JSON route so the two cannot drift:
//   /insights/candy-serial-premiums — get_candy_serial_premiums (20261124013201): #1, jersey-match and perfect-serial
//                                     sales with the premium over the same edition's other serials (every Candy set);
//   /insights/candy-squeeze         — get_candy_listed_squeeze (20261124013201; every 2026 set from 20261124023333;
//                                     one board per eligible set, legacy included, from 20261124032031 — the per-set
//                                     pages are /insights/candy-squeeze/set/<set id>): editions ranked by the share of
//                                     collector-held copies with a confirmed Magic Eden listing.
// Each fetcher THROWS on a failed read or a body that is not the function's shape (a failure, never "no rows");
// NULLs stay null (`num`), so an unknown premium is never 1.0× and an unknown ask never $0.

import { supabaseAdmin } from "@/lib/supabase"
import { num } from "@/lib/insights/pinnacle-boards"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

// ── Serial premiums ─────────────────────────────────────────────────────────

export type CandySerialBand = "first" | "jersey" | "perfect"

export const CANDY_SERIAL_BAND_LABEL: Record<CandySerialBand, string> = {
  first: "#1",
  jersey: "jersey match",
  perfect: "perfect",
}

const asBand = (v: unknown): CandySerialBand => (v === "jersey" || v === "perfect" ? v : "first")

export interface CandySerialSale {
  external_id: string
  name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  serial_number: number
  band: CandySerialBand
  price_usd: number | null
  sold_at: string
  n_comps: number
  comp_median_usd: number | null
  multiplier: number | null
}

export interface CandySerialStat {
  band: CandySerialBand
  sales: number
  with_comps: number
  median_multiplier: number | null
}

export interface CandySerialPayload {
  stats: CandySerialStat[]
  rows: CandySerialSale[]
}

export function shapeCandySerialPremiums(raw: unknown): CandySerialPayload {
  const r = raw as Record<string, unknown> | null
  if (!r || !Array.isArray(r.rows)) throw new Error("candy serial premiums: unexpected payload")
  const stats = Array.isArray(r.stats) ? (r.stats as Record<string, unknown>[]) : []
  return {
    stats: stats.map((s) => ({
      band: asBand(s.band),
      sales: Number(s.sales ?? 0),
      with_comps: Number(s.with_comps ?? 0),
      median_multiplier: num(s.median_multiplier),
    })),
    rows: (r.rows as Record<string, unknown>[]).map((x) => ({
      external_id: String(x.external_id ?? ""),
      name: (x.name as string | null) ?? null,
      set_name: (x.set_name as string | null) ?? null,
      tier: (x.tier as string | null) ?? null,
      circulation_count: num(x.circulation_count),
      serial_number: Number(x.serial_number ?? 0),
      band: asBand(x.band),
      price_usd: num(x.price_usd),
      sold_at: String(x.sold_at ?? ""),
      n_comps: Number(x.n_comps ?? 0),
      comp_median_usd: num(x.comp_median_usd),
      multiplier: num(x.multiplier),
    })),
  }
}

export async function fetchCandySerialPremiums(db: Db = supabaseAdmin, limit = 200): Promise<CandySerialPayload> {
  const { data, error } = await db.rpc("get_candy_serial_premiums", { p_limit: limit })
  if (error) throw new Error(error.message ?? "get_candy_serial_premiums failed")
  return shapeCandySerialPremiums(data)
}

// ── Listed-share squeeze ────────────────────────────────────────────────────

export interface CandySqueezeRow {
  external_id: string
  player_name: string | null
  set_name: string | null
  rarity_label: string | null
  thumbnail_url: string | null
  minted: number | null
  /** NULL: the census sees holders, not burns. */
  burned: number | null
  issuer_held: number
  collector_held: number
  listed: number
  pct_listed: number | null
  floor_ask_usd: number | null
  fmv_usd: number | null
  sales_30d: number
}

export interface CandySqueezeSet {
  set_id: string
  set_name: string
  /** A registry set (2026 MLB ICONs, 2024 Team Balls) — asks from candy-listings-indexer. */
  registry: boolean
  ranked: number
  zero_listed: number
  /** Confirmed Magic Eden asks across the set's ranked editions. */
  asks: number
}

export interface CandySqueezePayload {
  listings_seen_at: string | null
  /** When mv_candy_edition_holders was last refreshed (holder counts are as of then). */
  holders_counted_at: string | null
  /** The set this payload ranks; null = the default 2026 view. */
  set_id: string | null
  min_held: number
  editions_ranked: number
  editions_zero_listed: number
  sets: CandySqueezeSet[]
  rows: CandySqueezeRow[]
}

export function shapeCandySqueeze(raw: unknown): CandySqueezePayload {
  const r = raw as Record<string, unknown> | null
  if (!r || !Array.isArray(r.rows)) throw new Error("candy squeeze: unexpected payload")
  return {
    listings_seen_at: typeof r.listings_seen_at === "string" ? r.listings_seen_at : null,
    holders_counted_at: typeof r.holders_counted_at === "string" ? r.holders_counted_at : null,
    set_id: typeof r.set_id === "string" ? r.set_id : null,
    min_held: Number(r.min_held ?? 0),
    editions_ranked: Number(r.editions_ranked ?? 0),
    editions_zero_listed: Number(r.editions_zero_listed ?? 0),
    sets: (Array.isArray(r.sets) ? (r.sets as Record<string, unknown>[]) : []).map((x) => ({
      set_id: String(x.set_id ?? ""),
      set_name: String(x.set_name ?? ""),
      registry: x.registry === true,
      ranked: Number(x.ranked ?? 0),
      zero_listed: Number(x.zero_listed ?? 0),
      asks: Number(x.asks ?? 0),
    })),
    rows: (r.rows as Record<string, unknown>[]).map((x) => ({
      external_id: String(x.external_id ?? ""),
      player_name: (x.player_name as string | null) ?? null,
      set_name: (x.set_name as string | null) ?? null,
      rarity_label: (x.rarity_label as string | null) ?? null,
      thumbnail_url: (x.thumbnail_url as string | null) ?? null,
      minted: num(x.minted),
      burned: num(x.burned),
      issuer_held: Number(x.issuer_held ?? 0),
      collector_held: Number(x.collector_held ?? 0),
      listed: Number(x.listed ?? 0),
      pct_listed: num(x.pct_listed),
      floor_ask_usd: num(x.floor_ask_usd),
      fmv_usd: num(x.fmv_usd),
      sales_30d: Number(x.sales_30d ?? 0),
    })),
  }
}

/** What a page renders under a failed read (the degraded notice explains it; nothing here is a measurement). */
export const EMPTY_CANDY_SQUEEZE: CandySqueezePayload = {
  listings_seen_at: null, holders_counted_at: null, set_id: null, sets: [],
  min_held: 25, editions_ranked: 0, editions_zero_listed: 0, rows: [],
}

/** A set id is a UUID; anything else never reaches the database. */
export const CANDY_SET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function fetchCandySqueeze(
  db: Db = supabaseAdmin,
  opts: { minHeld?: number; limit?: number; setId?: string | null } = {},
): Promise<CandySqueezePayload> {
  const setId = opts.setId ?? null
  if (setId !== null && !CANDY_SET_ID_RE.test(setId)) throw new Error("candy squeeze: malformed set id")
  const { data, error } = await db.rpc("get_candy_listed_squeeze", { p_min_held: opts.minHeld ?? 25, p_limit: opts.limit ?? 300, p_set: setId })
  if (error) throw new Error(error.message ?? "get_candy_listed_squeeze failed")
  return shapeCandySqueeze(data)
}
