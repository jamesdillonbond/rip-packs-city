// lib/emails/weekly-panini.ts
//
// Panini cards in the weekly portfolio email's ONE "Estimated value" (Trevor, 2026-11-25:
// Panini "should be" in Portfolio FMV — the dashboard, public profile and value chart carry it
// too). A Panini owner is a USERNAME, so its value comes from panini_portfolio_daily (one row
// per walked collector per PT day), summed across the member's linked usernames.
//
// HONESTY: a failed read, no linked username, or no priced cards omits the part — never "$0 of
// Panini cards". The weekly change folds in only when EVERY linked username has a row exactly
// 7 days before its newest one, on the same newest day, with the same card count (a week in
// which cards were bought or sold is not a price move); otherwise the value prints alone and
// the change line says it covers the rest.

import { supabaseAdmin } from "@/lib/supabase"
import { dayBefore, linkedPaniniUsernames, readPaniniDays, type PaniniDayRow } from "@/lib/panini/linked-value"
import type { WeeklyHeadline } from "@/lib/emails/weekly-packs"

export type PaniniWeek = { usd: number; cards: number; priorUsd: number | null }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : null
}

function minus7(day: string): string {
  const d = new Date(day + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() - 7)
  return d.toISOString().slice(0, 10)
}

/** Pure: newest day per username, summed; the like-for-like prior when every username has one. */
export function paniniWeekFrom(usernames: string[], rows: PaniniDayRow[]): PaniniWeek | null {
  if (usernames.length === 0) return null
  const byUser = new Map<string, Map<string, PaniniDayRow>>()
  for (const r of rows) {
    if (!byUser.has(r.username)) byUser.set(r.username, new Map())
    byUser.get(r.username)!.set(r.day, r)
  }
  let usd = 0
  let cards = 0
  let prior: number | null = 0
  let newestDay: string | null = null
  for (const u of usernames) {
    const days = byUser.get(u)
    if (!days || days.size === 0) { prior = null; continue }
    const day = [...days.keys()].sort().at(-1)!
    const now = days.get(day)!
    usd += num(now.fmv_usd) ?? 0
    cards += num(now.cards) ?? 0
    const p = days.get(minus7(day))
    if (prior != null) {
      if (!p || (newestDay != null && newestDay !== day) || num(p.cards) !== num(now.cards) || num(p.fmv_usd) == null) prior = null
      else prior += num(p.fmv_usd)!
    }
    newestDay = newestDay ?? day
  }
  usd = Math.round(usd * 100) / 100
  if (usd <= 0) return null
  return { usd, cards, priorUsd: prior != null && prior > 0 ? Math.round(prior * 100) / 100 : null }
}

export async function loadPaniniWeek(userId: string, now: Date = new Date()): Promise<PaniniWeek | null> {
  try {
    const usernames = await linkedPaniniUsernames(supabaseAdmin, userId, "weekly-digest")
    if (!usernames || usernames.length === 0) return null
    const rows = await readPaniniDays(supabaseAdmin, usernames, dayBefore(now, 21), "weekly-digest")
    if (!rows) return null
    return paniniWeekFrom(usernames, rows)
  } catch {
    return null
  }
}

/**
 * Pure: fold the Panini part into the headline. With a like-for-like prior the change covers it
 * too; without one the value grows and the change keeps the scope it had, now marked as not
 * covering the cards ("moments" stays "moments"; "all" becomes "no_cards").
 */
export function withPanini(h: WeeklyHeadline, p: PaniniWeek | null): WeeklyHeadline {
  if (!p) return h
  const valueUsd = Math.round((h.valueUsd + p.usd) * 100) / 100
  if (h.scope === "all" && p.priorUsd != null) {
    const deltaUsd = Math.round((h.deltaUsd + (p.usd - p.priorUsd)) * 100) / 100
    const priorTotal = h.valueUsd - h.deltaUsd + p.priorUsd
    const deltaPct = priorTotal > 0 ? Math.round((deltaUsd / priorTotal) * 10000) / 100 : null
    return { valueUsd, deltaUsd, deltaPct, scope: "all" }
  }
  return { ...h, valueUsd, scope: h.scope === "all" ? "no_cards" : h.scope }
}

const usd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function buildWeeklyPaniniBlock(p: PaniniWeek | null): { html: string; text: string[] } {
  if (!p) return { html: "", text: [] }
  const cards = `${p.cards.toLocaleString("en-US")} Panini card${p.cards === 1 ? "" : "s"}`
  const html = `
    <div style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 20px;margin-bottom:20px">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">Panini cards · included above</div>
      <div style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:800;font-size:24px;line-height:1">${usd(p.usd)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px">${cards} at FMV</div>
    </div>`
  return { html, text: ["", `Panini cards (included above): ${usd(p.usd)} — ${cards} at FMV`] }
}
