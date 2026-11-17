// lib/panini/sales-analytics-read.ts
//
// Server read for the Panini Analytics tab: panini_sales_analytics (migrations 20260929023845, 20260929063123),
// bounded by withBoardBudget. 2.8 s cold / 0.8 s warm over 52k rows, then 0.2 s warm once top sales
// came off a price index (20260929063123, 2026-09-28); the page is ISR,
// and ISR caches a failed read for its whole window (#33), so the bound sits well inside a page
// function's own budget. Re-measure as panini_sales grows. Any failure is null — the tab renders
// "couldn't load", never zeros.
//
// ⚠ 2026-10-10: it reads panini_sales_analytics_cached (20261010171045), not the function itself. The
// live payload measured 3.8 s warm / 285k buffers with a temp spill, and a cold read on a fresh
// deploy passed the 10 s budget (prod log 10:04 AM PT), so ISR served "couldn't load" for 300 s.
// The cached wrapper returns the 30-min snapshot (1.4 ms / 209 buffers) only while it is younger
// than 75 min, and otherwise computes live, so a dead refresher degrades to the old slow read.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { parsePaniniSalesAnalytics } from "@/lib/panini/sales-analytics"
import type { PaniniSalesAnalytics } from "@/components/collection/PaniniAnalytics"

export const PANINI_ANALYTICS_BUDGET_MS = 10_000

export async function fetchPaniniSalesAnalytics(
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
  days = 30,
): Promise<PaniniSalesAnalytics | null> {
  try {
    const { data, error } = await withBoardBudget<{ data: unknown; error: unknown }>(
      Promise.resolve(db.rpc("panini_sales_analytics_cached", { p_days: days })),
      "sales-analytics",
      PANINI_ANALYTICS_BUDGET_MS,
      "panini/",
    )
    if (error) {
      console.error("[panini/sales-analytics] read failed")
      return null
    }
    return parsePaniniSalesAnalytics(data)
  } catch {
    console.error("[panini/sales-analytics] read failed or timed out")
    return null
  }
}
