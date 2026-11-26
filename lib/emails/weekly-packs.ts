// lib/emails/weekly-packs.ts
//
// "Sealed packs" line for the weekly portfolio email (Trevor, 2026-11-22: "Both" — the
// sealed-pack value recorded beside each nightly portfolio snapshot shows on the dashboard
// chart AND in the weekly email).
//
// Source: portfolio_snapshots.pack_low_ask_usd / pack_held_count (filled nightly since
// 2026-11-22 by fill_portfolio_snapshot_pack_values: lowest live ask per held sealed pack,
// capped at 3x the drop's best reference; a never-sold listing adds nothing). Since 2026-11-22
// evening it IS in the email's "Estimated value" (weeklyHeadline), and this block is its breakdown.
//
// HONESTY: optional block. A failed read, or no pack value for the member's latest snapshot,
// omits the line — never "$0 in sealed packs". The week-over-week change prints only when the
// snapshot exactly 7 days earlier carries a pack value too (none exist before 2026-11-22, so
// the first emails show the value alone).
//
// 2026-11-22 (~1:53 PM PT, before the first send): the body now does what this header says.
//   * A value of 0 with packs held is NOT a price: fill_portfolio_snapshot_pack_values writes
//     0 when none of the held packs has a live ask (5 members on 11-22: held 1, listed 0). Only
//     a positive value is shown; 0 omits the block, and a 0 prior gives no weekly change.
//   * "latest" is the member's newest snapshot, not the newest one that happens to carry a
//     value — an unfilled night must omit the block, not print an older night as this week's.
//   * When some held packs have no live ask, the count says so ("3 of 4 sealed packs").

import { supabaseAdmin } from "@/lib/supabase"

export type PackWeek = { lowAskUsd: number; held: number; listed: number | null; priorUsd: number | null }

type Row = { snapshot_date: string; pack_low_ask_usd: number | string | null; pack_held_count: number | null; pack_listed_count?: number | null; pack_value_basis?: string | null }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** YYYY-MM-DD minus n days, in UTC (snapshot dates are UTC calendar days). */
export function minusDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** A positive pack value, else null: 0 means no held pack had a live ask (unpriced, not $0). */
const priced = (v: unknown): number | null => {
  const n = num(v)
  return n != null && n > 0 ? n : null
}

/** Pure: the member's newest snapshot (if it carries a priced pack value), and the one 7 days before it. */
export function packWeekFrom(rows: Row[]): PackWeek | null {
  const byDate = new Map(rows.map((r) => [r.snapshot_date, r]))
  const latest = [...rows].sort((a, b) => (a.snapshot_date < b.snapshot_date ? 1 : -1))[0]
  if (!latest) return null
  const lowAskUsd = priced(latest.pack_low_ask_usd)
  if (lowAskUsd == null) return null
  const held = num(latest.pack_held_count) ?? 0
  if (held <= 0) return null
  const listed = num(latest.pack_listed_count)
  const prior = byDate.get(minusDays(latest.snapshot_date, 7))
  // Like-for-like only (2026-11-22, review of 88731d9fc): a week in which the member bought or opened packs, or
  // in which a pack gained or lost its live ask, is not a price move. Show the change only when the held AND
  // listed counts are the same as the prior week's; otherwise the value prints alone.
  // 2026-11-22 (later): a prior night BACKFILLED by backfill_portfolio_snapshot_pack_values (20261122231506)
  // carries an estimate (pack_value_basis = hourly_ask / carried_back_ask), not a measurement: a change
  // against it would print our estimation error as "this week".
  const sameHoldings = prior != null
    && (prior.pack_value_basis == null || prior.pack_value_basis === "")
    && (latest.pack_value_basis == null || latest.pack_value_basis === "")
    && num(prior.pack_held_count) === held
    && num(prior.pack_listed_count ?? null) === listed
  return { lowAskUsd, held, listed: listed != null && listed < held ? listed : null, priorUsd: prior && sameHoldings ? priced(prior.pack_low_ask_usd) : null }
}

export async function loadPackWeek(userId: string): Promise<PackWeek | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("portfolio_snapshots")
      .select("snapshot_date, pack_low_ask_usd, pack_held_count, pack_listed_count, pack_value_basis")
      .eq("owner_key", userId)
      .order("snapshot_date", { ascending: false })
      .limit(10)
    if (error || !Array.isArray(data)) return null
    return packWeekFrom(data as Row[])
  } catch {
    return null
  }
}

const usd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The email's ONE "Estimated value" (2026-11-22, Trevor: one number for everything in the wallet,
 * "Yes proceed" to the email): moments + sealed packs. The weekly change covers both only when the
 * pack value has a like-for-like, live-measured prior (packWeekFrom's rules); otherwise the change
 * is the MOMENTS' change and says so (`scope: "moments"`) — never a moments-only move printed under
 * a total as if it were the total's.
 */
// "no_cards" (2026-11-25): moments + packs change; linked Panini cards are in the value but had no like-for-like prior.
export type WeeklyHeadline = { valueUsd: number; deltaUsd: number; deltaPct: number | null; scope: "all" | "moments" | "no_cards" }

export function weeklyHeadline(
  m: { latest_fmv: number; prior_fmv?: number | null; delta_usd: number; delta_pct: number },
  p: PackWeek | null,
): WeeklyHeadline {
  if (!p) return { valueUsd: m.latest_fmv, deltaUsd: m.delta_usd, deltaPct: m.delta_pct, scope: "all" }
  const valueUsd = Math.round((m.latest_fmv + p.lowAskUsd) * 100) / 100
  const priorMoments = typeof m.prior_fmv === "number" && Number.isFinite(m.prior_fmv) ? m.prior_fmv : null
  if (p.priorUsd != null && priorMoments != null) {
    const deltaUsd = Math.round((m.delta_usd + (p.lowAskUsd - p.priorUsd)) * 100) / 100
    const priorTotal = priorMoments + p.priorUsd
    const deltaPct = priorTotal > 0 ? Math.round((deltaUsd / priorTotal) * 10000) / 100 : null
    return { valueUsd, deltaUsd, deltaPct, scope: "all" }
  }
  return { valueUsd, deltaUsd: m.delta_usd, deltaPct: m.delta_pct, scope: "moments" }
}

export function buildWeeklyPacksBlock(p: PackWeek | null): { html: string; text: string[] } {
  if (!p) return { html: "", text: [] }
  // 2026-11-22 (evening): the pack value is now INSIDE the email's Estimated value (weeklyHeadline),
  // so this block is the breakdown line, not a second number — and its own weekly change folds into
  // the headline's change when it is known.
  // `listed` is set only when some held packs have no live ask: say how many the value covers.
  const packs = p.listed != null
    ? `${p.listed.toLocaleString("en-US")} of ${p.held.toLocaleString("en-US")} sealed packs`
    : `${p.held.toLocaleString("en-US")} sealed pack${p.held === 1 ? "" : "s"}`
  const html = `
    <div style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 20px;margin-bottom:20px">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">Sealed packs · included above</div>
      <div style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:800;font-size:24px;line-height:1">${usd(p.lowAskUsd)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px">${packs} at the lowest live ask</div>
    </div>`
  const text = ["", `Sealed packs (included above): ${usd(p.lowAskUsd)} — ${packs} at the lowest live ask`]
  return { html, text }
}
