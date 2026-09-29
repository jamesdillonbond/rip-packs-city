// lib/panini/player-sales.ts
//
// A Panini player's sales across all their editions, for the player page (2026-09-28), over
// panini_sales (every sale the walk reads, kept since 2026-09-28). Server only.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · "Top" and "recent" are among the sales RPC HOLDS, and the payload says how many of the
//     player's editions have their sales fully on record (panini_sales_reads), so the page can
//     say how complete the lists are.
//   · Each read fails on its own to null — a failed read is never "no sales".

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import { serialOfSku } from "@/lib/panini/edition-market"

const PANINI_COLLECTION_ID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"
/** Editions per player read for the sales lists. The largest Panini player has 33 (Cristiano Ronaldo, measured 2026-09-28). */
const MAX_EDITIONS = 300
const LIST = 10

export interface PaniniPlayerSale {
  editionKey: string
  setName: string | null
  serial: number | null
  mintCap: number | null
  amountUsd: number
  soldAt: string
}

export interface PaniniPlayerSales {
  top: PaniniPlayerSale[] | null
  recent: PaniniPlayerSale[] | null
  editions: number | null
  /** Editions whose sales are fully on record (whole history, or complete since a moment). */
  editionsRead: number | null
}

type Rows = Record<string, unknown>[]
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function fetchPaniniPlayerSales(
  playerId: string,
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<PaniniPlayerSales> {
  const failed: PaniniPlayerSales = { top: null, recent: null, editions: null, editionsRead: null }
  let eds: Rows
  try {
    const { data, error } = await withQueryDeadline<Rows>(
      db.from("editions").select("external_id,set_name")
        .eq("collection_id", PANINI_COLLECTION_ID)
        .eq("player_id", playerId)
        .order("external_id", { ascending: true })
        .limit(MAX_EDITIONS),
      "player/panini-editions",
      apiReadTimeoutMs(),
    )
    if (error) return failed
    eds = (data ?? []) as Rows
  } catch {
    return failed
  }
  const setByKey = new Map<string, string | null>()
  for (const e of eds) if (typeof e.external_id === "string") setByKey.set(e.external_id, typeof e.set_name === "string" ? e.set_name : null)
  const keys = [...setByKey.keys()]
  if (keys.length === 0) return { top: [], recent: [], editions: 0, editionsRead: 0 }

  const read = (order: "amount_usd" | "sold_at") =>
    withQueryDeadline<Rows>(
      db.from("panini_sales").select("sku,edition_external_id,sold_at,amount_usd")
        .in("edition_external_id", keys)
        .order(order, { ascending: false })
        .order("sku", { ascending: true })
        .limit(LIST),
      `player/panini-sales-${order}`,
      apiReadTimeoutMs(),
    ).catch((e: unknown) => ({ data: null, error: e }))
  const [topRes, recentRes, readsRes] = await Promise.all([
    read("amount_usd"),
    read("sold_at"),
    withQueryDeadline<Rows>(
      db.from("panini_sales_reads").select("edition_external_id", { count: "exact", head: true })
        .in("edition_external_id", keys)
        .not("complete_since", "is", null),
      "player/panini-sales-reads",
      apiReadTimeoutMs(),
    ).catch((e: unknown) => ({ data: null, error: e, count: null })),
  ])
  const map = (res: { data: unknown; error: unknown }): PaniniPlayerSale[] | null => {
    if (res.error) return null
    const out: PaniniPlayerSale[] = []
    for (const r of (res.data ?? []) as Rows) {
      const sku = typeof r.sku === "string" ? r.sku : null
      const key = typeof r.edition_external_id === "string" ? r.edition_external_id : null
      const amount = num(r.amount_usd)
      const soldAt = typeof r.sold_at === "string" ? r.sold_at : null
      if (!sku || !key || amount === null || !soldAt) continue
      out.push({ editionKey: key, setName: setByKey.get(key) ?? null, ...serialOfSku(sku), amountUsd: amount, soldAt })
    }
    return out
  }
  const readsCount = (readsRes as { count?: unknown }).count
  return {
    top: map(topRes),
    recent: map(recentRes),
    editions: keys.length,
    editionsRead: readsRes.error || typeof readsCount !== "number" ? null : readsCount,
  }
}
