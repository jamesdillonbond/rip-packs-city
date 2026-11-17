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
// HOUSE CONVENTION (Trevor, 2026-09-25, #137 b — replaced the old "$-50.00"):
// negatives render SIGN-FIRST, "-$50.00" / "-$1,500". Use usdSignFirst() below.

/**
 * USD with whole dollars at |v| >= $1,000 and 2 decimals below; em-dash for
 * null / undefined / non-finite (never a fake "$0").
 */
export function fmtUsdWhole1000(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtUsdWhole1000); if (neg !== null) return neg
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  if (Math.abs(v) >= 1000) return "$" + Math.round(v).toLocaleString("en-US")
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * NEGATIVE USD RENDERS SIGN-FIRST: "-$50.34", never "$-50.34" (Trevor,
 * 2026-09-25, #137 b — this replaces the old "$-" house convention).
 *
 * Call it first in a formatter and return its result when non-null:
 *
 *   const neg = usdSignFirst(n, fmtX); if (neg !== null) return neg
 *
 * It formats the MAGNITUDE with the formatter itself, so a threshold such as
 * `n >= 1_000 → "$1.5k"` also applies to a loss (−1500 → "-$1.5k", where the old
 * shape printed "$-1500"). Returns null for anything that is not a finite
 * negative number, so the formatter's own null / zero / positive handling is
 * untouched. `__tests__/usd-negative-sign-first.test.ts` calls every exported
 * formatter under lib/ with negatives and fails on any "$-".
 */
export function usdSignFirst(n: unknown, format: (magnitude: number) => string): string | null {
  const v = typeof n === "string" && n.trim() !== "" ? Number(n) : n
  if (typeof v !== "number" || !Number.isFinite(v) || v >= 0) return null
  const body = format(-v)
  return body.startsWith("$") ? "-" + body : body
}

// ── Dollar-pegged units never show their ticker (Trevor, 2026-09-25) ─────────
//
// DUC (Dapper Utility Coin) is pegged 1:1 to the US dollar: a pack that cost
// 10 DUC cost $10, and the site never prints the word "DUC" — it shows the
// amount exactly as it would show dollars. The same goes for a literal "USD"
// tag (a "$10.00 USD" is the same redundancy). Any OTHER unit (FLOW, USDC,
// FUT …) keeps its code, because there the number is not a dollar figure.
// `__tests__/site-copy-never-says-duc.test.ts` walks app/, components/ and
// lib/ for a user-facing "DUC" string.

/** True for the units a formatter renders as plain dollars: USD, DUC, and an
 *  absent/blank unit (the platform's price columns are dollar-denominated). */
export function isUsdPegged(currency: unknown): boolean {
  if (currency == null) return true
  if (typeof currency !== "string") return false
  const c = currency.trim().toUpperCase()
  return c === "" || c === "USD" || c === "DUC"
}

/** The suffix to append after a "$…" figure: "" for a dollar-pegged unit,
 *  " FLOW" / " USDC" for anything else. */
export function currencySuffix(currency: unknown): string {
  if (isUsdPegged(currency)) return ""
  return typeof currency === "string" ? " " + currency.trim() : ""
}

/** The unit to print on its own (a "Currency" detail cell): "USD" for a
 *  dollar-pegged unit, the code itself otherwise, "—" for none. */
export function displayCurrency(currency: unknown): string {
  if (currency == null || (typeof currency === "string" && currency.trim() === "")) return "—"
  return isUsdPegged(currency) ? "USD" : typeof currency === "string" ? currency.trim() : "—"
}
