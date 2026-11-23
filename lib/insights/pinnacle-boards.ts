// lib/insights/pinnacle-boards.ts
//
// The reads behind two Disney Pinnacle insights boards (2026-11-23, parity pass 3), each shared by its server page
// and its public JSON route so the two cannot drift:
//   /insights/pinnacle-serial-premiums — get_pinnacle_serial_premiums (20261123222500): #1 and perfect-serial sales
//                                        with the premium over the same pin's other serials;
//   /insights/pinnacle-squeeze         — get_pinnacle_listed_squeeze (20261123224000): pins ranked by the share of
//                                        collector-held copies listed in the last complete listings sweep.
// Each fetcher THROWS on a failed read or a body that is not the function's shape (a failure, never "no rows");
// NULLs stay null (`num`), so an unknown premium is never 1.0× and an unknown ask never $0.

import { supabaseAdmin } from "@/lib/supabase"

export const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

// ── Serial premiums ─────────────────────────────────────────────────────────

export type SerialBand = "first" | "perfect"

export interface PinnacleSerialSale {
  render_id: string
  name: string | null
  set_name: string | null
  edition_type: string | null
  variant: string | null
  total_minted: number | null
  serial_number: number
  band: SerialBand
  price_usd: number | null
  sold_at: string
  n_comps: number
  comp_median_usd: number | null
  multiplier: number | null
}

export interface PinnacleSerialStat {
  band: SerialBand
  sales: number
  with_comps: number
  median_multiplier: number | null
}

export interface PinnacleSerialPayload {
  stats: PinnacleSerialStat[]
  rows: PinnacleSerialSale[]
}

export function shapeSerialPremiums(raw: unknown): PinnacleSerialPayload {
  const r = raw as Record<string, unknown> | null
  if (!r || !Array.isArray(r.rows)) throw new Error("pinnacle serial premiums: unexpected payload")
  const stats = Array.isArray(r.stats) ? (r.stats as Record<string, unknown>[]) : []
  return {
    stats: stats.map((s) => ({
      band: s.band === "perfect" ? "perfect" : "first",
      sales: Number(s.sales ?? 0),
      with_comps: Number(s.with_comps ?? 0),
      median_multiplier: num(s.median_multiplier),
    })),
    rows: (r.rows as Record<string, unknown>[]).map((x) => ({
      render_id: String(x.render_id ?? ""),
      name: (x.name as string | null) ?? null,
      set_name: (x.set_name as string | null) ?? null,
      edition_type: (x.edition_type as string | null) ?? null,
      variant: (x.variant as string | null) ?? null,
      total_minted: num(x.total_minted),
      serial_number: Number(x.serial_number ?? 0),
      band: x.band === "perfect" ? "perfect" : "first",
      price_usd: num(x.price_usd),
      sold_at: String(x.sold_at ?? ""),
      n_comps: Number(x.n_comps ?? 0),
      comp_median_usd: num(x.comp_median_usd),
      multiplier: num(x.multiplier),
    })),
  }
}

export async function fetchPinnacleSerialPremiums(db: Db = supabaseAdmin, limit = 200): Promise<PinnacleSerialPayload> {
  const { data, error } = await db.rpc("get_pinnacle_serial_premiums", { p_limit: limit })
  if (error) throw new Error(error.message ?? "get_pinnacle_serial_premiums failed")
  return shapeSerialPremiums(data)
}

// ── Listed-share squeeze ────────────────────────────────────────────────────

export interface PinnacleSqueezeRow {
  render_id: string
  character_name: string | null
  set_name: string | null
  edition_type: string | null
  variant: string | null
  is_chaser: boolean | null
  thumbnail_url: string | null
  minted: number | null
  burned: number
  issuer_held: number
  collector_held: number
  listed: number
  pct_listed: number | null
  floor_ask_usd: number | null
  fmv_usd: number | null
  sales_30d: number
}

export interface PinnacleSqueezePayload {
  listings_seen_at: string | null
  min_held: number
  pins_ranked: number
  pins_zero_listed: number
  rows: PinnacleSqueezeRow[]
}

export function shapeSqueeze(raw: unknown): PinnacleSqueezePayload {
  const r = raw as Record<string, unknown> | null
  if (!r || !Array.isArray(r.rows)) throw new Error("pinnacle squeeze: unexpected payload")
  return {
    listings_seen_at: typeof r.listings_seen_at === "string" ? r.listings_seen_at : null,
    min_held: Number(r.min_held ?? 0),
    pins_ranked: Number(r.pins_ranked ?? 0),
    pins_zero_listed: Number(r.pins_zero_listed ?? 0),
    rows: (r.rows as Record<string, unknown>[]).map((x) => ({
      render_id: String(x.render_id ?? ""),
      character_name: (x.character_name as string | null) ?? null,
      set_name: (x.set_name as string | null) ?? null,
      edition_type: (x.edition_type as string | null) ?? null,
      variant: (x.variant as string | null) ?? null,
      is_chaser: (x.is_chaser as boolean | null) ?? null,
      thumbnail_url: (x.thumbnail_url as string | null) ?? null,
      minted: num(x.minted),
      burned: Number(x.burned ?? 0),
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

export async function fetchPinnacleSqueeze(db: Db = supabaseAdmin, opts: { minHeld?: number; limit?: number } = {}): Promise<PinnacleSqueezePayload> {
  const { data, error } = await db.rpc("get_pinnacle_listed_squeeze", { p_min_held: opts.minHeld ?? 25, p_limit: opts.limit ?? 100 })
  if (error) throw new Error(error.message ?? "get_pinnacle_listed_squeeze failed")
  return shapeSqueeze(data)
}
