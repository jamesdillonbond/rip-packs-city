// lib/panini/edition-market.ts
//
// Panini's market for ONE edition, for the shared edition page
// (/panini-blockchain/edition/<psku>, opened 2026-09-27). The shared page reads
// `sales` / `wallet_moments_cache` / `edition_offers` for its ask, activity and
// special-serial sections, and Panini has zero rows in all three — its market
// lives in `panini_card_serials` (one row per serial the walk has seen, with the
// serial's ask, listing state and the LAST sale Panini reported for it).
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · Three states per read: `ok:false` (read failed) · `ok:true` + empty ·
//     `ok:true` + rows. A failed read is never rendered as "no listings".
//   · The ask is confirmed only if its serial was re-read in the last
//     PANINI_ASK_CONFIRMED_DAYS (the same 7-day window as panini_market_board and
//     panini_set_progress); the timestamp travels with it so the page can age it.
//   · Last sales are ONE per card — the most recent sale Panini showed when the
//     walk last read that card. It is not a sales history, and the page says so.
//   · No owner username is selected: nothing here needs a person's handle.

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

export const PANINI_ASK_CONFIRMED_DAYS = 7
const LISTED_LIMIT = 25
const SALES_LIMIT = 10

export interface PaniniEditionAsk {
  lowAskUsd: number | null
  listedCount: number | null
  askConfirmedAt: string | null
}

export interface PaniniSerialRow {
  serial: number | null
  mintCap: number | null
  askUsd: number | null
  seenAt: string | null
  lastSaleUsd: number | null
  lastSaleAt: string | null
  flags: string[]
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function flagsOf(r: Record<string, unknown>): string[] {
  const f: string[] = []
  if (r.is_number_one === true) f.push("#1")
  if (r.is_jersey_mint === true) f.push("jersey")
  if (r.is_perfect_mint === true) f.push("last_mint") // notableTagLabel → "Perfect Serial"
  return f
}

export function toSerialRow(r: Record<string, unknown>): PaniniSerialRow {
  return {
    serial: num(r.serial_number),
    mintCap: num(r.mint_cap),
    askUsd: num(r.price_usd),
    seenAt: typeof r.captured_at === "string" ? r.captured_at : null,
    lastSaleUsd: num(r.last_sale_usd),
    lastSaleAt: typeof r.last_sale_at === "string" ? r.last_sale_at : null,
    flags: flagsOf(r),
  }
}

// Every read here runs on the shared edition PAGE (server render), so each goes
// through withQueryDeadline — a wall-clock bound that also aborts the query, and
// one of the budget primitives scripts/check-unbounded-server-reads.mjs
// recognises (boundedRead is an equal 8 s bound but is not on that list, which
// reddened main from 2026-09-27 11:37 AM PT). Same budget as before.
type RawRows = Record<string, unknown>[]

const SERIAL_COLS = "serial_number,mint_cap,price_usd,captured_at,last_sale_usd,last_sale_at,is_number_one,is_jersey_mint,is_perfect_mint"

/** The edition's lowest confirmed ask, from panini_market_board (null when it has none). */
export async function fetchPaniniEditionAsk(
  externalId: string,
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ ask: PaniniEditionAsk | null; ok: boolean }> {
  try {
    const { data, error } = await withQueryDeadline<RawRows>(
      db.from("panini_market_board").select("low_ask_usd,listed_count,ask_confirmed_at").eq("external_id", externalId).limit(1),
      "edition/panini-ask",
      apiReadTimeoutMs(),
    )
    if (error) return { ask: null, ok: false }
    const r = ((data ?? []) as Record<string, unknown>[])[0]
    if (!r) return { ask: null, ok: true }
    return {
      ask: {
        lowAskUsd: num(r.low_ask_usd),
        listedCount: num(r.listed_count),
        askConfirmedAt: typeof r.ask_confirmed_at === "string" ? r.ask_confirmed_at : null,
      },
      ok: true,
    }
  } catch {
    return { ask: null, ok: false }
  }
}

/** Listed serials with a confirmed ask (cheapest first) and the most recent reported last sales. */
export async function fetchPaniniEditionSerials(
  externalId: string,
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ listed: PaniniSerialRow[] | null; sales: PaniniSerialRow[] | null }> {
  const since = new Date(Date.now() - PANINI_ASK_CONFIRMED_DAYS * 86_400_000).toISOString()
  const [listedRes, salesRes] = await Promise.all([
    withQueryDeadline<RawRows>(
      db.from("panini_card_serials").select(SERIAL_COLS)
        .eq("edition_external_id", externalId)
        .eq("is_listed", true)
        .gt("price_usd", 0)
        .gte("captured_at", since)
        .order("price_usd", { ascending: true })
        .order("serial_number", { ascending: true })
        .limit(LISTED_LIMIT),
      "edition/panini-listed",
      apiReadTimeoutMs(),
    ).catch((e: unknown) => ({ data: null, error: e })),
    withQueryDeadline<RawRows>(
      db.from("panini_card_serials").select(SERIAL_COLS)
        .eq("edition_external_id", externalId)
        .not("last_sale_at", "is", null)
        .order("last_sale_at", { ascending: false })
        .order("serial_number", { ascending: true })
        .limit(SALES_LIMIT),
      "edition/panini-sales",
      apiReadTimeoutMs(),
    ).catch((e: unknown) => ({ data: null, error: e })),
  ])
  return {
    listed: listedRes.error ? null : ((listedRes.data ?? []) as Record<string, unknown>[]).map(toSerialRow),
    sales: salesRes.error ? null : ((salesRes.data ?? []) as Record<string, unknown>[]).map(toSerialRow),
  }
}

/** The public Panini marketplace page for an edition (same shape the Market tab links). */
export function paniniEditionUrl(externalId: string | null | undefined): string | null {
  if (!externalId || !/^packcard-[0-9_]+$/.test(externalId)) return null
  return `https://nft.paniniamerica.net/marketplace-details/${encodeURIComponent(externalId)}.html`
}

export { paniniSubjectIsPlayer } from "@/lib/panini/subjects"
