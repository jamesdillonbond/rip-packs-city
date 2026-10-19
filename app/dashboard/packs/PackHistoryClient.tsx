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
import { currencySuffix, displayCurrency, isUsdPegged } from "@/lib/usd-format"
import { packCoverage } from "@/lib/packs-wallet-view-format"
import { heldPacksCaption, packBuyLabel, packIdentityNote, packInferredAcquisitionLine, packMarketLabel, packPullLabel, packPullSerialLabel, packsRippedCaption, packsSoldCaption, spentCaption, type HeldPackValue } from "@/lib/packs-wallet-view-format"
import Link from "next/link"
import { DB_SLUG_TO_SLUG } from "@/lib/collections"
import {
  fetchVerifiedWallets,
  VERIFIED_WALLETS_UNAVAILABLE,
  type VerifiedWallet as SavedWallet,
} from "@/lib/wallet/verified-wallets"
import { proxyIpfsImageUrl } from "@/lib/ipfs-media"
import { ownLookup } from "@/lib/safe-lookup"
import { accentText, labelOn } from "@/lib/accent-text"

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
  /** 2026-09-26: how many of packs_ripped are packs opened with NO pack NFT,
   *  reconstructed from moment deliveries. Optional (older payloads). */
  packs_ripped_reconstructed?: number
  /** 2026-09-26 (summary v13): of those, single-moment deliveries (may be rewards). Optional. */
  packs_ripped_reconstructed_single?: number
  /** 2026-09-26: packs sold/opened with no buy row, acquired inside their drop's
   *  sale window -> an INFERRED drop cost, kept out of spent_usd. Optional. */
  inferred_primary_count?: number
  inferred_primary_spent_usd?: number
  packs_sold: number
  primary_drops: number
  secondary_buys: number
  primary_spent_usd?: number
  primary_spend_unknown_count?: number
  first_event_at: string | null
  last_event_at: string | null
}


