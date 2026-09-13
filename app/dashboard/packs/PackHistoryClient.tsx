"use client"

// app/dashboard/packs/page.tsx
//
// Pack history dashboard. Auth-gated via proxy.ts. The page resolves the
// user's saved wallets via /api/profile/saved-wallets and renders the
// summary + paginated history for the active wallet. Status tabs are
// {all, ripped, flipped, sold, held, other}; collection tabs come from
// summary.by_collection. Row click expands the lifecycle via /api/wallet/
// pack-lifecycle.

import { useCallback, useEffect, useMemo, useState } from "react"
import { fmtUsd, relativeTime } from "@/lib/dashboard/format"
import Link from "next/link"
import { DB_SLUG_TO_SLUG } from "@/lib/collections"
import {
  fetchVerifiedWallets,
  VERIFIED_WALLETS_UNAVAILABLE,
  type VerifiedWallet as SavedWallet,
} from "@/lib/wallet/verified-wallets"

const condensedFont = "var(--font-display)"
const monoFont = "var(--font-mono)"

interface SummaryTotals {
  spent_usd: number
  sold_proceeds_usd: number
  ripped_value_usd: number
  net_pl_usd: number
  packs_purchased: number
  packs_ripped: number
  /** How many of `packs_ripped` actually carry a pull_value_usd. Added by
   *  audit_20260912_pack_summary_ripped_value_known_count. Optional because an
   *  older cached payload will not have it -- absent means "coverage unknown",
   *  which is treated the same as partial: the caption still renders, without a
   *  count, and NET P&L still withholds. */
  ripped_value_known_count?: number
  packs_sold: number
  primary_drops: number
  secondary_buys: number
  primary_spent_usd?: number
  primary_spend_unknown_count?: number
  first_event_at: string | null
  last_event_at: string | null
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
 * ⛔⛔ `pull_value_usd` MEANS TWO DIFFERENT THINGS BY COLLECTION, AND THIS FILE
 * SUMS THEM. Top Shot sums the LATEST `fmv_snapshots` row per edition (CURRENT
 * value); All Day sums `allday_pack_pull.fmv_usd` (value AT OPEN). Measured on
 * 500 resolved 2026-06+ pulls: at-open mean **$8.97**, current mean **$3.14**,
 * agreeing on 22 of 500. RIPPED VALUE and NET P&L add both together. ⚠ This
 * PREDATES the All Day arm — the arm was briefly changed to current FMV on
 * 2026-09-12 and REVERTED within the hour, because the rollup above would have
 * fought it and flipped rows between bases with nothing recording which. Both
 * bases are correct for different consumers (realized-EV calibration wants
 * at-open; a user's NET P&L wants current), so one column cannot serve both.
 * Splitting it is a product decision, not a code fix — do not resolve it here.
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
export function packCoverage(t: SummaryTotals): {
  spendKnown: number
  ripKnown: number | null
  plWithheld: boolean
} {
  const spendKnown = Math.max(0, t.packs_purchased - (t.primary_spend_unknown_count ?? 0))
  const ripKnown = t.ripped_value_known_count ?? null
  const spendCov = t.packs_purchased > 0 ? spendKnown / t.packs_purchased : 1
  const ripCov = t.packs_ripped > 0 ? (ripKnown == null ? 0 : ripKnown / t.packs_ripped) : 1
  // A FLOOR, not a measurement. Below it the two sides of the subtraction
  // describe samples too small and too different for the difference to mean
  // anything. Same family as the pack-EV publish guard (FMV coverage >= 25%):
  // pick a floor, state it, withhold below it. Set higher here because P&L is a
  // claim about the reader's own money rather than about a market.
  const PL_COVERAGE_FLOOR = 0.8
  return { spendKnown, ripKnown, plWithheld: spendCov < PL_COVERAGE_FLOOR || ripCov < PL_COVERAGE_FLOOR }
}

interface SummaryCurrency {
  spent: number
  proceeds: number
  purchases: number
  sales: number
}

interface SummaryCollection {
  collection_id: string
  collection_name: string
  collection_slug: string
  spent_usd: number
  proceeds_usd: number
  ripped_value_usd: number
  net_pl_usd: number
  activity_total: number
  packs_purchased: number
  packs_ripped: number
  packs_sold: number
}

interface Summary {
  wallet: string
  totals: SummaryTotals
  by_currency: Record<string, SummaryCurrency>
  by_collection: SummaryCollection[]
  note?: string
  computed_at?: string
}

interface HistoryRow {
  pack_nft_id: string
  dist_id: string | null
  pack_name: string | null
  pack_tier: string | null
  pack_image: string | null
  collection_id: string
  collection_name: string
  collection_slug: string
  status: "ripped" | "flipped" | "sold" | "held" | "other"
  has_buy: boolean
  has_rip: boolean
  has_sell: boolean
  buy_price: number | null
  buy_currency: string | null
  bought_at: string | null
  bought_from: string | null
  event_kind: "secondary_sale" | "primary_withdraw" | "primary_mint" | null
  sell_price: number | null
  sell_currency: string | null
  sold_at: string | null
  sold_to: string | null
  ripped_at: string | null
  moments_pulled: number | null
  pull_value_usd: number | null
  realized_pl_usd: number | null
  first_event_at: string | null
  latest_event_at: string | null
  rip_id: string | null
}

interface History {
  packs: HistoryRow[]
  total_count: number
  wallet: string
  limit: number
  offset: number
  status_filter: string | null
  collection_slug: string | null
  computed_at?: string
}

const STATUS_OPTIONS: Array<{ key: "all" | HistoryRow["status"]; label: string; color: string }> = [
  { key: "all", label: "All", color: "var(--rpc-red, #E03A2F)" },
  { key: "ripped", label: "Ripped", color: "#3B82F6" },
  { key: "flipped", label: "Flipped", color: "#A855F7" },
  { key: "sold", label: "Sold", color: "#34D399" },
  { key: "held", label: "Held", color: "#71717A" },
  { key: "other", label: "Other", color: "#71717A" },
]

const PAGE_SIZE = 50

// fmtUsd / relativeTime extracted to @/lib/dashboard/format (unit-tested there).

function statusColor(s: HistoryRow["status"]): string {
  const match = STATUS_OPTIONS.find((o) => o.key === s)
  return match?.color ?? "#71717A"
}

function urlSlug(dbSlug: string): string {
  return DB_SLUG_TO_SLUG[dbSlug] ?? dbSlug
}

export default function PackHistoryClient() {
  const [wallets, setWallets] = useState<SavedWallet[]>([])
  const [walletsLoading, setWalletsLoading] = useState(true)
  // ⚠ Distinct from `wallets.length === 0`: an empty list is a real answer
  // about this account, a failed read is a statement about us.
  const [walletsFailed, setWalletsFailed] = useState(false)
  const [activeWallet, setActiveWallet] = useState<string | null>(null)

  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const [history, setHistory] = useState<History | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const [status, setStatus] = useState<"all" | HistoryRow["status"]>("all")
  const [collection, setCollection] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [lifecycleCache, setLifecycleCache] = useState<Record<string, any>>({})

  // ── Load saved wallets on mount ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      setWalletsLoading(true)
      try {
        const { wallets: list, ok } = await fetchVerifiedWallets()
        if (cancelled) return
        setWalletsFailed(!ok)
        setWallets(list)
        if (list.length > 0) setActiveWallet(list[0].wallet_addr)
      } finally {
        if (!cancelled) setWalletsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // ── Load summary when wallet changes ─────────────────────────────────────
  useEffect(() => {
    if (!activeWallet) return
    let cancelled = false
    async function load() {
      setSummaryLoading(true)
      setSummaryError(null)
      try {
        const res = await fetch("/api/wallet/pack-summary?wallet=" + encodeURIComponent(activeWallet!), {
          cache: "no-store",
        })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setSummaryError(json?.error ?? "Failed to load summary")
          setSummary(null)
        } else {
          setSummary(json as Summary)
        }
      } catch (err) {
        if (!cancelled) setSummaryError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setSummaryLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [activeWallet])

  // ── Load history when wallet / filters / page change ─────────────────────
  const loadHistory = useCallback(async () => {
    if (!activeWallet) return
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const params = new URLSearchParams({
        wallet: activeWallet,
        status,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      })
      if (collection) params.set("collection", collection)
      const res = await fetch("/api/wallet/pack-history?" + params.toString(), { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setHistoryError(json?.error ?? "Failed to load history")
        setHistory(null)
      } else {
        setHistory(json as History)
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setHistoryLoading(false)
    }
  }, [activeWallet, status, collection, page])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // Reset page when filters change.
  useEffect(() => {
    setPage(0)
  }, [status, collection, activeWallet])

  const expandPack = useCallback(async (packNftId: string) => {
    if (!activeWallet) return
    if (expanded === packNftId) {
      setExpanded(null)
      return
    }
    setExpanded(packNftId)
    if (lifecycleCache[packNftId]) return
    try {
      const res = await fetch(
        "/api/wallet/pack-lifecycle?wallet=" + encodeURIComponent(activeWallet) + "&packNftId=" + encodeURIComponent(packNftId),
        { cache: "no-store" },
      )
      const json = await res.json()
      if (res.ok) {
        setLifecycleCache((m) => ({ ...m, [packNftId]: json }))
      }
    } catch {
      // swallow — keep row collapsed
    }
  }, [activeWallet, expanded, lifecycleCache])

  const totalPages = useMemo(() => {
    if (!history) return 1
    return Math.max(1, Math.ceil(history.total_count / PAGE_SIZE))
  }, [history])

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", paddingBottom: 80 }}>
      <style>{`
        .rpc-pack-stat-num { font-family: ${condensedFont}; font-weight: 800; font-size: 32px; line-height: 1; }
        .rpc-pack-row { transition: background 120ms ease; cursor: pointer; }
        .rpc-pack-row:hover { background: #16161a; }
        .rpc-pack-chip { display: inline-flex; padding: 2px 8px; font-family: ${monoFont}; font-size: 10px; letter-spacing: 0.06em; border-radius: 3px; text-transform: uppercase; }
      `}</style>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "26px 22px 60px", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 28, letterSpacing: "0.04em", textTransform: "uppercase", margin: 0 }}>
                Pack History
              </h1>
              <span title="pack_purchases tracks secondary market only — primary drop spend isn't captured yet." style={{ display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center", borderRadius: 999, border: "1px solid rgba(255,255,255,0.35)", color: "rgba(255,255,255,0.7)", fontFamily: monoFont, fontSize: 10, cursor: "help" }}>?</span>
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
              Pack rip lifecycle, P&amp;L, and pulls for your saved wallets.
            </div>
          </div>
          <Link href="/dashboard" style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", textDecoration: "none", padding: "7px 12px", border: "1px solid rgba(224,58,47,0.4)", borderRadius: 5 }}>
            ← Dashboard
          </Link>
        </div>

        {/* Wallet selector */}
        {walletsLoading ? (
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Loading wallets…</div>
        ) : walletsFailed ? (
          /* ⚠ MUST precede the empty branch. Below it, a failed read tells a
             collector who HAS saved a wallet that they have none, and points
             them at the dashboard to redo it. */
          <div
            role="status"
            style={{ padding: 18, border: "1px dashed #444", borderRadius: 8, textAlign: "center" }}
          >
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
              {VERIFIED_WALLETS_UNAVAILABLE}
            </div>
          </div>
        ) : wallets.length === 0 ? (
          <div style={{ padding: 18, border: "1px dashed #444", borderRadius: 8, textAlign: "center" }}>
            <div style={{ fontFamily: condensedFont, fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 6 }}>
              No saved wallets yet
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 12 }}>
              Pack history reads from your saved wallets. Save a wallet from your dashboard, then come back here.
            </div>
            <Link href="/dashboard" style={{ display: "inline-block", padding: "8px 16px", background: "var(--rpc-red, #E03A2F)", color: "#fff", borderRadius: 6, fontFamily: condensedFont, fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}>
              Open dashboard
            </Link>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {wallets.map((w) => (
              <button
                key={w.wallet_addr}
                onClick={() => setActiveWallet(w.wallet_addr)}
                style={{
                  padding: "8px 12px",
                  background: w.wallet_addr === activeWallet ? "var(--rpc-red, #E03A2F)" : "#0d0d0d",
                  border: `1px solid ${w.wallet_addr === activeWallet ? "var(--rpc-red, #E03A2F)" : "#27272a"}`,
                  color: w.wallet_addr === activeWallet ? "#fff" : "rgba(255,255,255,0.75)",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontFamily: monoFont,
                  fontSize: 11,
                  letterSpacing: "0.04em",
                }}
              >
                {w.wallet_addr.slice(0, 6) + "…" + w.wallet_addr.slice(-4)}
              </button>
            ))}
          </div>
        )}

        {/* Hero stats */}
        {activeWallet && (summaryLoading ? (
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Loading summary…</div>
        ) : summaryError ? (
          <div style={{ padding: 12, border: "1px solid #7f1d1d", background: "rgba(127,29,29,0.2)", borderRadius: 6, fontFamily: monoFont, fontSize: 12, color: "#F87171" }}>{summaryError}</div>
        ) : summary ? ((() => {
          const t = summary.totals
          const { spendKnown, ripKnown, plWithheld } = packCoverage(t)
          return (
          <>
            {/* Coverage is computed once in `packCoverage` (module scope, unit
                tested) because the collection tabs below publish the SAME
                subtraction and must withhold with these tiles, not after them. */}
            <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                  <PacksPurchasedStat
                    purchased={t.packs_purchased}
                    primary={t.primary_drops}
                    secondary={t.secondary_buys}
                    unpriced={t.primary_spend_unknown_count ?? 0}
                  />
                  <CountStat
                    label="Packs ripped"
                    value={t.packs_ripped}
                    caption={
                      ripKnown == null
                        ? undefined
                        : ripKnown < t.packs_ripped
                          ? `${ripKnown.toLocaleString("en-US")} with a known pull value`
                          : "all valued"
                    }
                  />
                  <HeroStat
                    label="Total spent"
                    value={t.spent_usd}
                    tint={t.spent_usd > 0 ? "var(--rpc-red, #E03A2F)" : "#fff"}
                    caption={
                      spendKnown < t.packs_purchased
                        ? `across ${spendKnown.toLocaleString("en-US")} of ${t.packs_purchased.toLocaleString("en-US")} packs with a known price`
                        : undefined
                    }
                  />
                  <HeroStat label="Sold proceeds" value={t.sold_proceeds_usd} tint="#34D399" />
                  <HeroStat
                    label="Ripped value"
                    value={t.ripped_value_usd}
                    tint="#34D399"
                    caption={
                      ripKnown == null
                        ? "pull values are incomplete"
                        : ripKnown < t.packs_ripped
                          ? `from ${ripKnown.toLocaleString("en-US")} of ${t.packs_ripped.toLocaleString("en-US")} rips`
                          : undefined
                    }
                  />
                  <HeroStat
                    label="Net P&L"
                    value={t.net_pl_usd}
                    tint={t.net_pl_usd >= 0 ? "#34D399" : "var(--rpc-red, #E03A2F)"}
                    withheld={plWithheld}
                    caption={
                      plWithheld
                        ? "needs a price on most packs bought and ripped before this means anything"
                        : undefined
                    }
                  />
            </section>

            {/* Currency breakdown */}
            {summary.by_currency && Object.keys(summary.by_currency).length > 0 && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", letterSpacing: "0.04em" }}>
                {Object.entries(summary.by_currency).map(([ccy, vals]) => (
                  <span key={ccy}>
                    <span style={{ color: "#fff", fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em" }}>{ccy}</span>
                    <span style={{ marginLeft: 8 }}>{vals.purchases} buys · {vals.sales} sells · spent {fmtUsd(vals.spent)} · in {fmtUsd(vals.proceeds)}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Collection tabs */}
            {summary.by_collection.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 6, borderTop: "1px solid #27272a" }}>
                <CollectionTab active={collection == null} label="All collections" onClick={() => setCollection(null)} />
                {summary.by_collection.map((c) => (
                  <CollectionTab
                    key={c.collection_slug}
                    active={collection === c.collection_slug}
                    label={c.collection_name}
                    /* ⚠ The per-collection P&L is the SAME subtraction as the
                       headline, over the same two thin samples — it was
                       publishing "12 · $-25.00" one component below a tile that
                       had just withheld the identical figure. Fix per panel, not
                       per page: when the headline withholds, these withhold too
                       and fall back to the activity count, which is a real
                       measurement. */
                    sub={plWithheld ? `${c.activity_total} activity` : `${c.activity_total} · ${fmtUsd(c.net_pl_usd)}`}
                    pl={plWithheld ? undefined : c.net_pl_usd}
                    onClick={() => setCollection(c.collection_slug)}
                  />
                ))}
              </div>
            )}
          </>
          )
        })()) : null)}

        {/* Status filter buttons */}
        {activeWallet && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {STATUS_OPTIONS.map((o) => (
              <button
                key={o.key}
                onClick={() => setStatus(o.key)}
                style={{
                  padding: "6px 12px",
                  background: o.key === status ? o.color : "#0d0d0d",
                  color: o.key === status ? "#fff" : "rgba(255,255,255,0.7)",
                  border: `1px solid ${o.key === status ? o.color : "#27272a"}`,
                  borderRadius: 5,
                  cursor: "pointer",
                  fontFamily: condensedFont,
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {/* History table */}
        {activeWallet && (
          <section style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8, overflow: "hidden" }}>
            {historyLoading ? (
              <div style={{ padding: 18, fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)", textAlign: "center" }}>Loading packs…</div>
            ) : historyError ? (
              <div style={{ padding: 14, fontFamily: monoFont, fontSize: 12, color: "#F87171" }}>{historyError}</div>
            ) : !history || history.packs.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "rgba(255,255,255,0.55)", fontFamily: monoFont, fontSize: 12 }}>No pack activity for this filter.</div>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontFamily: monoFont, fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "#080808", borderBottom: "1px solid #27272a" }}>
                    <Th>Pack</Th>
                    <Th>Status</Th>
                    <Th>When</Th>
                    <Th right>Buy</Th>
                    <Th right>Sell</Th>
                    <Th right>Pull value</Th>
                    <Th right>Realized P&L</Th>
                  </tr>
                </thead>
                <tbody>
                  {history.packs.map((row) => {
                    const isOpen = expanded === row.pack_nft_id
                    const lifecycle = lifecycleCache[row.pack_nft_id]
                    return (
                      <ExpandableRow
                        key={row.pack_nft_id}
                        row={row}
                        isOpen={isOpen}
                        lifecycle={lifecycle}
                        onClick={() => expandPack(row.pack_nft_id)}
                      />
                    )
                  })}
                </tbody>
              </table>
              </div>
            )}

            {/* Pagination */}
            {history && history.total_count > PAGE_SIZE && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderTop: "1px solid #27272a", fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                <div>
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, history.total_count)} of {history.total_count}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} style={pagerBtn(page === 0)}>← Prev</button>
                  <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} style={pagerBtn(page + 1 >= totalPages)}>Next →</button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  )
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function HeroStat({ label, value, tint, caption, withheld }: { label: string; value: number; tint: string; caption?: string; withheld?: boolean }) {
  // `withheld` renders the em dash instead of the figure. It exists for NET P&L,
  // whose two sides are each summed over a DIFFERENT small sample of the wallet's
  // packs -- see the coverage comment at the call site. A number assembled that
  // way is not a partial sum a reader can discount; it is noise wearing a
  // currency symbol, and the honesty canon says an unknown renders as unknown.
  return (
    <div style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</div>
      <div className="rpc-pack-stat-num" style={{ color: withheld ? "rgba(255,255,255,0.45)" : tint, marginTop: 4 }}>{withheld ? "\u2014" : fmtUsd(value)}</div>
      {caption && (
        <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 6, letterSpacing: "0.04em", lineHeight: 1.4 }}>{caption}</div>
      )}
    </div>
  )
}

// A plain count tile. PACKS RIPPED was computed by get_wallet_pack_summary from
// the beginning and never rendered: the hero row led with PACKS PURCHASED 133 on
// a wallet that has ripped 503, under a page subtitled "Pack rip lifecycle".
// The collection tabs already showed the truth (386 + 250 = 636 activities), so
// the page contradicted itself on screen.
function CountStat({ label, value, caption }: { label: string; value: number; caption?: string }) {
  return (
    <div style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</div>
      <div className="rpc-pack-stat-num" style={{ color: "#fff", marginTop: 4 }}>{value.toLocaleString("en-US")}</div>
      {caption && (
        <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 6, letterSpacing: "0.04em", lineHeight: 1.4 }}>{caption}</div>
      )}
    </div>
  )
}

// Splits the "Packs Purchased" headline count into Studio drops (primary) vs
// marketplace buys (secondary). primary_spend_unknown_count is surfaced as a
// trailing "+ N unpriced drops" note when retail_price_usd couldn't be
// resolved via pack_distributions — see get_wallet_pack_summary RPC.
function PacksPurchasedStat({ purchased, primary, secondary, unpriced }: { purchased: number; primary: number; secondary: number; unpriced: number }) {
  return (
    <div style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.12em", textTransform: "uppercase" }}>Packs purchased</div>
      <div className="rpc-pack-stat-num" style={{ color: "#fff", marginTop: 4 }}>{purchased.toLocaleString("en-US")}</div>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.6)", marginTop: 6, letterSpacing: "0.04em" }}>
        {primary.toLocaleString("en-US")} Studio · {secondary.toLocaleString("en-US")} marketplace
        {unpriced > 0 && (
          <span style={{ color: "rgba(255,255,255,0.4)" }}> · +{unpriced} unpriced</span>
        )}
      </div>
    </div>
  )
}

function CollectionTab({ active, label, sub, pl, onClick }: { active: boolean; label: string; sub?: string; pl?: number; onClick: () => void }) {
  const positive = pl != null && pl >= 0
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 12px",
        background: active ? "rgba(224,58,47,0.12)" : "#0d0d0d",
        border: `1px solid ${active ? "var(--rpc-red, #E03A2F)" : "#27272a"}`,
        borderRadius: 6,
        cursor: "pointer",
        color: "#fff",
        textAlign: "left",
        minWidth: 120,
      }}
    >
      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      {sub && (
        <div style={{ fontFamily: monoFont, fontSize: 10, color: pl != null ? (positive ? "#34D399" : "var(--rpc-red, #E03A2F)") : "rgba(255,255,255,0.55)", marginTop: 2 }}>
          {sub}
        </div>
      )}
    </button>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th style={{ padding: "10px 12px", textAlign: right ? "right" : "left", fontFamily: condensedFont, fontWeight: 700, fontSize: 10, letterSpacing: "0.12em", color: "rgba(255,255,255,0.55)", textTransform: "uppercase" }}>
      {children}
    </th>
  )
}

