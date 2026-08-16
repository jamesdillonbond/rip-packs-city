// lib/insights/pack-market-board.ts
//
// The SEALED-PACK secondary-market board, shared by /insights/allday-pack-market
// and /insights/topshot-pack-market.
//
// ⚠ WHY THIS IS A SHARED MODULE RATHER THAN TWO PAGES. The two boards were
// byte-identical apart from the view name, one column name, and their log
// labels — including every ranking constant below. Duplicated ranking logic
// drifts silently: a threshold tuned on one board leaves the other publishing a
// different definition of "discount" under the same word, and nothing compares
// them. Extracting also moves that logic into `lib/`, which the primary coverage
// gate measures; inside a `page.tsx` it was measured by neither gate.
//
// ⚠ THE ONE REAL DIVERGENCE IS ALIASED AWAY, DELIBERATELY. All Day exposes
// `opened_pct_of_minted` and Top Shot exposes `depletion_pct`. Both mean the
// same thing to the reader ("how much of the drop has been ripped") and both
// pages already aliased it to `opened` at the point of render, so the SELECT
// aliases it to `opened_pct` here. That is what lets one row type serve both —
// but it means the column name lives in ONE place per board, and a view renaming
// its column breaks the fetch loudly rather than silently rendering an em-dash.
//
// The ranking is deliberately computed over the FULL paged set, never a capped
// page: Top Shot's board qualifies ~1,233 rows against PostgREST's 1,000-row
// cap, so an unordered `.limit(1000)` dropped ~233 of them AND left the
// survivors arbitrary — the "biggest discount" top-15 could miss real top-15
// packs. See CLAUDE.md on the silently-sliced-ranking class.

import { supabaseAdmin } from "@/lib/supabase"
import { fetchAllPaged } from "@/lib/supabase-paginate"
import { withPagedBoardBudget } from "@/lib/insights/board-page-fetch"

/** Minimum sales for a pack's resale signal to be considered stable. */
export const MIN_SALES = 5
/** Below this share of retail a pack is ranked as trading at a DISCOUNT. */
export const DISCOUNT_MAX_RATIO = 0.85
/** Above this share of retail a pack is ranked as trading at a PREMIUM. */
export const PREMIUM_MIN_RATIO = 1.15
/** Rows shown in each of the three rankings. */
export const RANK_LIMIT = 15

export interface PackMarketRow {
  dist_id: string
  title: string | null
  drop_size: number | string | null
  retail_price: number | string | null
  /** Aliased from `opened_pct_of_minted` (All Day) / `depletion_pct` (Top Shot). */
  opened_pct: number | string | null
  n_sales: number | string | null
  n_sales_90d: number | string | null
  last_sale_price: number | string | null
  last_sale_at: string | null
  median_price_90d: number | string | null
  secondary_vs_retail_ratio: number | string | null
}

export interface PackMarketBuckets {
  /**
   * ⚠ false when the backing read FAILED — distinct from "no qualifying packs
   * yet". The page renders a degraded notice on false and an honest empty state
   * on true-with-no-rows; collapsing them would publish our outage as a claim
   * about the market.
   */
  ok: boolean
  discount: PackMarketRow[]
  premium: PackMarketRow[]
  mostTraded: PackMarketRow[]
  qualifying: number
  lastSaleAt: string | null
}

export interface PackMarketBoardSource {
  view: string
  /** The view's own name for the ripped-share column, aliased to `opened_pct`. */
  openedColumn: string
  label: string
}

export const PACK_MARKET_BOARDS = {
  allday: {
    view: "v_allday_pack_market",
    openedColumn: "opened_pct_of_minted",
    label: "allday-pack-market",
  },
  topshot: {
    view: "v_topshot_pack_market",
    openedColumn: "depletion_pct",
    label: "topshot-pack-market",
  },
} satisfies Record<string, PackMarketBoardSource>

export type PackMarketBoardKey = keyof typeof PACK_MARKET_BOARDS

export function num(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const EMPTY: Omit<PackMarketBuckets, "ok"> = {
  discount: [],
  premium: [],
  mostTraded: [],
  qualifying: 0,
  lastSaleAt: null,
}

/**
 * Rank one board's sealed-pack rows into discount / premium / most-traded.
 *
 * Pure over the fetched rows so the ranking is testable without a database —
 * which is the point of extracting it, since a `page.tsx` is measured by neither
 * coverage gate.
 */
export function bucketPackMarketRows(rows: PackMarketRow[]): Omit<PackMarketBuckets, "ok"> {
  const ratio = (r: PackMarketRow) => num(r.secondary_vs_retail_ratio)
  // ⚠ A pack with no retail price has no ratio to rank BY — including it would
  // put an unrankable row in a ranking. It still counts toward `qualifying` and
  // can still appear in mostTraded, which is ordered by sales rather than price.
  const priced = rows.filter((r) => (num(r.retail_price) ?? 0) > 0 && ratio(r) != null)
  const discount = priced
    .filter((r) => (ratio(r) ?? 1) < DISCOUNT_MAX_RATIO)
    .sort((a, b) => (ratio(a) ?? 9) - (ratio(b) ?? 9))
    .slice(0, RANK_LIMIT)
  const premium = priced
    .filter((r) => (ratio(r) ?? 0) > PREMIUM_MIN_RATIO)
    .sort((a, b) => (ratio(b) ?? 0) - (ratio(a) ?? 0))
    .slice(0, RANK_LIMIT)
  const mostTraded = rows
    .slice()
    .sort((a, b) => (num(b.n_sales) ?? 0) - (num(a.n_sales) ?? 0))
    .slice(0, RANK_LIMIT)
  const lastSaleAt =
    rows
      .map((r) => r.last_sale_at)
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null
  return { discount, premium, mostTraded, qualifying: rows.length, lastSaleAt }
}

/**
 * Fetch and rank one sealed-pack market board.
 *
 * ⚠ The client is DEFAULTED here rather than passed in by the caller. Both
 * shapes are testable, but only this one lets the page drop its
 * `@/lib/supabase` import — which is the property the server-page data-access
 * ratchet keys on, and the reason a page that merely FORWARDS a client still
 * counts against it. Tests inject `db` explicitly.
 */
export async function fetchPackMarketBuckets(
  board: PackMarketBoardKey,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<PackMarketBuckets> {
  const src = PACK_MARKET_BOARDS[board]
  const select = [
    "dist_id",
    "title",
    "drop_size",
    "retail_price",
    `opened_pct:${src.openedColumn}`,
    "n_sales",
    "n_sales_90d",
    "last_sale_price",
    "last_sale_at",
    "median_price_90d",
    "secondary_vs_retail_ratio",
  ].join(", ")

  const { rows: data, error } = await withPagedBoardBudget(
    fetchAllPaged<PackMarketRow>(
      (from, to) =>
        db
          .from(src.view)
          .select(select)
          .gte("n_sales", MIN_SALES)
          // ⚠ ORDERED, because paging an unordered read can repeat or skip rows
          // between pages — the ranking would then be computed over a set that
          // never existed.
          .order("dist_id", { ascending: true })
          .range(from, to),
      { label: `insights/${src.label}` },
    ),
    src.label,
  )

  if (error) {
    console.error(`[insights/${src.label}] market`, error)
    return { ...EMPTY, ok: false }
  }
  return { ...bucketPackMarketRows((data ?? []) as PackMarketRow[]), ok: true }
}