export interface SummaryCurrency {
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
  /** 2026-09-26 (summary v14): sealed packs held, valued at the market. Optional (older payloads). */
  held?: HeldPackValue
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
  status: "ripped" | "flipped" | "sold" | "held" | "transferred" | "other"
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
  // 2026-09-26 (v8): where the pull value came from, and — when Dapper's list
  // of the pack's moments is held — how many are priced. NULL = unknown.
  pull_value_source?: "dapper_pulls" | "rip_record" | "delivery_burst" | null
  pulls_total?: number | null
  pulls_priced?: number | null
  pulls_inferred?: number | null
  box_packs?: number | null
  box_packs_realized?: number | null
  box_realized_usd?: number | null
  // 2026-09-26 (v9): "reconstructed" = a pack opened with no pack NFT, rebuilt
  // from its moment deliveries (its pack_name says so too).
  rip_source?: "rip" | "reconstructed" | null
  realized_pl_usd: number | null
  first_event_at: string | null
  latest_event_at: string | null
  rip_id: string | null
  // 2026-09-18 (get_wallet_pack_history v4), all optional; NULL = unknown.
  buy_usd?: number | null
  buy_price_source?: "onchain" | "marketplace" | "retail" | "retail_inferred" | "box" | null
  sell_source?: "onchain" | "marketplace" | null
  dist_source?: "rip" | "own_row" | "peer_sale" | null
  lowest_ask_usd?: number | null
  pack_ev_usd?: number | null
  /** 2026-09-26 (history v13): the contents' expected value (gross). */
  pack_gross_ev_usd?: number | null
  /** 2026-09-26 (history v14): mean current value of this drop's opened packs (>= 5), and how many. */
  pack_opened_avg_usd?: number | null
  pack_opened_n?: number | null
  last_sale_usd?: number | null
  current_owner?: string | null
  /** 2026-09-26 (v11): Dapper minted this pack straight into the wallet (Flow PackNFT.Minted). */
  minted_to_wallet_at?: string | null
  primary_minted_at?: string | null
  identity_status?: string | null
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

/** The RPC buckets buys/sells by sale_currency and labels a NULL currency
 *  'UNKNOWN' — those are primary drops and reward packs, whose price is NOT
 *  on chain, and its `spent` for them is a COALESCE(price, 0) sum: a measured
 *  zero of an unrecorded number. The strip read "UNKNOWN · 101 buys · 0 sells
 *  · spent $0 · in $0" on the founder's wallet (2026-09-24). Name the bucket
 *  and withhold the fabricated dollar figures. */
export function currencyBucketLabel(ccy: string): string {
  return ccy === "UNKNOWN" ? "DROPS / REWARDS" : displayCurrency(ccy)
}

/** 2026-09-25 (Trevor): DUC is pegged 1:1 to the dollar and the site never
 *  shows the word — the RPC buckets by sale_currency, so its DUC and USD
 *  buckets are ONE dollar bucket here: counts and sums added, keyed "USD".
 *  Other units and the UNKNOWN (drops / rewards) bucket pass through. Keys
 *  come back in first-seen order, USD where its first member was. */
export function foldUsdPeggedBuckets(by: Record<string, SummaryCurrency>): Array<[string, SummaryCurrency]> {
  const out: Array<[string, SummaryCurrency]> = []
  const at = new Map<string, number>()
  for (const [ccy, vals] of Object.entries(by)) {
    const key = ccy !== "UNKNOWN" && isUsdPegged(ccy) ? "USD" : ccy
    const i = at.get(key)
    if (i == null) {
      at.set(key, out.length)
      out.push([key, { ...vals }])
    } else {
      const acc = out[i][1]
      out[i][1] = {
        purchases: (acc.purchases ?? 0) + (vals.purchases ?? 0),
        sales: (acc.sales ?? 0) + (vals.sales ?? 0),
        spent: (acc.spent ?? 0) + (vals.spent ?? 0),
        proceeds: (acc.proceeds ?? 0) + (vals.proceeds ?? 0),
      }
    }
  }
  return out
}
export function currencyBucketText(ccy: string, vals: SummaryCurrency): string {
  if (ccy === "UNKNOWN") {
    return `${vals.purchases} received · ${vals.sales} sells · price not on chain`
  }
  return `${vals.purchases} buys · ${vals.sales} sells · spent ${fmtUsd(vals.spent)} · in ${fmtUsd(vals.proceeds)}`
}

// "sold_any" (2026-09-26): the Sold filter is every pack the wallet sold while
// sealed. A pack it also BOUGHT is classified 'flipped', so filtering on 'sold'
// alone hid those (0xbd94…: 379 of 396 Top Shot sales). Flipped stays as the
// bought-and-resold subset. WalletPacksView's Sold tab made the same fix.
type StatusFilter = "all" | "sold_any" | HistoryRow["status"]

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string; color: string }> = [
  { key: "all", label: "All", color: "var(--rpc-red, #E03A2F)" },
  { key: "ripped", label: "Ripped", color: "#3B82F6" },
  { key: "sold_any", label: "Sold", color: "#34D399" },
  { key: "flipped", label: "Flipped", color: "#A855F7" },
  { key: "held", label: "Held", color: "#71717A" },
  { key: "transferred", label: "Transferred", color: "#F59E0B" },
  { key: "other", label: "Other", color: "#71717A" },
]

const PAGE_SIZE = 50

// fmtUsd / relativeTime extracted to @/lib/dashboard/format (unit-tested there).

function statusColor(s: HistoryRow["status"]): string {
  const match = STATUS_OPTIONS.find((o) => o.key === (s === "sold" ? "sold_any" : s))
  return match?.color ?? "#71717A"
}

