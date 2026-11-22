// lib/emails/weekly-packs.ts
//
// "Sealed packs" line for the weekly portfolio email (Trevor, 2026-11-22: "Both" — the
// sealed-pack value recorded beside each nightly portfolio snapshot shows on the dashboard
// chart AND in the weekly email).
//
// Source: portfolio_snapshots.pack_low_ask_usd / pack_held_count (filled nightly since
// 2026-11-22 by fill_portfolio_snapshot_pack_values: lowest live ask per held sealed pack,
// capped at 3x the drop's best reference; a never-sold listing adds nothing). It is NOT in the
// email's "Estimated value" (moments), and the line says so by standing apart.
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

type Row = { snapshot_date: string; pack_low_ask_usd: number | string | null; pack_held_count: number | null; pack_listed_count?: number | null }

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
  const sameHoldings = prior != null
    && num(prior.pack_held_count) === held
    && num(prior.pack_listed_count ?? null) === listed
  return { lowAskUsd, held, listed: listed != null && listed < held ? listed : null, priorUsd: prior && sameHoldings ? priced(prior.pack_low_ask_usd) : null }
}

export async function loadPackWeek(userId: string): Promise<PackWeek | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("portfolio_snapshots")
      .select("snapshot_date, pack_low_ask_usd, pack_held_count, pack_listed_count")
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

export function buildWeeklyPacksBlock(p: PackWeek | null): { html: string; text: string[] } {
  if (!p) return { html: "", text: [] }
  // `listed` is set only when some held packs have no live ask: say how many the value covers.
  const packs = p.listed != null
    ? `${p.listed.toLocaleString("en-US")} of ${p.held.toLocaleString("en-US")} sealed packs`
    : `${p.held.toLocaleString("en-US")} sealed pack${p.held === 1 ? "" : "s"}`
  let change = ""
  let changeText = ""
  if (p.priorUsd != null) {
    const d = Math.round((p.lowAskUsd - p.priorUsd) * 100) / 100
    const up = d >= 0
    change = `<div style="font-size:13px;color:${up ? "#16A34A" : "#DC2626"};margin-top:6px;font-weight:700">${up ? "▲" : "▼"} ${usd(Math.abs(d))} this week</div>`
    changeText = `${up ? "Up" : "Down"} ${usd(Math.abs(d))} this week`
  }
  const html = `
    <div style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 20px;margin-bottom:20px">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">Sealed packs · not in the value above</div>
      <div style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:800;font-size:24px;line-height:1">${usd(p.lowAskUsd)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px">${packs} at the lowest live ask</div>${change}
    </div>`
  const text = ["", `Sealed packs (not in the value above): ${usd(p.lowAskUsd)} — ${packs} at the lowest live ask`, ...(changeText ? [changeText] : [])]
  return { html, text }
}
