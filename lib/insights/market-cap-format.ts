// lib/insights/market-cap-format.ts
//
// Display formatters for the Market Cap board. Kept apart from the fetcher in
// market-cap-board.ts so they stay pure (no DB client in the module). A null /
// non-finite input renders "—" — an unknown figure is never printed as $0.

import { usdSignFirst } from "@/lib/usd-format"

export function fmtUsdCompact(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const neg = usdSignFirst(n, fmtUsdCompact)
  if (neg != null) return neg
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

export function fmtCount(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return Math.round(n).toLocaleString("en-US")
}
