// lib/rookie-edition-board.ts
//
// Shared config + fetch for the public Rookie Edition Board
// (/insights/rookie-board). One backing view, security_invoker=on, anon-granted:
//
//   topshot_rookie_edition_board — one row per 2025-rookie edition (set ×
//   parallel), spine = editions, scoped to topshot_2025_rookie_players.
//
// Data-honesty contract (must be respected by every renderer):
//   has_full_economics=true  → BASE editions only. low_ask / highest_offer /
//                              avg_sale_price / burned / locked / *_rate_pct are
//                              real. (badge_editions is base-only.)
//   has_full_economics=false → PARALLEL (::subID) rows. They carry FMV +
//                              circulation_count ONLY; every ask/offer/sale/burn/
//                              lock field is NULL by definition — render "—",
//                              never $0.
//
// The dataset is small (~431 rows / 61 players / 7 parallels), so the page
// fetches the whole board once and groups client-side. The API route exists for
// the OG card, the rpc-insights-qa gate, and external consumers, and supports
// server-side filtering for the burn-rankings mode + drill-down filters.

export type RookieBoardMode = "board" | "burn"
export type RookieSortKey =
  | "fmv"
  | "burned"
  | "burn_rate"
  | "circulation"
  | "lock_rate"

export type RookieEditionRow = {
  player_name: string | null
  set_name: string | null
  series_number: number | null
  tier: string | null
  parallel_id: number | null
  parallel_name: string | null
  external_id: string | null
  circulation_count: number | null
  fmv_usd: number | null
  fmv_confidence: string | null
  low_ask: number | null
  highest_offer: number | null
  avg_sale_price: number | null
  burned: number | null
  locked: number | null
  effective_supply: number | null
  burn_rate_pct: number | null
  lock_rate_pct: number | null
  has_full_economics: boolean
  thumbnail_url: string | null
  video_url: string | null
}

// Parallel display order (Standard first, then ascending rarity). Mirrors the
// on-chain subedition ids: 0 Standard, 17 Blockchain, 18 Hardcourt, 19 Hexwave,
// 20 Jukebox, 21 Galactic, 22 Omega.
export const PARALLEL_ORDER: Record<number, number> = {
  0: 0,
  17: 1,
  18: 2,
  19: 3,
  20: 4,
  21: 5,
  22: 6,
}

const COLS = [
  "player_name",
  "set_name",
  "series_number",
  "tier",
  "parallel_id",
  "parallel_name",
  "external_id",
  "circulation_count",
  "fmv_usd",
  "fmv_confidence",
  "low_ask",
  "highest_offer",
  "avg_sale_price",
  "burned",
  "locked",
  "effective_supply",
  "burn_rate_pct",
  "lock_rate_pct",
  "has_full_economics",
  "thumbnail_url",
  "video_url",
].join(", ")

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function normalizeRow(raw: Record<string, unknown>): RookieEditionRow {
  return {
    player_name: (raw.player_name as string) ?? null,
    set_name: (raw.set_name as string) ?? null,
    series_number: num(raw.series_number),
    tier: (raw.tier as string) ?? null,
    parallel_id: num(raw.parallel_id),
    parallel_name: (raw.parallel_name as string) ?? null,
    external_id: (raw.external_id as string) ?? null,
    circulation_count: num(raw.circulation_count),
    fmv_usd: num(raw.fmv_usd),
    fmv_confidence: (raw.fmv_confidence as string) ?? null,
    low_ask: num(raw.low_ask),
    highest_offer: num(raw.highest_offer),
    avg_sale_price: num(raw.avg_sale_price),
    burned: num(raw.burned),
    locked: num(raw.locked),
    effective_supply: num(raw.effective_supply),
    burn_rate_pct: num(raw.burn_rate_pct),
    lock_rate_pct: num(raw.lock_rate_pct),
    has_full_economics: raw.has_full_economics === true,
    thumbnail_url: (raw.thumbnail_url as string) ?? null,
    video_url: (raw.video_url as string) ?? null,
  }
}

export type FetchOpts = {
  mode: RookieBoardMode
  tier?: string | null
  parallelId?: number | null
  player?: string | null
  set?: string | null
  sort: RookieSortKey
  limit: number
}

// Query the board view and return normalized rows. `supabase` is the
// service-role client (typed any per the repo convention for API routes).
//
// board mode: returns every qualifying edition (ordered for grouping). burn
// mode: restricts to has_full_economics (the only rows with real burn data) and
// ranks by the chosen burn metric.
export async function fetchRookieEditionBoard(
  supabase: any,
  opts: FetchOpts
): Promise<RookieEditionRow[]> {
  let q = supabase.from("topshot_rookie_edition_board").select(COLS)

  if (opts.tier) q = q.eq("tier", opts.tier)
  if (opts.parallelId != null) q = q.eq("parallel_id", opts.parallelId)
  if (opts.player) q = q.eq("player_name", opts.player)
  if (opts.set) q = q.eq("set_name", opts.set)

  if (opts.mode === "burn") {
    // Burn rankings are only meaningful on base editions (parallels carry no
    // burn data). Surface the editions that have actually been burned.
    q = q.eq("has_full_economics", true).gt("burned", 0)
  }

  switch (opts.sort) {
    case "burned":
      q = q.order("burned", { ascending: false, nullsFirst: false })
      break
    case "burn_rate":
      q = q.order("burn_rate_pct", { ascending: false, nullsFirst: false })
      break
    case "lock_rate":
      q = q.order("lock_rate_pct", { ascending: false, nullsFirst: false })
      break
    case "circulation":
      q = q.order("circulation_count", { ascending: true, nullsFirst: false })
      break
    case "fmv":
    default:
      q = q.order("fmv_usd", { ascending: false, nullsFirst: false })
      break
  }

  q = q.limit(opts.limit)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<Record<string, unknown>>).map(normalizeRow)
}
