// lib/insights/autographs-board.ts
//
// Shared read for the public /insights/autographs board (page + /api/public route).
// Backed by public.v_insights_autographs (security_invoker = on, anon-granted;
// migration 20261020051112): one row per SIGNED NBA Top Shot / NFL All Day edition
// (editions.autographed_at, from Atlas autographedAt) with market FACTS — lowest
// live ask, 90-day sales and median, last sale, and the unsigned printing of the
// same Moment.
//
// ⛔ No FMV and no confidence here by design: most signed editions price LOW /
// ASK_ONLY, and a signed-from-unsigned estimate was measured WORSE than FMV
// (docs/research/autographs-topshot-allday-2026-10-19.md). `premium_x` exists only
// when both sides have ≥ 3 sales in 90 days.

export const AUTOGRAPH_BOARD_COLLECTIONS = ["nba_top_shot", "nfl_all_day"] as const
export type AutographBoardCollection = (typeof AUTOGRAPH_BOARD_COLLECTIONS)[number]

export const AUTOGRAPH_BOARD_SORTS = ["listed", "premium", "recent", "scarcity"] as const
export type AutographBoardSort = (typeof AUTOGRAPH_BOARD_SORTS)[number]

export type AutographRow = {
  edition_id: string
  external_id: string
  collection: string
  player_name: string | null
  team_name: string | null
  set_name: string | null
  parallel: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  low_ask: number | null
  ask_seen_at: string | null
  sales_90d: number
  median_90d: number | null
  last_sale_usd: number | null
  last_sale_at: string | null
  unsigned_external_id: string | null
  unsigned_parallel: string | null
  unsigned_median_90d: number | null
  unsigned_sales_90d: number | null
  premium_x: number | null
}

const COLS = [
  "edition_id", "external_id", "collection", "player_name", "team_name", "set_name", "parallel",
  "tier", "series", "circulation_count", "thumbnail_url", "low_ask", "ask_seen_at", "sales_90d",
  "median_90d", "last_sale_usd", "last_sale_at", "unsigned_external_id", "unsigned_parallel",
  "unsigned_median_90d", "unsigned_sales_90d", "premium_x",
].join(", ")

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null
}

export function normalizeAutographRow(raw: Record<string, unknown>): AutographRow {
  return {
    edition_id: String(raw.edition_id ?? ""),
    external_id: String(raw.external_id ?? ""),
    collection: String(raw.collection ?? ""),
    player_name: str(raw.player_name),
    team_name: str(raw.team_name),
    set_name: str(raw.set_name),
    parallel: str(raw.parallel),
    tier: str(raw.tier),
    series: num(raw.series),
    circulation_count: num(raw.circulation_count),
    thumbnail_url: str(raw.thumbnail_url),
    low_ask: num(raw.low_ask),
    ask_seen_at: str(raw.ask_seen_at),
    sales_90d: num(raw.sales_90d) ?? 0,
    median_90d: num(raw.median_90d),
    last_sale_usd: num(raw.last_sale_usd),
    last_sale_at: str(raw.last_sale_at),
    unsigned_external_id: str(raw.unsigned_external_id),
    unsigned_parallel: str(raw.unsigned_parallel),
    unsigned_median_90d: num(raw.unsigned_median_90d),
    unsigned_sales_90d: num(raw.unsigned_sales_90d),
    premium_x: num(raw.premium_x),
  }
}

/** URL slug for an edition page of this board's collections. */
export function autographCollectionUrlSlug(collection: string): string {
  return collection === "nfl_all_day" ? "nfl-all-day" : "nba-top-shot"
}

export function autographEditionHref(r: Pick<AutographRow, "collection" | "external_id">, externalId = r.external_id): string {
  return `/${autographCollectionUrlSlug(r.collection)}/edition/${encodeURIComponent(externalId)}`
}

type BoardQuery = {
  select: (cols: string) => BoardQuery
  eq: (col: string, v: string) => BoardQuery
  not: (col: string, op: string, v: null) => BoardQuery
  order: (col: string, opts: { ascending: boolean; nullsFirst?: boolean }) => BoardQuery
  limit: (n: number) => PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message?: string } | null }>
}
export type AutographBoardClient = { from: (t: string) => BoardQuery }

export async function fetchAutographsBoard(
  db: AutographBoardClient,
  opts: { collection: AutographBoardCollection; sort: AutographBoardSort; listedOnly?: boolean; limit: number },
): Promise<{ data: AutographRow[] | null; error: { message?: string } | null }> {
  let q = db.from("v_insights_autographs").select(COLS).eq("collection", opts.collection)
  if (opts.listedOnly || opts.sort === "listed") q = q.not("low_ask", "is", null)
  if (opts.sort === "premium") q = q.not("premium_x", "is", null)
  if (opts.sort === "recent") q = q.not("last_sale_at", "is", null)
  switch (opts.sort) {
    case "premium":
      q = q.order("premium_x", { ascending: false, nullsFirst: false })
      break
    case "recent":
      q = q.order("last_sale_at", { ascending: false, nullsFirst: false })
      break
    case "scarcity":
      q = q.order("circulation_count", { ascending: true, nullsFirst: false })
      break
    default:
      q = q.order("low_ask", { ascending: true, nullsFirst: false })
  }
  // Deterministic tiebreak on a UNIQUE key so a page never reorders between reads.
  q = q.order("edition_id", { ascending: true })
  const { data, error } = await q.limit(opts.limit)
  if (error) return { data: null, error }
  return { data: (data ?? []).map(normalizeAutographRow), error: null }
}
