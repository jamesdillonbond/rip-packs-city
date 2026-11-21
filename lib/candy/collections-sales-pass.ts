// lib/candy/collections-sales-pass.ts
//
// HOURLY SALES PASS over every non-registry Candy collection (2026-11-21; Trevor: "figure out
// why it takes us so long to get this" → "I approve … proceeding to take care of this").
//
// Why it exists. The rotating market lane (collections-market.ts) does symbol + stats + sales +
// listings per collection and reaches only ~110 of ~357 collections in its 4-minute run, so a
// collection's new sales were seen about once every 8 h, then waited for the 3-hourly drain:
// measured 11-14 → 11-21, 115 of 124 Candy sales came this way, median 6.2 h from sale to
// `sales`, worst 25 h. A $1,599 Paul Skenes 2025 All-Star ICONS 1/1 (11-21 2:23 PM PT) was not
// due on the board until ~7:30 PM PT.
//
// What it does. Sales ONLY: one small activity page per collection (100, newest first) back to the
// collection's sales_high_water_at, the new sales offered to the same drain queue the rotating
// lane uses (offerSales — same dedup, same reason), so `candy-sales-indexer` stays the ONE writer
// of Candy `sales`. Collections are taken MOST-RECENTLY-ACTIVE first (high-water mark desc), so
// if the budget runs out it is the dormant tail that waits for the rotating lane, never an active
// collection.
//
// What it does NOT do. It never writes market_checked_at (that is the rotating lane's rotation
// order) nor stats, symbols or listings. A collection with no symbol, or no high-water mark yet
// (its first walk is the rotating lane's, up to 31 pages), is skipped and counted. A collection
// with more new activity than SALES_PASS_MAX_PAGES pages is OFFERED what was read but its
// high-water mark is NOT advanced (`incomplete`): the rotating lane's deeper walk finishes it.
//
// Honesty: the high-water mark advances only behind a walk that reached it inside the budget and
// whose every offer landed, and only FORWARD (a conditional update: it never moves a mark the
// rotating lane advanced past ours meanwhile). A failed collection fails the run.

import { meClient, offerSales, SALE_TYPES, type FetchFn, type MeActivity } from "@/lib/candy/collections-market"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const SALES_PASS_LIMIT = 100
export const SALES_PASS_MAX_PAGES = 5

export interface SalesPassCollection {
  name: string
  symbol: string
  pages: number
  sales_seen: number
  sales_offered: number
  incomplete: boolean
  high_water_advanced: boolean
  error: string | null
}

export interface SalesPassResult {
  ok: boolean
  queued: number
  checked: number
  skipped_no_high_water: number
  not_reached: number
  budget_stopped: boolean
  sales_seen: number
  sales_offered: number
  high_water_advanced: number
  incomplete: number
  collections: SalesPassCollection[]
  error: string | null
}

export async function runCollectionsSalesPass(
  db: Db,
  opts: { budgetMs: number; now?: () => number; fetchImpl?: FetchFn; pauseMs?: number },
): Promise<SalesPassResult> {
  const now = opts.now ?? Date.now
  const doFetch: FetchFn = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const me = meClient(doFetch, opts.pauseMs ?? 250)
  const deadline = now() + opts.budgetMs
  const out: SalesPassResult = {
    ok: false, queued: 0, checked: 0, skipped_no_high_water: 0, not_reached: 0, budget_stopped: false,
    sales_seen: 0, sales_offered: 0, high_water_advanced: 0, incomplete: 0, collections: [], error: null,
  }

  const { data: queue, error: qErr } = await db
    .from("candy_collections")
    .select("address,name,me_symbol,sales_high_water_at")
    .neq("kind", "test")
    .eq("census", false)
    .not("set_id", "is", null)
    .not("me_symbol", "is", null)
    .order("sales_high_water_at", { ascending: false, nullsFirst: false })
    .order("address", { ascending: true })
    .limit(1000)
  if (qErr) {
    out.error = `queue read failed: ${qErr.message ?? String(qErr)}`
    return out
  }
  type Row = { address: string; name: string; me_symbol: string; sales_high_water_at: string | null }
  const rows = (queue ?? []) as Row[]
  out.queued = rows.length

  const errors: string[] = []
  for (let idx = 0; idx < rows.length; idx++) {
    const c = rows[idx]
    if (now() > deadline) {
      out.budget_stopped = true
      out.not_reached = rows.length - idx
      break
    }
    if (!c.sales_high_water_at) { out.skipped_no_high_water++; continue }
    const hwMs = new Date(c.sales_high_water_at).getTime()
    const rep: SalesPassCollection = {
      name: c.name, symbol: c.me_symbol, pages: 0, sales_seen: 0, sales_offered: 0,
      incomplete: false, high_water_advanced: false, error: null,
    }
    out.collections.push(rep)
    out.checked++
    try {
      let newestMs: number | null = null
      let reachedFloor = false
      let budgetStop = false
      const sales: MeActivity[] = []
      for (let page = 0; page < SALES_PASS_MAX_PAGES; page++) {
        if (now() > deadline) { budgetStop = true; break }
        const acts = ((await me(`/collections/${encodeURIComponent(c.me_symbol)}/activities?offset=${page * SALES_PASS_LIMIT}&limit=${SALES_PASS_LIMIT}`)) ?? []) as MeActivity[]
        rep.pages++
        for (const a of acts) {
          const tMs = (a.blockTime ?? 0) * 1000
          if (newestMs === null || tMs > newestMs) newestMs = tMs
          if (tMs <= hwMs) { reachedFloor = true; continue }
          if (a.type && SALE_TYPES.has(a.type) && a.signature && a.tokenMint) sales.push(a)
        }
        if (reachedFloor || acts.length < SALES_PASS_LIMIT) { reachedFloor = true; break }
      }
      rep.sales_seen = sales.length
      out.sales_seen += sales.length
      rep.incomplete = !reachedFloor && !budgetStop
      if (rep.incomplete) out.incomplete++

      await offerSales(db, sales, () => { rep.sales_offered++; out.sales_offered++ })

      if (reachedFloor && !budgetStop && newestMs !== null && newestMs > hwMs) {
        const iso = new Date(newestMs).toISOString()
        // Forward only: the rotating lane may have advanced this mark since we read it.
        const { error } = await db
          .from("candy_collections")
          .update({ sales_high_water_at: iso })
          .eq("address", c.address)
          .lt("sales_high_water_at", iso)
        if (error) throw new Error(`high-water write: ${error.message}`)
        rep.high_water_advanced = true
        out.high_water_advanced++
      }
    } catch (e) {
      rep.error = (e instanceof Error ? e.message : String(e)).slice(0, 200)
      errors.push(`${c.name}: ${rep.error}`)
    }
  }

  out.error = errors.length ? errors.slice(0, 5).join(" | ").slice(0, 900) : null
  out.ok = errors.length === 0
  return out
}
