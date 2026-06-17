// lib/underpriced-serials-board.ts
//
// Shared config + fetch for the public Underpriced #1s / Perfect-mints board.
// Backed by ONE view, topshot_underpriced_serials_board, which surfaces every
// currently-LISTED Top Shot serial that is a headline serial (#1 OR the perfect
// mint #N/N) AND is priced below its serial-FMV estimate, ranked by discount.
//
// The listings spine is topshot_active_listings, filled by the GitHub-Actions
// curl ingest (Atlas WAF-blocks Vercel egress); the estimate is the same
// serial_fmv_estimate the moment page uses. So a row means: this exact serial is
// for sale RIGHT NOW for less than what the serial is worth. The intelligence
// nbatopshot.com has no equivalent of.
//
// estimate_quality is the honesty axis (computed in the view):
//   tight  — perfect-mint, OR non-COMMON tier, OR HIGH-confidence base edition.
//            The discount magnitude is trustworthy. Lead with these.
//   coarse — a COMMON #1 on a big common: the population multiplier is
//            empirically grounded but player-blind, so the % is right for stars
//            and overstated for role players. Shown, but framed as an estimate.
//
// Read by the API route, the server page, and the OG card so all three share one
// row shape and one query.

export type HeadlineMode = "all" | "no1" | "perfect"
export type QualityFilter = "all" | "tight" | "coarse"
export type UnderpricedSortKey = "discount" | "ask" | "recent"

export type UnderpricedRow = {
  edition_id: string | null
  external_id: string | null
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  nft_id: string | null
  serial_number: number | null
  // "first" = the #1 mint, "perfect" = the last serial (#N of N).
  kind: "first" | "perfect"
  ask_usd: number | null
  serial_fmv_usd: number | null
  edition_fmv_usd: number | null
  confidence: string | null
  discount_pct: number | null
  discount_usd: number | null
  estimate_quality: "tight" | "coarse"
  listing_url: string | null
  listed_at: string | null
  last_seen_at: string | null
}

const BOARD_TABLE = "topshot_underpriced_serials_board"

const COLS = [
  "edition_id",
  "external_id",
  "edition_key",
  "player_name",
  "set_name",
  "tier",
  "circulation_count",
  "thumbnail_url",
  "nft_id",
  "serial_number",
  "ask_usd",
  "serial_fmv_usd",
  "edition_fmv_usd",
  "confidence",
  "discount_pct",
  "discount_usd",
  "estimate_quality",
  "listing_url",
  "listed_at",
  "last_seen_at",
].join(", ")

export function parseHeadlineMode(raw: string | null | undefined): HeadlineMode {
  const v = raw?.trim().toLowerCase()
  if (v === "no1" || v === "first") return "no1"
  if (v === "perfect") return "perfect"
  return "all"
}

export function parseQuality(raw: string | null | undefined): QualityFilter {
  const v = raw?.trim().toLowerCase()
  if (v === "tight") return "tight"
  if (v === "coarse") return "coarse"
  return "all"
}

export function parseSort(raw: string | null | undefined): UnderpricedSortKey {
  const v = raw?.trim().toLowerCase()
  if (v === "ask") return "ask"
  if (v === "recent") return "recent"
  return "discount"
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeRow(raw: Record<string, unknown>): UnderpricedRow {
  const serial = num(raw.serial_number)
  const nftId = (raw.nft_id as string) ?? null
  const listingUrl =
    (raw.listing_url as string) ||
    (nftId ? `https://dapper.market/nba/moment/${encodeURIComponent(nftId)}` : null)
  return {
    edition_id: (raw.edition_id as string) ?? null,
    external_id: (raw.external_id as string) ?? null,
    edition_key: (raw.edition_key as string) ?? null,
    player_name: (raw.player_name as string) ?? null,
    set_name: (raw.set_name as string) ?? null,
    tier: (raw.tier as string) ?? null,
    circulation_count: num(raw.circulation_count),
    thumbnail_url: (raw.thumbnail_url as string) ?? null,
    nft_id: nftId,
    serial_number: serial,
    kind: serial === 1 ? "first" : "perfect",
    ask_usd: num(raw.ask_usd),
    serial_fmv_usd: num(raw.serial_fmv_usd),
    edition_fmv_usd: num(raw.edition_fmv_usd),
    confidence: (raw.confidence as string) ?? null,
    discount_pct: num(raw.discount_pct),
    discount_usd: num(raw.discount_usd),
    estimate_quality: (raw.estimate_quality as "tight" | "coarse") ?? "coarse",
    listing_url: listingUrl,
    listed_at: (raw.listed_at as string) ?? null,
    last_seen_at: (raw.last_seen_at as string) ?? null,
  }
}

export type FetchOpts = {
  headline: HeadlineMode
  tier?: string | null
  quality: QualityFilter
  minDiscount: number
  sort: UnderpricedSortKey
  limit: number
}

// Query the board view and return normalized rows. `supabase` is the
// service-role client (typed any per the repo convention for API routes). The
// board is small and gated to scarce headline serials, so we fetch the filtered
// set DB-side (tier/quality/min_discount/sort), then apply the #1-vs-perfect
// headline split in JS and slice to the limit — PostgREST can't compare
// serial_number to circulation_count column-to-column.
export async function fetchUnderpricedSerials(supabase: any, opts: FetchOpts): Promise<UnderpricedRow[]> {
  let q = supabase.from(BOARD_TABLE).select(COLS).gte("discount_pct", opts.minDiscount)

  if (opts.tier) q = q.eq("tier", opts.tier)
  if (opts.quality !== "all") q = q.eq("estimate_quality", opts.quality)

  if (opts.sort === "ask") q = q.order("ask_usd", { ascending: true })
  else if (opts.sort === "recent") q = q.order("listed_at", { ascending: false, nullsFirst: false })
  else q = q.order("discount_pct", { ascending: false, nullsFirst: false })

  // The board is tiny; pull a generous slice so the JS headline filter has room,
  // then trim. 500 is far above any realistic board size.
  q = q.limit(500)

  const { data, error } = await q
  if (error) throw new Error(error.message)

  let rows = ((data ?? []) as Array<Record<string, unknown>>).map(normalizeRow)

  if (opts.headline === "no1") rows = rows.filter((r) => r.kind === "first")
  else if (opts.headline === "perfect") rows = rows.filter((r) => r.kind === "perfect")

  return rows.slice(0, opts.limit)
}
