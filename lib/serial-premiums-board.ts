// lib/serial-premiums-board.ts
//
// Shared config + fetch for the public Serial Premiums boards. Two backing
// views share an identical shape except for the headline-serial columns:
//
//   topshot_serial_premiums_board         — the #1 mint (no1_* columns)
//   topshot_perfect_mint_premiums_board   — the perfect mint #N/N (perfect_* columns)
//
// Both are security_invoker=on, anon-granted, premium_multiple >= 5. This module
// normalizes both into ONE row shape (headline_*) so the API route, the server
// page, and the OG card all read the same fields regardless of which board the
// `headline` toggle selected. The #1 board exposes no serial column (it is always
// 1); the perfect board carries perfect_serial (== circulation_count).

export type HeadlineMode = "no1" | "perfect"
export type SerialSortKey = "premium" | "headline_price" | "recent"

export type SerialBoardRow = {
  edition_id: string | null
  external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  moment_id: string | null
  nft_id: string | null
  edition_median_usd: number | null
  premium_multiple: number | null
  edition_sales_180d: number | null
  // Headline-serial fields, normalized across both boards:
  headline_serial: number | null // 1 for the #1 board, perfect_serial for the perfect board
  headline_last_sale_usd: number | null
  headline_sold_at: string | null
}

type BoardConfig = {
  table: string
  saleCol: string
  soldAtCol: string
  serialCol: string | null // null = always serial #1 (the #1 board)
}

export const BOARDS: Record<HeadlineMode, BoardConfig> = {
  no1: {
    table: "topshot_serial_premiums_board",
    saleCol: "no1_last_sale_usd",
    soldAtCol: "no1_sold_at",
    serialCol: null,
  },
  perfect: {
    table: "topshot_perfect_mint_premiums_board",
    saleCol: "perfect_last_sale_usd",
    soldAtCol: "perfect_sold_at",
    serialCol: "perfect_serial",
  },
}

export function parseHeadlineMode(raw: string | null | undefined): HeadlineMode {
  return raw?.trim().toLowerCase() === "perfect" ? "perfect" : "no1"
}

const SHARED_COLS = [
  "edition_id",
  "external_id",
  "player_name",
  "set_name",
  "tier",
  "circulation_count",
  "thumbnail_url",
  "moment_id",
  "nft_id",
  "edition_median_usd",
  "premium_multiple",
  "edition_sales_180d",
]

export function selectCols(mode: HeadlineMode): string {
  const b = BOARDS[mode]
  const cols = [...SHARED_COLS, b.saleCol, b.soldAtCol]
  if (b.serialCol) cols.push(b.serialCol)
  return cols.join(", ")
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function normalizeRow(mode: HeadlineMode, raw: Record<string, unknown>): SerialBoardRow {
  const b = BOARDS[mode]
  return {
    edition_id: (raw.edition_id as string) ?? null,
    external_id: (raw.external_id as string) ?? null,
    player_name: (raw.player_name as string) ?? null,
    set_name: (raw.set_name as string) ?? null,
    tier: (raw.tier as string) ?? null,
    circulation_count: num(raw.circulation_count),
    thumbnail_url: (raw.thumbnail_url as string) ?? null,
    moment_id: (raw.moment_id as string) ?? null,
    nft_id: (raw.nft_id as string) ?? null,
    edition_median_usd: num(raw.edition_median_usd),
    premium_multiple: num(raw.premium_multiple),
    edition_sales_180d: num(raw.edition_sales_180d),
    headline_serial: b.serialCol ? num(raw[b.serialCol]) : 1,
    headline_last_sale_usd: num(raw[b.saleCol]),
    headline_sold_at: (raw[b.soldAtCol] as string) ?? null,
  }
}

export type FetchOpts = {
  mode: HeadlineMode
  tier?: string | null
  windowDays: number
  minPremium: number
  sort: SerialSortKey
  limit: number
}

// Query the selected board and return normalized rows. `supabase` is the
// service-role client (typed any per the repo convention for API routes).
export async function fetchSerialPremiums(supabase: any, opts: FetchOpts): Promise<SerialBoardRow[]> {
  const b = BOARDS[opts.mode]
  const sinceIso = new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000).toISOString()

  let q = supabase
    .from(b.table)
    .select(selectCols(opts.mode))
    .gte("premium_multiple", opts.minPremium)
    .gte(b.soldAtCol, sinceIso)

  if (opts.tier) q = q.eq("tier", opts.tier)

  if (opts.sort === "headline_price") q = q.order(b.saleCol, { ascending: false })
  else if (opts.sort === "recent") q = q.order(b.soldAtCol, { ascending: false })
  else q = q.order("premium_multiple", { ascending: false })

  q = q.limit(opts.limit)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => normalizeRow(opts.mode, r))
}
