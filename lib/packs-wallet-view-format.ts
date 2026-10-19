// Pure formatting/mapping logic lifted out of
// components/packs/WalletPacksView.tsx so the coverage ratchet can see it
// (components/** is excluded). No React, no JSX, no browser globals — the
// component imports these back and renders identically.
//
// A regression here mis-labels the pack sub-filter tabs, mis-maps a filter to
// the wrong server-side status, mis-tints P&L, or mangles the relative "when"
// column / USD figures.

import { currencySuffix, usdSignFirst } from "@/lib/usd-format"

export type PackFilter = "unopened" | "opened" | "sold"

export type PackHistoryStatus = "ripped" | "flipped" | "sold" | "held" | "transferred" | "other"

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
  // 2026-09-18: the pack left the wallet with no sale we can see (gift/transfer,
  // or a sale the marketplace walker has not reached). Dapper's index names the
  // current holder; the row says so instead of reading HELD.
  transferred: "#F59E0B",
  other: "var(--rpc-text-muted)",
}

/** Chip color for a pack status, falling back to the muted token for any
 *  unexpected value. */
export function packStatusColor(status: string): string {
  return STATUS_COLOR[status as PackHistoryStatus] ?? "var(--rpc-text-muted)"
}

const POSITIVE_TINT = "#34D399"
const NEGATIVE_TINT = "var(--rpc-red-text)" // a P/L figure is TEXT: the text-safe red
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
  const neg = usdSignFirst(n, fmtPackUsd); if (neg !== null) return neg
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

// "retail_inferred" (2026-09-26): no buy row, but the pack was acquired inside
// its drop's sale window where our marketplace history is complete, so it
// came from Dapper at the drop's retail -- shown as an inference, never a record.
// "box" (2026-10-10, #187): the pack came out of a box / case this wallet opened. It was
// never bought on its own -- its cost is part of the box's price -- so it has no buy price
// and no P/L of its own (a sold topper used to read "$0 (reward, inferred)" + the whole sale).
export type BuyPriceSource = "onchain" | "marketplace" | "retail" | "retail_inferred" | "box" | null

/** Second line under the pack name. `null` when nothing needs saying. */
export function packIdentityNote(
  row: {
    dist_id: string | null; status: string; pack_name?: string | null; current_owner?: string | null
    minted_to_wallet_at?: string | null
  },
): string | null {
  if (row.status === "transferred") {
    const owner = row.current_owner ? ` · now held by ${row.current_owner.slice(0, 6)}…${row.current_owner.slice(-4)}` : ""
    return "Left this wallet without a recorded sale" + owner
  }
  // 2026-09-26 (get_wallet_pack_history v11): Flow's PackNFT.Minted says Dapper
  // minted this pack straight into the wallet -- often a pack long held at
  // Dapper turned into an NFT (one mint on 2026-04-24 carried 215 of them), so
  // the date is when it became an NFT here, not when it was bought.
  if (row.minted_to_wallet_at) {
    const d = new Date(row.minted_to_wallet_at)
    if (Number.isFinite(d.getTime())) {
      const day = d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })
      return `Minted into this wallet by Dapper · ${day}`
    }
  }
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
  const usd = row.buy_usd ?? row.buy_price
  if (!row.has_buy) {
    if (row.buy_price_source === "box") return "From a box"
    if (row.buy_price_source === "retail_inferred" && row.buy_usd != null) {
      return row.buy_usd === 0 ? "$0 (reward, inferred)" : fmtPackUsd(row.buy_usd) + " retail (inferred)"
    }
    return "—"
  }
  if (usd == null) return "—"
  if (row.buy_price_source === "retail") return usd === 0 ? "$0 (reward)" : fmtPackUsd(usd) + " retail"
  // 2026-09-25: a dollar-pegged unit (USD, Dapper's DUC) shows no ticker —
  // "$10.00", never "$10.00 DUC"; FLOW / USDC keep theirs.
  return fmtPackUsd(usd) + currencySuffix(row.buy_currency)
}

/** Pull-value cell (2026-09-26, get_wallet_pack_history v8). A pack that was
 *  opened shows its value; when Dapper's pull list is held but not every
 *  moment is priced, it says how close ("2/3 priced") instead of a bare dash.
 *  Unknown is never rendered as $0. Not opened -> "—". */
