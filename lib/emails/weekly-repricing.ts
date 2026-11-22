// lib/emails/weekly-repricing.ts
//
// "How much of this week's change is OUR repricing" — for the weekly portfolio email.
//
// WHY (2026-11-22, before the first send on Mon 11-23): six FMV restatement migrations on 11-16/17
// lowered ~1,000 Top Shot / All Day editions (fmv_restatements). Tomorrow's movers read "−49.6 % this
// week" for two members; for the first, −$27,587 of the −$37,619 is our own price correction on 18
// held editions. A bare "Down 49.6 % this week" tells a collector the market halved their portfolio.
//
// The headline stays the computed change (it is what our estimate of their holdings did). Beneath it,
// a line states the repricing part; when repricing is at least half of the move, the subject drops
// the percentage. Source: get_weekly_repricing_impact (20261122221721), the same comparison window.
//
// HONESTY: a failed read is NOT "no repricing". The loader returns { ok: false } and the route skips
// the member (counted as incomplete), exactly as it does for any other figure the email cannot read.

import { supabaseAdmin } from "@/lib/supabase"

export type Repricing = { deltaUsd: number; editions: number }
export type RepricingRead = { ok: true; repricing: Repricing } | { ok: false }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** Pure: the RPC payload → a Repricing, or null when the payload is not a readable answer. */
export function repricingFrom(payload: unknown): Repricing | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  const deltaUsd = num(p.delta_usd)
  const editions = num(p.editions)
  if (deltaUsd == null || editions == null || editions < 0) return null
  return { deltaUsd, editions }
}

export async function loadRepricing(ownerKey: string, priorDate: string | null, latestDate: string | null): Promise<RepricingRead> {
  if (!priorDate || !latestDate) return { ok: false }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any).rpc("get_weekly_repricing_impact", {
      p_owner_key: ownerKey,
      p_prior_date: priorDate,
      p_latest_date: latestDate,
    })
    if (error) return { ok: false }
    const repricing = repricingFrom(data)
    return repricing ? { ok: true, repricing } : { ok: false }
  } catch {
    return { ok: false }
  }
}

const usd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** True when the repricing moved the estimate by at least a dollar (smaller is not worth a line). */
export function hasRepricing(r: Repricing | null): r is Repricing {
  return r != null && r.editions > 0 && Math.abs(r.deltaUsd) >= 1
}

/** True when our repricing is at least half of the week's move — the subject should not headline a %. */
export function repricingDominates(r: Repricing | null, weekDeltaUsd: number): boolean {
  return hasRepricing(r) && Math.abs(r.deltaUsd) >= 0.5 * Math.abs(weekDeltaUsd)
}

/** One line for the email (HTML-safe text; the route styles it). Null when there is nothing to say. */
export function repricingLine(r: Repricing | null): string | null {
  if (!hasRepricing(r)) return null
  const sign = r.deltaUsd < 0 ? "−" : "+"
  const eds = `${r.editions.toLocaleString("en-US")} of your editions`
  return `Includes about ${sign}${usd(Math.abs(r.deltaUsd))} from our price corrections on ${eds} this week — not market moves.`
}
