// Pure formatting/mapping logic lifted out of
// components/packs/WalletPacksView.tsx so the coverage ratchet can see it
// (components/** is excluded). No React, no JSX, no browser globals — the
// component imports these back and renders identically.
//
// A regression here mis-labels the pack sub-filter tabs, mis-maps a filter to
// the wrong server-side status, mis-tints P&L, or mangles the relative "when"
// column / USD figures.

export type PackFilter = "unopened" | "opened" | "sold"

export type PackHistoryStatus = "ripped" | "flipped" | "sold" | "held" | "other"

/** Sub-filter -> the `status` value understood by /api/wallet/pack-history.
 *
 *  `sold_any` (not `sold`) is deliberate. get_wallet_pack_history classifies
 *  has_rip -> 'ripped' | has_sell AND has_buy -> 'flipped' | has_sell -> 'sold',
 *  so a sealed pack the wallet bought AND sold is 'flipped'. Wiring the Sold
 *  tab to 'sold' alone would silently hide those rows; `sold_any` = flipped +
 *  sold. */
export const PACK_FILTER_STATUS: Record<PackFilter, string> = {
  unopened: "held",
  opened: "ripped",
  sold: "sold_any",
}

export const PACK_FILTER_LABEL: Record<PackFilter, string> = {
  unopened: "Unopened",
  opened: "Opened",
  sold: "Sold",
}

/** Render order for the sub-filter tab bar. */
export const PACK_FILTERS: readonly PackFilter[] = ["unopened", "opened", "sold"]

export const STATUS_COLOR: Record<PackHistoryStatus, string> = {
  ripped: "#3B82F6",
  flipped: "#A855F7",
  sold: "#34D399",
  held: "var(--rpc-text-muted)",
  other: "var(--rpc-text-muted)",
}

/** Chip color for a pack status, falling back to the muted token for any
 *  unexpected value. */
export function packStatusColor(status: string): string {
  return STATUS_COLOR[status as PackHistoryStatus] ?? "var(--rpc-text-muted)"
}

const POSITIVE_TINT = "#34D399"
const NEGATIVE_TINT = "var(--rpc-red)"
const MUTED_TINT = "var(--rpc-text-muted)"

/** Tint for a realized-P&L figure: green >= 0, red < 0, muted when unknown.
 *  Mirrors the per-row P&L tint (null -> muted). */
export function realizedPlTint(realized: number | null | undefined): string {
  if (realized == null) return MUTED_TINT
  return realized >= 0 ? POSITIVE_TINT : NEGATIVE_TINT
}

/** Tint for the hero Net P&L stat: green when the row exists and net >= 0,
 *  otherwise the brand red (also used when the summary row is absent). */
export function netPlTint(netPlUsd: number | null | undefined): string {
  return netPlUsd != null && netPlUsd >= 0 ? POSITIVE_TINT : NEGATIVE_TINT
}

/** Human pack name, falling back to a short id-derived label when unnamed. */
export function packDisplayName(packName: string | null | undefined, packNftId: string): string {
  return packName ?? `Pack #${packNftId.slice(-6)}`
}

export function fmtPackUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  if (v === 0) return "$0"
  if (Math.abs(v) >= 1000) return "$" + Math.round(v).toLocaleString("en-US")
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Coarse "time ago" label. `now` is injectable for deterministic testing;
 *  callers in the component omit it (defaults to Date.now()). */
export function relativePackTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—"
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return "—"
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return mins + "m ago"
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + "h ago"
  const days = Math.floor(hrs / 24)
  if (days < 30) return days + "d ago"
  const mos = Math.floor(days / 30)
  if (mos < 12) return mos + "mo ago"
  return Math.floor(mos / 12) + "y ago"
}

// ── 2026-09-18: honest identity + provenance for the pack column ─────────────
//
// get_wallet_pack_history v4 emits NULL (never 0) for an unknown price and adds
// provenance keys. A sealed Top Shot primary-drop pack has NO distribution
// recorded anywhere on this platform until it is opened or resold, so its name
// cannot be known; the row must SAY that instead of dressing a serial fragment
// up as a name.

export type BuyPriceSource = "onchain" | "marketplace" | "retail" | null

/** Second line under the pack name. `null` when nothing needs saying. */
export function packIdentityNote(
  row: { dist_id: string | null; status: string; pack_name?: string | null },
): string | null {
  if (row.dist_id) return null
  if (row.status === "held") return "Sealed · distribution not recorded until opened or resold"
  return "Distribution unknown"
}

/** The Buy cell. A primary drop prices at the distribution's retail price
 *  (tagged so "$0" reads as "free reward pack", not as a missing number). */
export function packBuyLabel(row: {
  has_buy: boolean
  buy_usd?: number | null
  buy_price?: number | null
  buy_currency?: string | null
  buy_price_source?: BuyPriceSource
}): string {
  if (!row.has_buy) return "—"
  const usd = row.buy_usd ?? row.buy_price
  if (usd == null) return "—"
  if (row.buy_price_source === "retail") return usd === 0 ? "$0 (reward)" : fmtPackUsd(usd) + " retail"
  return fmtPackUsd(usd) + (row.buy_currency ? ` ${row.buy_currency}` : "")
}

/** Market context for a row whose distribution is known: floor ask · EV ·
 *  last sale, each omitted when unknown. Empty string when nothing is known. */
export function packMarketLabel(row: {
  lowest_ask_usd?: number | null
  pack_ev_usd?: number | null
  last_sale_usd?: number | null
}): string {
  const parts: string[] = []
  if (row.lowest_ask_usd != null) parts.push("Ask " + fmtPackUsd(row.lowest_ask_usd))
  if (row.pack_ev_usd != null) parts.push("EV " + fmtPackUsd(row.pack_ev_usd))
  if (row.last_sale_usd != null) parts.push("Last " + fmtPackUsd(row.last_sale_usd))
  return parts.join(" · ")
}