export function packPullLabel(row: {
  status: string
  has_rip: boolean
  pull_value_usd: number | null
  pulls_total?: number | null
  pulls_priced?: number | null
  /** 2026-09-29: pulls named by inference (id neighbours), not by a record. */
  pulls_inferred?: number | null
  /** 2026-09-29: packs a BOX yielded (a box yields packs, not moments). */
  box_packs?: number | null
  /** 2026-10-10 (v22): how many of them are realized (sold, or opened with a value) and their total. */
  box_packs_realized?: number | null
  box_realized_usd?: number | null
}): string {
  if (!row.has_rip && row.status !== "ripped") return "—"
  // A box has no moment pull value of its own: say what it yielded.
  if ((row.box_packs ?? 0) > 0 && row.pull_value_usd == null) {
    const n = row.box_packs as number
    const base = `Box · ${n} pack${n === 1 ? "" : "s"}`
    const r = row.box_packs_realized ?? 0
    // v22: every pack realized -> what they became; some -> how far along (the P/L waits for all)
    if (r >= n && row.box_realized_usd != null) return `${base} · ${fmtPackUsd(row.box_realized_usd)} realized`
    if (r > 0) return `${base} · ${r} of ${n} realized`
    return base
  }
  // A value that rests on inferred pull names reads as an estimate ("≈").
  if (row.pull_value_usd != null) return (row.pulls_inferred ?? 0) > 0 ? `≈${fmtPackUsd(row.pull_value_usd)}` : fmtPackUsd(row.pull_value_usd)
  if (row.pulls_total != null && row.pulls_total > 0 && row.pulls_priced != null) {
    return `— (${row.pulls_priced}/${row.pulls_total} priced)`
  }
  return "—"
}

/** "Packs ripped" caption (2026-09-26). `reconstructed` is how many of the
 *  rips are packs opened with NO pack NFT, rebuilt from moment deliveries
 *  (get_wallet_pack_summary.packs_ripped_reconstructed) -- said out loud so a
 *  reconstruction never reads as an open event we hold. */
