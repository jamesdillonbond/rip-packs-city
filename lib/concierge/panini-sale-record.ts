// lib/concierge/panini-sale-record.ts
//
// What a Panini FMV actually rests on, for the concierge (2026-11-08).
//
// The confidence scrubber (lib/concierge/scrub-confidence.ts) turns a HIGH tier
// into "priced from plenty of recent sales". On Panini that sentence is not
// backed by anything the model can see — Panini publishes no 30-day sale count —
// and on 11-07 the concierge read it out for Yan Diomande's Base Choice Prizms
// Elephant (/20, FMV $159, HIGH) while panini_sales held TWO sales of that
// edition, the last on 09-21 (47 days earlier). A collector who had just watched
// the player's cards move called the number stale, and the bot could only
// repeat the tier.
//
// So for a Panini edition the basis is DERIVED from RPC's own recorded sales of
// that edition — how many, how recent — and the tier never reaches the model.
//
// THREE outcomes (CLAUDE.md "Honesty"): read ok with sales · read ok with none
// (said as "no recorded sale", never "no sales") · read FAILED (said as "could
// not check", never as either of the other two).

export interface PaniniSaleRecord {
  sales_on_record: number
  last_sale_at: string | null
  days_since_last_sale: number | null
  recent_sale_prices_usd: number[]
}

export type PaniniSaleRecordRead = { ok: true; record: PaniniSaleRecord } | { ok: false }

const RECENT_N = 5
/** A last sale older than this is said as "may be out of date". */
export const PANINI_SALE_STALE_DAYS = 30
/** Fewer recorded sales than this is said as "treat as rough". */
export const PANINI_THIN_SALES = 3

export function paniniSaleRecordFromRows(
  rows: { sold_at: string | null; amount_usd: number | string | null }[],
  total: number,
  nowMs: number,
): PaniniSaleRecord {
  const dated = rows.filter((r) => typeof r.sold_at === "string" && Number.isFinite(Date.parse(r.sold_at as string)))
  const last = dated[0]?.sold_at ?? null
  const days = last == null ? null : Math.max(0, Math.floor((nowMs - Date.parse(last)) / 86_400_000))
  return {
    sales_on_record: total,
    last_sale_at: last,
    days_since_last_sale: days,
    recent_sale_prices_usd: dated
      .slice(0, RECENT_N)
      .map((r) => Number(r.amount_usd))
      .filter((n) => Number.isFinite(n) && n > 0),
  }
}

/** Plain-language basis the concierge may say. Never a confidence tier. */
export function paniniPricingBasis(read: PaniniSaleRecordRead): string {
  if (!read.ok) return "RPC couldn't check this card's recorded sales just now, so don't describe how many sales back this price"
  const r = read.record
  if (r.sales_on_record === 0) return "RPC has no recorded sale of this edition — the price is estimated without a sale behind it"
  const n = r.sales_on_record
  const sales = `${n} recorded sale${n === 1 ? "" : "s"}`
  const when = r.days_since_last_sale == null ? "" : `, the most recent ${r.days_since_last_sale} day${r.days_since_last_sale === 1 ? "" : "s"} ago`
  if (r.days_since_last_sale != null && r.days_since_last_sale > PANINI_SALE_STALE_DAYS) {
    return `based on ${sales}${when} — may be out of date`
  }
  if (n < PANINI_THIN_SALES) return `based on only ${sales}${when} — treat as rough`
  return `based on ${sales}${when}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniSaleRecord(db: any, editionExternalId: string, nowMs = Date.now()): Promise<PaniniSaleRecordRead> {
  try {
    const [count, recent] = await Promise.all([
      db.from("panini_sales").select("sku", { count: "exact", head: true }).eq("edition_external_id", editionExternalId),
      db
        .from("panini_sales")
        .select("sold_at, amount_usd, sku")
        .eq("edition_external_id", editionExternalId)
        // DESC sorts NULLs FIRST — an undated row must not read as "the latest sale".
        .not("sold_at", "is", null)
        .order("sold_at", { ascending: false })
        .order("sku", { ascending: true })
        .limit(RECENT_N),
    ])
    if (count.error || recent.error || typeof count.count !== "number") return { ok: false }
    return { ok: true, record: paniniSaleRecordFromRows(recent.data ?? [], count.count, nowMs) }
  } catch {
    return { ok: false }
  }
}
