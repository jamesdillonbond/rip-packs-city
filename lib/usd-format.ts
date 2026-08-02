// lib/usd-format.ts
//
// THE canonical USD formatter for the "whole dollars at $1,000+" convention.
//
// `fmtUsd` was independently implemented ~10 times across lib/ with divergent
// behaviour (round-to-whole at never / $100 / $1,000 / integers-only; null as
// "—" vs "$0"), so $1,500.50 rendered as "$1,501" or "$1,500.50" depending on
// which page you were looking at. This module holds the single most-duplicated
// variant so the surfaces that genuinely share a convention share one body.
//
// ⚠ NOT every fmtUsd can collapse into this — the remaining ones differ in
// ways that are load-bearing for their surface and merging them would CHANGE
// rendered output:
//   • lib/analytics/format      — always 2dp, no rounding (analytics tables)
//   • lib/pack-dist-format      — rounds at |v| >= 100, not 1000
//   • lib/pack-lifecycle-format — rounds integers only ("$20" but "$20.50")
//   • lib/dashboard-format      — "$0" for falsy, no em-dash
//   • lib/market-format         — same shape, different sub-$1k grouping call
//   • lib/trophy-picker-format  — "—" for null but "$0" for a hard zero
// Those keep their own bodies, documented in place.
//
// HOUSE CONVENTION (deliberate, pinned by tests across several modules):
// negatives render as "$-50.00" / "$-1,500", NOT "-$50.00". Do not "fix" it.

/**
 * USD with whole dollars at |v| >= $1,000 and 2 decimals below; em-dash for
 * null / undefined / non-finite (never a fake "$0").
 */
export function fmtUsdWhole1000(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  if (Math.abs(v) >= 1000) return "$" + Math.round(v).toLocaleString("en-US")
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