export function packsRippedCaption(
  total: number, known: number | null | undefined, reconstructed: number | null | undefined,
  // 2026-09-26: how many reconstructed rips are ONE moment delivery -- which may
  // be a reward or a gift rather than an opened pack (nothing we hold tells
  // them apart), so the caption says how much of the count rests on them.
  reconstructedSingle?: number | null,
): string | undefined {
  const parts: string[] = []
  if (known != null) parts.push(known < total ? `${known.toLocaleString("en-US")} with a known pull value` : "all valued")
  if (reconstructed != null && reconstructed > 0) {
    const single = reconstructedSingle != null && reconstructedSingle > 0
      ? `; ${reconstructedSingle.toLocaleString("en-US")} of them a single moment, which may be a reward`
      : ""
    parts.push(`${reconstructed.toLocaleString("en-US")} reconstructed (no pack NFT${single})`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

/** "Total spent" caption (2026-09-26). The recorded figure covers
 *  `spendKnown` of `purchased` buys; packs the wallet sold or opened with no
 *  buy row but acquired inside their drop's sale window carry an INFERRED
 *  drop cost (get_wallet_pack_summary.inferred_primary_*), said apart so an
 *  inference never reads as money we saw leave the wallet. */
export function spentCaption(
  spendKnown: number, purchased: number,
  inferredCount: number | null | undefined, inferredUsd: number | null | undefined,
): string | undefined {
  const parts: string[] = []
  if (spendKnown < purchased) parts.push(`across ${spendKnown.toLocaleString("en-US")} of ${purchased.toLocaleString("en-US")} packs with a known price`)
  if (inferredCount != null && inferredCount > 0 && inferredUsd != null) {
    parts.push(`+ ${fmtPackUsd(inferredUsd)} at drop retail for ${inferredCount.toLocaleString("en-US")} more packs (inferred)`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

/** "Packs sold" caption (2026-09-26): the headline count is every collection
 *  together, so a collector checking one collection's number (e.g. Top Shot)
 *  reads it here instead of against the all-collection total. Undefined when
 *  only one collection has sales (the headline already is that number). */
export function packsSoldCaption(
  byCollection: ReadonlyArray<{ collection_name: string; packs_sold: number }> | null | undefined,
): string | undefined {
  const withSales = (byCollection ?? []).filter((c) => c.packs_sold > 0)
  if (withSales.length < 2) return undefined
  return withSales
    .slice()
    .sort((a, b) => b.packs_sold - a.packs_sold)
    .map((c) => `${c.packs_sold.toLocaleString("en-US")} ${c.collection_name}`)
    .join(" · ")
}

export interface IdentitySync {
  requested_at?: string | null
  completed_at?: string | null
  pages?: number | null
  packs?: number | null
  last_error?: string | null
}

/** One line on how complete the holdings list is. Dapper's pack index is
 *  consulted per wallet; until a sync completes the list is only what our own
 *  tables hold, and the line must say so rather than let the tab read as
 *  complete. `now` is injectable for tests. */
export function identitySyncNote(sync: IdentitySync | null | undefined, now: number = Date.now()): string {
  if (!sync) return "Holdings not yet confirmed with the Dapper pack index — this list is what our own tables hold."
  if (sync.completed_at) {
    const ago = relativePackTime(sync.completed_at, now)
    const n = sync.packs != null ? ` (${sync.packs.toLocaleString("en-US")} packs)` : ""
    return sync.last_error
      ? `Holdings check with the Dapper pack index failed ${ago}${n} — list may be incomplete.`
      : `Holdings confirmed with the Dapper pack index ${ago}${n}.`
  }
  return "Confirming holdings with the Dapper pack index now — refresh in a few minutes for the full list."
}

/** Market context for a row whose distribution is known: floor ask · rip EV ·
 *  last sale, each omitted when unknown. Empty string when nothing is known.
 *
 *  2026-09-26: "Rip EV" is pack_gross_ev_usd -- the contents' expected value,
 *  what ripping the pack yields -- set beside the floor ask (what selling it
 *  yields). pack_ev_usd is that value MINUS the drop price; it was shown as
 *  "EV", so an Anthology Quick Rip worth $2.33 inside read "EV -$6.67". The net
 *  figure is never labelled EV. */
export function packMarketLabel(row: {
  lowest_ask_usd?: number | null
  pack_ev_usd?: number | null
  pack_gross_ev_usd?: number | null
  pack_opened_avg_usd?: number | null
  pack_opened_n?: number | null
  last_sale_usd?: number | null
}): string {
  const parts: string[] = []
  if (row.lowest_ask_usd != null) parts.push("Ask " + fmtPackUsd(row.lowest_ask_usd))
  if (row.pack_gross_ev_usd != null) parts.push("Rip EV " + fmtPackUsd(row.pack_gross_ev_usd))
  // 2026-09-26: no published pool to model (reward / chance-hit drops) -> what
  // this drop's opened packs actually yielded, with how many -- never as "EV"
  else if (row.pack_opened_avg_usd != null && row.pack_opened_n != null) {
    parts.push(`Opened avg ${fmtPackUsd(row.pack_opened_avg_usd)} (${row.pack_opened_n.toLocaleString("en-US")} packs)`)
  }
  if (row.last_sale_usd != null) parts.push("Last " + fmtPackUsd(row.last_sale_usd))
  return parts.join(" · ")
}

export interface HeldPackValue {
  count: number
  complete?: boolean
  rows_read?: number
  listed_count?: number
  floor_ask_usd?: number
  oldest_ask_checked_at?: string | null
  last_sale_count?: number
  last_sale_usd?: number
  rip_ev_count?: number
  rip_ev_usd?: number
  opened_avg_count?: number
  opened_avg_usd?: number
  error?: string
}

/** "Sealed packs held" caption (2026-09-26, get_wallet_pack_summary.held). Every
 *  sum names how many packs it covers, and the oldest ask it relies on (PT), so
 *  a floor total over asks a month old does not read as today's price. Unrealized
 *  -- the page shows it beside net P&L, never inside it. */
export function heldPacksCaption(held: HeldPackValue | null | undefined, now: number = Date.now()): string | undefined {
  if (!held || held.error || !held.count) return undefined
  const n = (x: number) => x.toLocaleString("en-US")
  const parts: string[] = []
  if (held.complete === false && held.rows_read != null) parts.push(`first ${n(held.rows_read)} valued`)
  if (held.listed_count) {
    let ask = `${fmtPackUsd(held.floor_ask_usd ?? 0)} at floor ask (${n(held.listed_count)} listed)`
    if (held.oldest_ask_checked_at) {
      const d = new Date(held.oldest_ask_checked_at)
      if (Number.isFinite(d.getTime()) && now - d.getTime() > 24 * 3600 * 1000) {
        ask += `, asks checked since ${d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })}`
      }
    }
    parts.push(ask)
  }
  if (held.rip_ev_count) parts.push(`rip EV ${fmtPackUsd(held.rip_ev_usd ?? 0)} (${n(held.rip_ev_count)} priced)`)
  if (held.opened_avg_count) {
    parts.push(`${fmtPackUsd(held.opened_avg_usd ?? 0)} more at their drops' opened averages (${n(held.opened_avg_count)})`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

/** "How acquired" for a pack with NO buy row we hold (2026-09-29). The cost
 *  column may carry an inferred drop retail; this says what the inference
 *  rests on, and says nothing when there is nothing to say. Dates in PT. */
export function packInferredAcquisitionLine(row: {
  has_buy: boolean
  buy_price_source?: string | null
  primary_minted_at?: string | null
  minted_to_wallet_at?: string | null
}): string | null {
  if (row.has_buy) return null
  const day = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })
  }
  if (row.minted_to_wallet_at) {
    const d = day(row.minted_to_wallet_at)
    if (d) return `Minted into this wallet by Dapper · ${d}`
  }
  if (row.primary_minted_at) {
    const d = day(row.primary_minted_at)
    if (d) return `Bought at the drop · minted ${d}, no marketplace sale before yours`
  }
  if (row.buy_price_source === "box") return "Came out of a box you opened · its cost is part of the box's price"
  if (row.buy_price_source === "retail_inferred") return "No purchase on record · acquired inside the drop's sale window"
  return null
}

/** A pull tile's serial: "#459 / 15,000" (2026-09-29). The mint size only when
 *  it is a positive count; nothing at all without a serial -- never "#0" or
 *  "#null" out of a missing read. */
export function packPullSerialLabel(
  serial: number | string | null | undefined,
  circulation: number | string | null | undefined,
): string | null {
  const s = serial == null || serial === "" ? NaN : Number(serial)
  if (!Number.isInteger(s) || s <= 0) return null
  const c = circulation == null || circulation === "" ? NaN : Number(circulation)
  return Number.isInteger(c) && c > 0 ? `#${s.toLocaleString("en-US")} / ${c.toLocaleString("en-US")}` : `#${s.toLocaleString("en-US")}`
}


/** The totals fields Net P&L coverage needs (the `/api/wallet/pack-summary`
 *  payload's `totals`). Moved here from app/dashboard/packs/PackHistoryClient.tsx
 *  on 2026-10-18 so the Collection tab's Packs view (components/packs/
 *  WalletPacksView.tsx) applies the SAME withhold rule: it published Net P&L with
 *  no coverage check at all, one tab away from the dashboard that withheld it. */
export interface PackCoverageTotals {
  packs_purchased: number
  packs_ripped: number
  ripped_value_known_count?: number
  primary_spend_unknown_count?: number
  inferred_primary_count?: number
}

/** How much of the wallet's pack activity each money figure actually covers.
 *
 * ⚠ Both money tiles are sums over a SUBSET of the wallet's packs, and until
 * 2026-09-12 neither said so. Measured that day on 0xbd94cade097e50ac: the
 * history list holds 598 packs, the hero said "PACKS PURCHASED 133", TOTAL SPENT
 * $398 covered 47 of them (33 secondary + 14 primary with a recoverable retail
 * price; 86 primary drops have none), and RIPPED VALUE $241.40 was the sum over
 * 50 of 503 rips. `pack_rips.pull_value_usd` is populated on 312,202 of
 * 3,685,525 rows product-wide — 8.5% — so the rip side understates by roughly an
 * order of magnitude for EVERY user, not just this one. NET P&L then subtracted
 * the first from the second and published the difference as a measured result.
 *
 * ⛔ ROOT-CAUSED 2026-09-12, AND IT IS NOT A COVERAGE RAMP — DO NOT TUNE THE
 * BACKFILL. The 8.5% does not fill in over time, because `pull_value_usd` was
 * computed ONLY by joining `moment_acquisitions` on `source_pack_rip_id`, and
 * that column is populated on **94.8% of NBA Top Shot rows and 0.0% of every
 * other collection** — no collection outside Top Shot has ever written an
 * `acquisition_method = 'pack_pull'` row. `moments` also holds ZERO All Day
 * rows, so the join's second hop is empty too.
 *
 * ⚠ AND THE COLLECTION THAT BLOCKED IS THREE QUARTERS OF THE CORPUS.
 * `pack_rips` is **Top Shot + All Day and nothing else** — Pinnacle, Golazos,
 * UFC and Candy have **ZERO rows** in it, so they were never a pricing gap, they
 * have no pack-open activity to price. Measured 2026-09-12 (PT):
 *     All Day .... 2,816,589 rips (76.4%) ....  25,195 valued (0.89%)
 *     Top Shot ...   868,944 rips (23.6%) ... 287,368 valued (33.1%)
 *     others .....         0 rips
 * So the product-wide 8.5% was almost entirely All Day being the large half of
 * the corpus at under 1%, NOT a broad multi-collection famine.
 *
 * ⭐ PARTLY FIXED THE SAME DAY, for All Day only:
 * `audit_20260912_pack_rip_pull_value_allday_arm` gave the backfill a second
 * pricing source, `allday_pack_pull` — per-pull moment ids written at open,
 * 1,485,444 rows over 419,012 packs, joined to `pack_rips` on `pack_nft_id`
 * (an exact key, not the Top Shot linkage's ±5/30min time window). 77,800 All
 * Day packs are fully priced and drain at ~1,200/day; every FUTURE All Day open
 * is priced on arrival, which is the durable half — and it lands on the
 * collection that is 76% of all pack rips.
 *
 * ⚠ THAT ARM IS A COLD-START SWEEP, NOT A SECOND PRICER, and knowing which
 * matters. `rollup_allday_rip_pull_value()` already prices All Day packs the
 * same way and is healthy — but it is INCREMENTAL on
 * `allday_pack_pull.updated_at >= last_run_at`, so packs already fully priced
 * before its watermark were never swept. That is the whole gap: 77,800 priceable
 * packs against 25,195 valued rips.
 *
 * ✅ `pull_value_usd` IS NOW **CURRENT FMV FOR EVERY COLLECTION** (2026-09-12,
 * Trevor's delegated call; register #92 closed). It used to mean two different
 * things and this file summed them: Top Shot the LATEST `fmv_snapshots` row per
 * edition (CURRENT), All Day `allday_pack_pull.fmv_usd` (AT OPEN) — measured on
 * 500 resolved 2026-06+ pulls at a mean of **$3.14 vs $8.97**, agreeing on 22 of
 * 500, with RIPPED VALUE and NET P&L adding both together.
 *
 * ⭐ CURRENT WON BECAUSE IT WAS ALREADY THE HOUSE BASIS, not as a coin-flip: the
 * whole Top Shot pack-reality / realized-EV estate already read this column as
 * current, Top Shot is ~92% of valued rips, and the 7-day `stale_valued`
 * re-price loop exists ONLY to keep it current — that machinery is meaningless
 * under an at-open basis. It also covers MORE (3,967 vs 3,780 whole packs per
 * 4,000). **Both writers were changed together** — `backfill_pack_rip_metadata`
 * AND `rollup_allday_rip_pull_value()` (pg_cron jobid 72) — because changing one
 * alone makes them fight, which is how the first attempt at this failed.
 * ⚠ Nothing was lost: the at-open number is still per-pull in
 * `allday_pack_pull.fmv_usd`, so at-open realized value stays computable.
 *
 * ⚠ ALL DAY HAS ITS OWN CEILING, and it is well under 100%: only **419,012 of
 * its 2,816,589 rips (14.9%)** appear in `allday_pack_pull` at all — the table
 * starts 2024-07-27 and everything before that is simply absent. Of those,
 * 77,800 (2.8% of All Day) are fully priced today. A perfect forward resolver
 * still caps here until the deep history is hydrated.
 *
 * ⚠ THE 2024–2025 ALL DAY TAIL STAYS DARK. `allday_pack_pull.edition_id` is
 * resolved on 100% of 2026-Q1-onward pulls but ~0–24% before that, and neither
 * `moments` (no All Day rows) nor `wallet_moments_cache` (7.1% hit rate — it
 * holds only currently-HELD moments) can close it. That needs a Flow re-fetch.
 * Measured on this very wallet: of its 503 rips, 385 are All Day — only 123 of
 * those even appear in `allday_pack_pull` (the rest predate it) and 19 are fully
 * priced. So this wallet goes 50 → ~69 of 503, still far under the floor, and
 * NET P&L rightly keeps withholding.
 *
 * ⚠ AND THE BACKFILL MARKS THOSE FAILURES AS DONE. `backfill_pack_rip_metadata`
 * stamps `metadata_updated_at` on every candidate it touches, including the ones
 * whose pull value came back NULL — and its two legs re-select on
 * `metadata_updated_at IS NULL` (the drain) and `pull_value_usd IS NOT NULL`
 * (the stale re-price), so a NULL-valued row is invisible to BOTH forever.
 * 363,336 rows are already in that state — MORE than the 312,202 it has
 * successfully valued. ⛔ Do not "fix" that by retrying them: sampled 2,000 of
 * them and **0** had acquisition rows, so a retry leg would spin on 363k
 * permanently unpriceable rows and starve the real drain.
 *
 * ⛔ LOCAL MINING FOR THE ALL DAY TAIL IS EXHAUSTED — MEASURED AT THE PACK
 * GRAIN, WHICH IS THE GRAIN THAT MATTERS. A 2026-07-31 pass concluded the same
 * thing by counting resolvable MOMENTS; this was re-derived 2026-09-12 by
 * counting resolvable PACKS, because pricing is all-or-nothing per pack and a
 * scattered 10% of moments buys almost no whole packs. Mining `sales` (which
 * that pass never checked — it carries both `nft_id` and `edition_id`) plus
 * `wallet_moments_cache` over 3,000 unresolved 2025-Q3 packs moved 1,658 →
 * 1,730 resolvable pulls of 9,010, and made **11 of 3,000 packs (0.37%)** whole.
 * The remaining unlock really is a Flow re-fetch: resolution borrows each moment
 * at its open block via `/v1/scripts`, which `spork-proxy` does not front (it
 * carries only `/v1/events` and `/v1/transactions`), so historical opens fall
 * outside Flow's execution-state window. Until that exists, these captions are
 * the honest output and should keep withholding — they are not a stopgap.
 *
 * `ripped_value_known_count` absent (an older cached payload) is treated as
 * coverage UNKNOWN, which withholds — never as full coverage.
 */
export function packCoverage(t: PackCoverageTotals): {
  spendKnown: number
  ripKnown: number | null
  plWithheld: boolean
} {
  const spendKnown = Math.max(0, t.packs_purchased - (t.primary_spend_unknown_count ?? 0))
  const ripKnown = t.ripped_value_known_count ?? null
  // ⚠ 2026-10-18 (Cowork, Trevor's own wallet): `inferred_primary_count` packs
  // were sold or opened with NO buy row; their inferred drop cost is kept OUT of
  // spent_usd, yet their rips and sales are IN ripped_value / proceeds. Measured
  // on 0xbd94…: 252 of 261 purchases priced (97% — passed the floor) while 486
  // more packs carried no cost at all, so NET P&L published +$45,491 with up to
  // $18,061 of drop spend missing from its subtraction. Those packs belong in the
  // spend denominator: their cost is not known, only inferred.
  const costedPacks = t.packs_purchased + Math.max(0, t.inferred_primary_count ?? 0)
  const spendCov = costedPacks > 0 ? spendKnown / costedPacks : 1
  const ripCov = t.packs_ripped > 0 ? (ripKnown == null ? 0 : ripKnown / t.packs_ripped) : 1
  // A FLOOR, not a measurement. Below it the two sides of the subtraction
  // describe samples too small and too different for the difference to mean
  // anything. Same family as the pack-EV publish guard (FMV coverage >= 25%):
  // pick a floor, state it, withhold below it. Set higher here because P&L is a
  // claim about the reader's own money rather than about a market.
  const PL_COVERAGE_FLOOR = 0.8
  return { spendKnown, ripKnown, plWithheld: spendCov < PL_COVERAGE_FLOOR || ripCov < PL_COVERAGE_FLOOR }
}
