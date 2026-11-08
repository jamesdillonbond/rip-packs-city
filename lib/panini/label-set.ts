// lib/panini/label-set.ts
//
// Which naming a Panini entity page uses (2026-11-08). Panini is ONE collection
// mixing sports products with Entertainment lines (The Rolling Stones, Bad Egg
// Co., Moonbirds); a team / player / set page resolves its product from the
// editions it shows — a Panini edition id embeds its product
// (`packcard-<set_id>_…`) — and reads that product's label set from the registry:
//   panini_products.label_set, else "entertainment" when its grid sport is
//   "Entertainment", else "sports".
// The same rule decides, in sync_panini_products_bridge, that an entertainment
// figure is never minted as a players row.
//
// A failed read falls back to the sports nouns (it only changes a heading word,
// never a figure) and is logged — it must not fail the page.

import { supabaseAdmin } from "@/lib/supabase"
import type { PaniniLabelSet } from "@/lib/entity-labels"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

const PANINI_COLLECTION_ID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"
// A heading word must never hold a page: each read is bounded and a timeout is the
// same sports fallback as a failed read.
const LABEL_READ_BUDGET_MS = 1500

export type ProductLabelRow = { label_set: string | null; last_grid_sport: string | null }

/** The registry rule, shared with the products bridge (see its 2026-11-08 splice). */
export function effectiveLabelSet(row: ProductLabelRow | null | undefined): PaniniLabelSet {
  const ls = row?.label_set
  if (ls === "sports" || ls === "entertainment" || ls === "music") return ls
  return row?.last_grid_sport === "Entertainment" ? "entertainment" : "sports"
}

/** `packcard-2130_415500_32` → 2130. Null for an id that names no product. */
export function productSetIdOf(externalId: string | null | undefined): number | null {
  const m = /^packcard-(\d+)_/.exec(String(externalId ?? ""))
  return m ? Number(m[1]) : null
}

/**
 * One label set for a page whose editions span these products: the set they
 * all share, else "sports" (a mixed page keeps the general nouns).
 */
export function labelSetForProducts(rows: ProductLabelRow[]): PaniniLabelSet {
  const sets = new Set(rows.map(effectiveLabelSet))
  return sets.size === 1 ? [...sets][0] : "sports"
}

type Column = "team_name" | "player_name" | "set_name"

/**
 * The label set for a Panini page about `name` in `column` (a team / player / set
 * page). Reads ≤ 50 of its editions, then their products. Never throws.
 */
export async function paniniLabelSetFor(column: Column, name: string | null | undefined): Promise<PaniniLabelSet> {
  const n = String(name ?? "").trim()
  if (!n) return "sports"
  try {
    const db: any = supabaseAdmin
    const { data: eds, error: edErr } = await withBoardBudget(
      Promise.resolve(db.from("editions").select("external_id").eq("collection_id", PANINI_COLLECTION_ID).eq(column, n).limit(50)),
      "label-set/editions", LABEL_READ_BUDGET_MS, "panini/",
    ) as { data: unknown; error: { message: string } | null }
    if (edErr || !Array.isArray(eds)) {
      if (edErr) console.warn("[panini-label-set] editions read failed:", edErr.message)
      return "sports"
    }
    const ids = [...new Set((eds as Array<{ external_id: string }>).map((e) => productSetIdOf(e.external_id)).filter((x): x is number => x != null))]
    if (ids.length === 0) return "sports"
    const { data: prods, error: prErr } = await withBoardBudget(
      Promise.resolve(db.from("panini_products").select("label_set, last_grid_sport").in("set_id", ids).limit(50)),
      "label-set/products", LABEL_READ_BUDGET_MS, "panini/",
    ) as { data: unknown; error: { message: string } | null }
    if (prErr || !Array.isArray(prods) || prods.length === 0) {
      if (prErr) console.warn("[panini-label-set] products read failed:", prErr.message)
      return "sports"
    }
    return labelSetForProducts(prods as ProductLabelRow[])
  } catch (e) {
    console.warn("[panini-label-set] threw:", e instanceof Error ? e.message : String(e))
    return "sports"
  }
}
