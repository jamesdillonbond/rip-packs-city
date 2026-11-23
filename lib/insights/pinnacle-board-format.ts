// lib/insights/pinnacle-board-format.ts
//
// Formatters shared by the Disney Pinnacle insights pages (pack reality, serial premiums, squeeze). PURE.
// A null is "—", never $0 / 0× (CLAUDE.md "Honesty").

import { usdSignFirst } from "@/lib/usd-format"

export function fmtBoardUsd(v: number | null | undefined): string {
  const neg = usdSignFirst(v ?? null, fmtBoardUsd); if (neg !== null) return neg
  if (v == null || !Number.isFinite(v)) return "—"
  if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

/** A calendar day in Pacific time — a fixed zone, so server and client renders agree (#418). */
export function fmtBoardDay(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

export function fmtMultiplier(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—"
  return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}×`
}
