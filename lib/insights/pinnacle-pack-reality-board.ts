// lib/insights/pinnacle-pack-reality-board.ts
//
// The single read behind the Disney Pinnacle Pack Reality board (2026-11-23), shared by
// app/insights/pinnacle-pack-reality/page.tsx and app/api/public/insights/pinnacle-pack-reality/route.ts.
// Backing function: get_pinnacle_pack_reality (20261123210500) — per purchasable drop since 2026-09
// (the first drops valued at open), retail price vs the pulls' value at open and today.
//
// Honesty: the function's NULLs stay NULL here (a pack whose pulls were priced late has no "at open"
// value; a pack with an unpriced pin has no "today" value). `num` never turns null into 0.

import { supabaseAdmin } from "@/lib/supabase"

export interface PinnacleDropReality {
  drop_name: string
  price_usd: number | null
  dist_ids: string[]
  packs_opened: number
  first_open_at: string
  last_open_at: string
  n_at_open: number
  avg_value_at_open: number | null
  n_today: number
  avg_value_today: number | null
  median_value_today: number | null
  best_pull_today: number | null
  pct_today_at_or_above_price: number | null
}

export interface PinnacleRealityPayload {
  since: string
  min_opens: number
  drops: PinnacleDropReality[]
}

export const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v)

/** Shape the RPC's jsonb; throws on a payload that is not the function's shape (a failure, not "no drops"). */
export function shapePinnacleReality(raw: unknown): PinnacleRealityPayload {
  const r = raw as Record<string, unknown> | null
  if (!r || !Array.isArray(r.drops)) throw new Error("pinnacle pack reality: unexpected payload")
  return {
    since: String(r.since ?? ""),
    min_opens: Number(r.min_opens ?? 0),
    drops: (r.drops as Record<string, unknown>[]).map((d) => ({
      drop_name: String(d.drop_name ?? ""),
      price_usd: num(d.price_usd),
      dist_ids: Array.isArray(d.dist_ids) ? (d.dist_ids as unknown[]).map(String) : [],
      packs_opened: Number(d.packs_opened ?? 0),
      first_open_at: String(d.first_open_at ?? ""),
      last_open_at: String(d.last_open_at ?? ""),
      n_at_open: Number(d.n_at_open ?? 0),
      avg_value_at_open: num(d.avg_value_at_open),
      n_today: Number(d.n_today ?? 0),
      avg_value_today: num(d.avg_value_today),
      median_value_today: num(d.median_value_today),
      best_pull_today: num(d.best_pull_today),
      pct_today_at_or_above_price: num(d.pct_today_at_or_above_price),
    })),
  }
}

/** avg value today ÷ price; null when either side is unknown (never a fabricated ratio). */
export function valueToPriceRatio(d: Pick<PinnacleDropReality, "avg_value_today" | "price_usd">): number | null {
  if (d.avg_value_today == null || d.price_usd == null || d.price_usd <= 0) return null
  return Math.round((d.avg_value_today / d.price_usd) * 100) / 100
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Throws on a failed read so each caller keeps its own failure policy. */
export async function fetchPinnacleReality(db: Db = supabaseAdmin): Promise<PinnacleRealityPayload> {
  const { data, error } = await db.rpc("get_pinnacle_pack_reality", {})
  if (error) throw new Error(error.message ?? "get_pinnacle_pack_reality failed")
  return shapePinnacleReality(data)
}