function ExpandableRow({ row, isOpen, lifecycle, onClick }: { row: HistoryRow; isOpen: boolean; lifecycle: any; onClick: () => void }) {
  const buyText = row.has_buy ? fmtUsd(row.buy_price) + (row.buy_currency ? " " + row.buy_currency : "") : "—"
  const sellText = row.has_sell ? fmtUsd(row.sell_price) + (row.sell_currency ? " " + row.sell_currency : "") : "—"
  const pullTint = row.has_buy && row.has_rip && row.buy_price != null && row.pull_value_usd != null
    ? (row.pull_value_usd >= row.buy_price ? "#34D399" : "var(--rpc-red, #E03A2F)")
    : "rgba(255,255,255,0.85)"
  const plTint = row.realized_pl_usd != null ? (row.realized_pl_usd >= 0 ? "#34D399" : "var(--rpc-red, #E03A2F)") : "rgba(255,255,255,0.6)"
  const sc = statusColor(row.status)
  const packNameContent = row.pack_name ?? `Pack #${row.pack_nft_id.slice(-6)}`
  const showLink = row.dist_id != null
  return (
    <>
      <tr className="rpc-pack-row" onClick={onClick} style={{ borderBottom: "1px solid #1a1a1d" }}>
        <td style={{ padding: "10px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: 4, background: "#1a1a1d", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)", fontFamily: monoFont, fontSize: 18 }}>
              {row.pack_image ? <img src={row.pack_image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "?"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              {showLink ? (
                <Link
                  onClick={(e) => e.stopPropagation()}
                  href={`/${urlSlug(row.collection_slug)}/packs/simulator/${encodeURIComponent(row.dist_id!)}`}
                  style={{ color: "#fff", textDecoration: "none", fontFamily: condensedFont, fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {packNameContent}
                </Link>
              ) : (
                <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "rgba(255,255,255,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {packNameContent} <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>· Unknown distribution</span>
                </span>
              )}
              <span style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)" }}>{row.collection_name}</span>
            </div>
          </div>
        </td>
        <td style={{ padding: "10px 12px" }}>
          <span className="rpc-pack-chip" style={{ background: sc + "22", color: sc, border: `1px solid ${sc}66` }}>{row.status}</span>
        </td>
        <td style={{ padding: "10px 12px", color: "rgba(255,255,255,0.7)" }}>{relativeTime(row.latest_event_at)}</td>
        <td style={{ padding: "10px 12px", textAlign: "right" }}>{buyText}</td>
        <td style={{ padding: "10px 12px", textAlign: "right" }}>{sellText}</td>
        <td style={{ padding: "10px 12px", textAlign: "right", color: pullTint }}>{row.has_rip ? fmtUsd(row.pull_value_usd) : "—"}</td>
        <td style={{ padding: "10px 12px", textAlign: "right", color: plTint, fontFamily: condensedFont, fontWeight: 700 }}>{fmtUsd(row.realized_pl_usd)}</td>
      </tr>
      {isOpen && (
        <tr style={{ background: "#080808" }}>
          <td colSpan={7} style={{ padding: 14, borderBottom: "1px solid #1a1a1d" }}>
            <LifecycleDetail lifecycle={lifecycle} row={row} />
          </td>
        </tr>
      )}
    </>
  )
}

function LifecycleDetail({ lifecycle, row }: { lifecycle: any; row: HistoryRow }) {
  if (!lifecycle) {
    return <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Loading lifecycle…</div>
  }
  if (lifecycle.error) {
    return <div style={{ fontFamily: monoFont, fontSize: 11, color: "#F87171" }}>{lifecycle.error}</div>
  }
  const pulls: Array<any> = Array.isArray(lifecycle.pulls) ? lifecycle.pulls : []
  const chain: Array<any> = Array.isArray(lifecycle.ownership_chain) ? lifecycle.ownership_chain : []
  // event_kind comes from the wallet's most recent buy for this pack
  // (see get_wallet_pack_history → latest_buys.bought_event_kind). primary_*
  // values are Studio drops (TS PackNFT.Withdraw / AllDay PackNFT.Mint);
  // secondary_sale is a peer-to-peer NFTStorefrontV2 buy.
  const isStudioDrop = row.event_kind != null && row.event_kind.startsWith("primary_")
  const acquiredLine = row.has_buy
    ? isStudioDrop
      ? "Studio drop"
      : row.bought_from
        ? `Marketplace buy from ${row.bought_from}`
        : "Marketplace buy"
    : null
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {acquiredLine && (
        <div>
          <div style={{ fontFamily: condensedFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>How acquired</div>
          <span
            className="rpc-pack-chip"
            style={{
              background: isStudioDrop ? "rgba(168,85,247,0.15)" : "rgba(52,211,153,0.12)",
              color: isStudioDrop ? "#C084FC" : "#34D399",
              border: `1px solid ${isStudioDrop ? "rgba(168,85,247,0.4)" : "rgba(52,211,153,0.4)"}`,
            }}
          >
            {acquiredLine}
          </span>
        </div>
      )}
      {chain.length > 0 && (
        <div>
          <div style={{ fontFamily: condensedFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>Ownership chain</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.65)" }}>
            {chain.map((c: any, i: number) => (
              <span key={i} style={{ padding: "4px 8px", background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 4 }}>
                {c.from ? `${(c.from ?? "").slice(0, 6)}… → ` : ""}
                {(c.to ?? c.owner ?? "").slice(0, 6)}…
                {c.sale_price != null && <span style={{ color: "#34D399", marginLeft: 6 }}>{fmtUsd(Number(c.sale_price))}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {pulls.length > 0 && (
        <div>
          <div style={{ fontFamily: condensedFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)", marginBottom: 6 }}>Pulls ({pulls.length})</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6 }}>
            {pulls.map((p: any, i: number) => (
              <div key={i} style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 4, padding: 4 }}>
                {p.thumbnail_url ? <img src={p.thumbnail_url} alt="" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 2 }} /> : <div style={{ width: "100%", aspectRatio: "1 / 1", background: "#1a1a1d", borderRadius: 2 }} />}
                <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, color: "#fff", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.player_name ?? p.character_name ?? "—"}</div>
                <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.6)" }}>{fmtUsd(p.fmv_usd)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {row.dist_id && (
        <div>
          <Link
            href={`/${urlSlug(row.collection_slug)}/packs/simulator/${encodeURIComponent(row.dist_id)}`}
            style={{ display: "inline-block", padding: "6px 12px", background: "var(--rpc-red, #E03A2F)", color: "#fff", borderRadius: 5, fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}
          >
            Open simulator for this drop
          </Link>
        </div>
      )}
    </div>
  )
}

function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: disabled ? "#0d0d0d" : "#16161a",
    color: disabled ? "rgba(255,255,255,0.3)" : "#fff",
    border: "1px solid #27272a",
    borderRadius: 4,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: monoFont,
    fontSize: 10,
    letterSpacing: "0.06em",
  }
}