function urlSlug(dbSlug: string): string {
  return ownLookup(DB_SLUG_TO_SLUG, dbSlug) ?? dbSlug
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

  const [status, setStatus] = useState<StatusFilter>("all")
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

  // 2026-09-26: keyed by collection too (a pack id is unique only within a
  // collection), and a failed read is CACHED AS AN ERROR — it used to be
  // swallowed, which left the row reading "Loading lifecycle…" for ever.
  const expandPack = useCallback(async (packNftId: string, collectionSlug: string) => {
    if (!activeWallet) return
    const key = collectionSlug + ":" + packNftId
    if (expanded === key) {
      setExpanded(null)
      return
    }
    setExpanded(key)
    if (lifecycleCache[key] && !lifecycleCache[key].error) return
    try {
      const res = await fetch(
        "/api/wallet/pack-lifecycle?wallet=" + encodeURIComponent(activeWallet) +
          "&packNftId=" + encodeURIComponent(packNftId) +
          "&collection=" + encodeURIComponent(collectionSlug),
        { cache: "no-store" },
      )
      // A body that will not parse throws into the catch below, which records the error.
      const json = await res.json()
      setLifecycleCache((m) => ({
        ...m,
        [key]: res.ok && json ? json : { error: "Couldn't load this pack's details — try again." },
      }))
    } catch {
      setLifecycleCache((m) => ({ ...m, [key]: { error: "Couldn't load this pack's details — try again." } }))
    }
  }, [activeWallet, expanded, lifecycleCache])

  const totalPages = useMemo(() => {
    if (!history) return 1
    return Math.max(1, Math.ceil(history.total_count / PAGE_SIZE))
  }, [history])

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", paddingBottom: 80 }}>
      <style>{`
        .rpc-pack-stat-num { font-family: ${condensedFont}; font-weight: 800; font-size: 32px; line-height: 1; }
        .rpc-pack-row { transition: background 120ms ease; cursor: pointer; }
        .rpc-pack-row:hover { background: var(--rpc-surface-hover); }
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
              <span title="pack_purchases tracks secondary market only — primary drop spend isn't captured yet." style={{ display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center", borderRadius: 999, border: "1px solid var(--rpc-border-hover)", color: "var(--rpc-text-secondary)", fontFamily: monoFont, fontSize: 10, cursor: "help" }}>?</span>
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>
              Pack rip lifecycle, P&amp;L, and pulls for your saved wallets.
            </div>
          </div>
          <Link href="/dashboard" style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-secondary)", textDecoration: "none", padding: "7px 12px", border: "1px solid rgba(224,58,47,0.4)", borderRadius: 5 }}>
            ← Dashboard
          </Link>
        </div>

        {/* Wallet selector */}
        {walletsLoading ? (
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading wallets…</div>
        ) : walletsFailed ? (
          /* ⚠ MUST precede the empty branch. Below it, a failed read tells a
             collector who HAS saved a wallet that they have none, and points
             them at the dashboard to redo it. */
          <div
            role="status"
            style={{ padding: 18, border: "1px dashed #444", borderRadius: 8, textAlign: "center" }}
          >
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-secondary)" }}>
              {VERIFIED_WALLETS_UNAVAILABLE}
            </div>
          </div>
        ) : wallets.length === 0 ? (
          <div style={{ padding: 18, border: "1px dashed #444", borderRadius: 8, textAlign: "center" }}>
            <div style={{ fontFamily: condensedFont, fontSize: 18, fontWeight: 700, color: "var(--rpc-text-primary)", marginBottom: 6 }}>
              No saved wallets yet
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)", marginBottom: 12 }}>
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
                  background: w.wallet_addr === activeWallet ? "var(--rpc-red, #E03A2F)" : "var(--rpc-surface)",
                  border: `1px solid ${w.wallet_addr === activeWallet ? "var(--rpc-red, #E03A2F)" : "var(--rpc-border)"}`,
                  color: w.wallet_addr === activeWallet ? "#fff" : "var(--rpc-text-secondary)",
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
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading summary…</div>
        ) : summaryError ? (
          <div style={{ padding: 12, border: "1px solid #7f1d1d", background: "rgba(127,29,29,0.2)", borderRadius: 6, fontFamily: monoFont, fontSize: 12, color: "var(--rpc-danger-text)" }}>{summaryError}</div>
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
                    caption={packsRippedCaption(t.packs_ripped, ripKnown, t.packs_ripped_reconstructed, t.packs_ripped_reconstructed_single)}
                  />
                  {summary.held && summary.held.count > 0 && (
                    <CountStat
                      label="Sealed packs held"
                      value={summary.held.count}
                      caption={heldPacksCaption(summary.held)}
                    />
                  )}
                  <CountStat
                    label="Packs sold"
                    value={t.packs_sold}
                    caption={packsSoldCaption(summary.by_collection)}
                  />
                  <HeroStat
                    label="Total spent"
                    value={t.spent_usd}
                    tint={t.spent_usd > 0 ? "var(--rpc-red-text)" : "var(--rpc-text-primary)"}
                    caption={spentCaption(spendKnown, t.packs_purchased, t.inferred_primary_count, t.inferred_primary_spent_usd)}
                  />
                  <HeroStat label="Sold proceeds" value={t.sold_proceeds_usd} tint="var(--rpc-success-text)" />
                  <HeroStat
                    label="Ripped value"
                    value={t.ripped_value_usd}
                    tint="var(--rpc-success-text)"
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
                    tint={t.net_pl_usd >= 0 ? "var(--rpc-success-text)" : "var(--rpc-red-text)"}
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
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)", letterSpacing: "0.04em" }}>
                {foldUsdPeggedBuckets(summary.by_currency).map(([ccy, vals]) => (
                  <span key={ccy}>
                    <span style={{ color: "var(--rpc-text-primary)", fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em" }}>{currencyBucketLabel(ccy)}</span>
                    <span style={{ marginLeft: 8 }}>{currencyBucketText(ccy, vals)}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Collection tabs */}
            {summary.by_collection.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 6, borderTop: "1px solid var(--rpc-border)" }}>
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
                  background: o.key === status ? o.color : "var(--rpc-surface)",
                  color: o.key === status ? labelOn(o.color) : "var(--rpc-text-secondary)",
                  border: `1px solid ${o.key === status ? o.color : "var(--rpc-border)"}`,
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
          <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, overflow: "hidden" }}>
            {historyLoading ? (
              <div style={{ padding: 18, fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)", textAlign: "center" }}>Loading packs…</div>
            ) : historyError ? (
              <div style={{ padding: 14, fontFamily: monoFont, fontSize: 12, color: "var(--rpc-danger-text)" }}>{historyError}</div>
            ) : !history || history.packs.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "var(--rpc-text-secondary)", fontFamily: monoFont, fontSize: 12 }}>No pack activity for this filter.</div>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", fontFamily: monoFont, fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "var(--rpc-black)", borderBottom: "1px solid var(--rpc-border)" }}>
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
                    const key = row.collection_slug + ":" + row.pack_nft_id
                    const isOpen = expanded === key
                    const lifecycle = lifecycleCache[key]
                    return (
                      <ExpandableRow
                        key={key}
                        row={row}
                        isOpen={isOpen}
                        lifecycle={lifecycle}
                        onClick={() => expandPack(row.pack_nft_id, row.collection_slug)}
                      />
                    )
                  })}
                </tbody>
              </table>
              </div>
            )}

            {/* Pagination */}
            {history && history.total_count > PAGE_SIZE && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderTop: "1px solid var(--rpc-border)", fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)" }}>
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
    <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</div>
      <div className="rpc-pack-stat-num" style={{ color: withheld ? "var(--rpc-text-muted)" : tint, marginTop: 4 }}>{withheld ? "\u2014" : fmtUsd(value)}</div>
      {caption && (
        <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 6, letterSpacing: "0.04em", lineHeight: 1.4 }}>{caption}</div>
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
    <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</div>
      <div className="rpc-pack-stat-num" style={{ color: "var(--rpc-text-primary)", marginTop: 4 }}>{value.toLocaleString("en-US")}</div>
      {caption && (
        <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 6, letterSpacing: "0.04em", lineHeight: 1.4 }}>{caption}</div>
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
    <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>Packs purchased</div>
      <div className="rpc-pack-stat-num" style={{ color: "var(--rpc-text-primary)", marginTop: 4 }}>{purchased.toLocaleString("en-US")}</div>
      <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-secondary)", marginTop: 6, letterSpacing: "0.04em" }}>
        {primary.toLocaleString("en-US")} Studio · {secondary.toLocaleString("en-US")} marketplace
        {unpriced > 0 && (
          <span style={{ color: "var(--rpc-text-muted)" }}> · +{unpriced} unpriced</span>
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
        background: active ? "rgba(224,58,47,0.12)" : "var(--rpc-surface)",
        border: `1px solid ${active ? "var(--rpc-red, #E03A2F)" : "var(--rpc-border)"}`,
        borderRadius: 6,
        cursor: "pointer",
        color: "var(--rpc-text-primary)",
        textAlign: "left",
        minWidth: 120,
      }}
    >
      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      {sub && (
        <div style={{ fontFamily: monoFont, fontSize: 10, color: pl != null ? (positive ? "var(--rpc-success-text)" : "var(--rpc-red-text)") : "var(--rpc-text-secondary)", marginTop: 2 }}>
          {sub}
        </div>
      )}
    </button>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th style={{ padding: "10px 12px", textAlign: right ? "right" : "left", fontFamily: condensedFont, fontWeight: 700, fontSize: 10, letterSpacing: "0.12em", color: "var(--rpc-text-secondary)", textTransform: "uppercase" }}>
      {children}
    </th>
  )
}

function ExpandableRow({ row, isOpen, lifecycle, onClick }: { row: HistoryRow; isOpen: boolean; lifecycle: any; onClick: () => void }) {
  // 2026-09-18: NULL buy price renders "—" (the RPC no longer coalesces an
  // unpriced primary drop to 0); a retail-priced drop is tagged.
  const buyText = packBuyLabel(row)
  const identityNote = packIdentityNote(row)
  const marketText = packMarketLabel(row)
  const sellText = row.has_sell ? fmtUsd(row.sell_price) + currencySuffix(row.sell_currency) : "—"
  const pullTint = row.has_buy && row.has_rip && row.buy_price != null && row.pull_value_usd != null
    ? (row.pull_value_usd >= row.buy_price ? "var(--rpc-success-text)" : "var(--rpc-red-text)")
    : "var(--rpc-text-primary)"
  const plTint = row.realized_pl_usd != null ? (row.realized_pl_usd >= 0 ? "var(--rpc-success-text)" : "var(--rpc-red-text)") : "var(--rpc-text-secondary)"
  const sc = statusColor(row.status)
  const packNameContent = row.pack_name ?? `Pack #${row.pack_nft_id.slice(-6)}`
  const showLink = row.dist_id != null
  return (
    <>
      <tr
        className="rpc-pack-row"
        onClick={onClick}
        // 2026-10-11: the lifecycle detail was mouse-only.
        tabIndex={0}
        aria-expanded={isOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() }
        }}
        style={{ borderBottom: "1px solid #1a1a1d" }}
      >
        <td style={{ padding: "10px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: 4, background: "#1a1a1d", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-muted)", fontFamily: monoFont, fontSize: 18 }}>
              {row.pack_image ? <img src={row.pack_image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "?"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              {showLink ? (
                <Link
                  onClick={(e) => e.stopPropagation()}
                  href={`/${urlSlug(row.collection_slug)}/packs/simulator/${encodeURIComponent(row.dist_id!)}`}
                  style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontFamily: condensedFont, fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {packNameContent}
                  {identityNote && <span style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}> · {identityNote}</span>}
                </Link>
              ) : (
                <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "var(--rpc-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {packNameContent} <span style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>· {identityNote ?? "Unknown distribution"}</span>
                </span>
              )}
              <span style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)" }}>{row.collection_name}{marketText ? ` · ${marketText}` : ""}</span>
            </div>
          </div>
        </td>
        <td style={{ padding: "10px 12px" }}>
          <span className="rpc-pack-chip" style={{ background: sc + "22", color: accentText(sc), border: `1px solid ${sc}66` }}>{row.status}</span>
        </td>
        <td style={{ padding: "10px 12px", color: "var(--rpc-text-secondary)" }}>{relativeTime(row.latest_event_at)}</td>
        <td style={{ padding: "10px 12px", textAlign: "right" }}>{buyText}</td>
        <td style={{ padding: "10px 12px", textAlign: "right" }}>{sellText}</td>
        <td style={{ padding: "10px 12px", textAlign: "right", color: pullTint }}>{packPullLabel(row)}</td>
        <td style={{ padding: "10px 12px", textAlign: "right", color: plTint, fontFamily: condensedFont, fontWeight: 700 }}>{fmtUsd(row.realized_pl_usd)}</td>
      </tr>
      {isOpen && (
        <tr style={{ background: "var(--rpc-black)" }}>
          <td colSpan={7} style={{ padding: 14, borderBottom: "1px solid #1a1a1d" }}>
            <LifecycleDetail lifecycle={lifecycle} row={row} />
          </td>
        </tr>
      )}
    </>
  )
}

function pullsSourceNote(source: unknown): string | null {
  if (source === "dapper_pulls") return "from Dapper's record of this pack"
  if (source === "delivery_burst") return "reconstructed from moment deliveries"
  return null
}

function LifecycleDetail({ lifecycle, row }: { lifecycle: any; row: HistoryRow }) {
  if (!lifecycle) {
    return <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)" }}>Loading lifecycle…</div>
  }
  if (lifecycle.error) {
    return <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-danger-text)" }}>{lifecycle.error}</div>
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
    : packInferredAcquisitionLine(row)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {acquiredLine && (
        <div>
          <div style={{ fontFamily: condensedFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-secondary)", marginBottom: 6 }}>How acquired</div>
          <span
            className="rpc-pack-chip"
            style={
              // drop purple for a studio drop (recorded, or inferred from a mint);
              // marketplace green for a recorded buy; neutral for any other
              // acquisition we hold no record of
              isStudioDrop || (!row.has_buy && (row.primary_minted_at || row.minted_to_wallet_at))
                ? { background: "rgba(168,85,247,0.15)", color: accentText("#C084FC"), border: "1px solid rgba(168,85,247,0.4)" }
                : row.has_buy
                  ? { background: "rgba(52,211,153,0.12)", color: "var(--rpc-success-text)", border: "1px solid rgba(52,211,153,0.4)" }
                  : { background: "var(--rpc-surface-hover)", color: "var(--rpc-text-secondary)", border: "1px solid var(--rpc-border-hover)" }
            }
          >
            {acquiredLine}
          </span>
        </div>
      )}
      {chain.length > 0 && (
        <div>
          <div style={{ fontFamily: condensedFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-secondary)", marginBottom: 6 }}>Ownership chain</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-secondary)" }}>
            {chain.map((c: any, i: number) => (
              <span key={i} style={{ padding: "4px 8px", background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 4 }}>
                {c.from ? `${(c.from ?? "").slice(0, 6)}… → ` : ""}
                {(c.to ?? c.owner ?? "").slice(0, 6)}…
                {c.sale_price != null && <span style={{ color: "var(--rpc-success-text)", marginLeft: 6 }}>{fmtUsd(Number(c.sale_price))}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {pulls.length > 0 && (
        <div>
          <div style={{ fontFamily: condensedFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-secondary)", marginBottom: 6 }}>
            Pulls ({pulls.length}){pullsSourceNote(lifecycle.pulls_source) ? <span style={{ textTransform: "none", letterSpacing: 0, fontFamily: monoFont, color: "var(--rpc-text-muted)" }}> · {pullsSourceNote(lifecycle.pulls_source)}</span> : null}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6 }}>
            {pulls.map((p: any, i: number) => (
              <div key={i} style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 4, padding: 4 }}>
                {p.thumbnail_url ? <img src={proxyIpfsImageUrl(p.thumbnail_url, 320) ?? undefined} alt="" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 2 }} /> : <div style={{ width: "100%", aspectRatio: "1 / 1", background: "#1a1a1d", borderRadius: 2 }} />}
                <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, color: "var(--rpc-text-primary)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.player_name ?? p.character_name ?? "—"}</div>
                {p.named_by === "id_neighbours" && (
                  <div title="No record names this moment; its edition is inferred from the moments minted beside it" style={{ fontFamily: monoFont, fontSize: 9, color: "var(--rpc-text-muted)" }}>est. name</div>
                )}
                {packPullSerialLabel(p.serial_number, p.circulation_count) && (
                  <div style={{ fontFamily: monoFont, fontSize: 9, color: "var(--rpc-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{packPullSerialLabel(p.serial_number, p.circulation_count)}</div>
                )}
                <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-secondary)" }}>{fmtUsd(p.current_fmv ?? p.fmv_usd ?? null)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {pulls.length === 0 && (row.has_rip || row.status === "ripped") && (
        <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)" }}>
          What this pack pulled isn&apos;t identified yet.
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
    background: disabled ? "var(--rpc-surface)" : "var(--rpc-surface-hover)",
    color: disabled ? "rgba(255,255,255,0.3)" : "var(--rpc-text-primary)",
    border: "1px solid var(--rpc-border)",
    borderRadius: 4,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: monoFont,
    fontSize: 10,
    letterSpacing: "0.06em",
  }
}
