"use client"

// app/dashboard/history/page.tsx
//
// Unified transaction history — one reverse-chronological timeline of pack
// buys, pack opens, moment buys, moment pulls, and moment sells for the user's
// verified wallets. Auth-gated via proxy.ts + the /dashboard layout (noindex).
// Wallets resolve via /api/profile/saved-wallets (verified only); the timeline
// comes from /api/wallet/transaction-history, which wraps the wallet-agnostic
// SECDEF RPC get_wallet_transaction_history.
//
// Kind tabs: All / Packs / Buys / Sells / Pulls. "All" shows pack opens
// summarized (moments_pulled badge) but not the individual pulled moments — the
// "Pulls" tab surfaces those, so a pack open is never double-counted.

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { DB_SLUG_TO_SLUG } from "@/lib/collections"

const condensedFont = "var(--font-display)"
const monoFont = "var(--font-mono)"
const ACCENT_RED = "var(--rpc-red, #E03A2F)"

interface SavedWallet {
  wallet_addr: string
  verified_at: string | null
}

type Kind = "pack_buy" | "pack_open" | "moment_buy" | "moment_pull" | "moment_sell"

interface TxEvent {
  kind: Kind
  occurred_at: string | null
  collection_id: string
  collection_slug: string
  collection_name: string
  title: string
  subtitle: string | null
  thumbnail_url: string | null
  amount_usd: number | null
  currency: string | null
  counterparty: string | null
  method: string | null
  moments_pulled: number | null
  serial_number: number | null
  nft_id: string | null
  pack_nft_id: string | null
  dist_id: string | null
}

interface HistoryResponse {
  wallet: string
  kind_filter: string
  limit: number
  offset: number
  total_count: number
  events: TxEvent[]
  computed_at?: string
  error?: string
}

type FilterKey = "all" | "packs" | "buys" | "sells" | "pulls"

const FILTER_OPTIONS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "packs", label: "Packs" },
  { key: "buys", label: "Buys" },
  { key: "sells", label: "Sells" },
  { key: "pulls", label: "Pulls" },
]

const PAGE_SIZE = 50

// Per-kind presentation. `verb` is the timeline label; `tint` colors the chip
// and (for sells, which are proceeds) the amount.
const KIND_META: Record<Kind, { verb: string; tint: string }> = {
  pack_buy: { verb: "Bought pack", tint: "#A855F7" },
  pack_open: { verb: "Opened pack", tint: "#3B82F6" },
  moment_buy: { verb: "Bought", tint: "#F59E0B" },
  moment_pull: { verb: "Pulled", tint: "#A855F7" },
  moment_sell: { verb: "Sold", tint: "#34D399" },
}

// Acquisition method → friendlier label for non-marketplace moment_buy rows.
const METHOD_LABEL: Record<string, string> = {
  gift: "Gift",
  challenge_reward: "Challenge reward",
  loan_default: "Loan default",
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  if (v === 0) return "$0"
  if (Math.abs(v) >= 1000) return "$" + Math.round(v).toLocaleString("en-US")
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
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

function truncAddr(a: string | null): string {
  if (!a) return ""
  if (a.length <= 12) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

function urlSlug(dbSlug: string): string {
  return DB_SLUG_TO_SLUG[dbSlug] ?? dbSlug
}

function eventHref(e: TxEvent): string | null {
  if (e.kind === "pack_buy" || e.kind === "pack_open") {
    return e.dist_id ? `/${urlSlug(e.collection_slug)}/packs/simulator/${encodeURIComponent(e.dist_id)}` : null
  }
  return e.nft_id ? `/moment/${encodeURIComponent(e.nft_id)}` : null
}

export default function TransactionHistoryDashboard() {
  const [wallets, setWallets] = useState<SavedWallet[]>([])
  const [walletsLoading, setWalletsLoading] = useState(true)
  const [activeWallet, setActiveWallet] = useState<string | null>(null)

  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const [filter, setFilter] = useState<FilterKey>("all")
  const [page, setPage] = useState(0)

  // ── Load verified wallets on mount ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      setWalletsLoading(true)
      try {
        const res = await fetch("/api/profile/saved-wallets", { cache: "no-store" })
        if (!res.ok) {
          if (!cancelled) setWallets([])
          return
        }
        const json = (await res.json()) as { wallets?: SavedWallet[] }
        const verifiedSet = new Map<string, SavedWallet>()
        for (const w of json.wallets ?? []) {
          if (!w.verified_at) continue
          const k = w.wallet_addr.toLowerCase()
          if (!verifiedSet.has(k)) verifiedSet.set(k, { wallet_addr: k, verified_at: w.verified_at })
        }
        if (cancelled) return
        const list = Array.from(verifiedSet.values())
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

  // ── Load timeline when wallet / filter / page change ─────────────────────
  const loadHistory = useCallback(async () => {
    if (!activeWallet) return
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const params = new URLSearchParams({
        wallet: activeWallet,
        kind: filter,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      })
      const res = await fetch("/api/wallet/transaction-history?" + params.toString(), { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        setHistoryError(json?.error ?? "Failed to load history")
        setHistory(null)
      } else {
        setHistory(json as HistoryResponse)
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setHistoryLoading(false)
    }
  }, [activeWallet, filter, page])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // Reset page when filter / wallet changes.
  useEffect(() => {
    setPage(0)
  }, [filter, activeWallet])

  const totalPages = useMemo(() => {
    if (!history) return 1
    return Math.max(1, Math.ceil(history.total_count / PAGE_SIZE))
  }, [history])

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800;900&family=Share+Tech+Mono&display=swap');
        .rpc-tx-row { transition: background 120ms ease; }
        .rpc-tx-row:hover { background: #16161a; }
        .rpc-tx-chip { display: inline-flex; padding: 2px 8px; font-family: ${monoFont}; font-size: 10px; letter-spacing: 0.06em; border-radius: 3px; text-transform: uppercase; }
      `}</style>

      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "26px 22px 60px", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 28, letterSpacing: "0.04em", textTransform: "uppercase", margin: 0 }}>
              Transaction History
            </h1>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
              Every pack and moment that moved through your verified wallets.
            </div>
          </div>
          <Link href="/dashboard" style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", textDecoration: "none", padding: "7px 12px", border: `1px solid ${ACCENT_RED}66`, borderRadius: 5 }}>
            ← Dashboard
          </Link>
        </div>

        {/* Wallet selector */}
        {walletsLoading ? (
          <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Loading wallets…</div>
        ) : wallets.length === 0 ? (
          <div style={{ padding: 18, border: "1px dashed #444", borderRadius: 8, textAlign: "center" }}>
            <div style={{ fontFamily: condensedFont, fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 6 }}>
              No verified wallets yet
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 12 }}>
              Transaction history reads from your verified wallets. Verify a wallet from your dashboard, then come back here.
            </div>
            <Link href="/dashboard" style={{ display: "inline-block", padding: "8px 16px", background: ACCENT_RED, color: "#fff", borderRadius: 6, fontFamily: condensedFont, fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}>
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
                  background: w.wallet_addr === activeWallet ? ACCENT_RED : "#0d0d0d",
                  border: `1px solid ${w.wallet_addr === activeWallet ? ACCENT_RED : "#27272a"}`,
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

        {/* Kind filter */}
        {activeWallet && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {FILTER_OPTIONS.map((o) => (
              <button
                key={o.key}
                onClick={() => setFilter(o.key)}
                style={{
                  padding: "6px 14px",
                  background: o.key === filter ? ACCENT_RED : "#0d0d0d",
                  color: o.key === filter ? "#fff" : "rgba(255,255,255,0.7)",
                  border: `1px solid ${o.key === filter ? ACCENT_RED : "#27272a"}`,
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

        {/* Timeline */}
        {activeWallet && (
          <section style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8, overflow: "hidden" }}>
            {historyLoading ? (
              <div style={{ padding: 18, fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)", textAlign: "center" }}>Loading history…</div>
            ) : historyError ? (
              <div style={{ padding: 14, fontFamily: monoFont, fontSize: 12, color: "#F87171" }}>{historyError}</div>
            ) : !history || history.events.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "rgba(255,255,255,0.55)", fontFamily: monoFont, fontSize: 12 }}>
                No activity for this filter.
              </div>
            ) : (
              <div>
                {history.events.map((e, i) => (
                  <TimelineRow key={`${e.kind}-${e.pack_nft_id ?? e.nft_id ?? i}-${e.occurred_at ?? i}-${i}`} e={e} />
                ))}
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

function TimelineRow({ e }: { e: TxEvent }) {
  const meta = KIND_META[e.kind]
  const isPack = e.kind === "pack_buy" || e.kind === "pack_open"
  const href = eventHref(e)

  // Verb: moment_buy with a non-marketplace method reads its method label.
  const verb =
    e.kind === "moment_buy" && e.method && METHOD_LABEL[e.method]
      ? METHOD_LABEL[e.method]
      : meta.verb

  // Amount tint: sells are proceeds (green); everything else neutral.
  const amountTint = e.kind === "moment_sell" ? "#34D399" : "rgba(255,255,255,0.9)"
  const amountText = e.amount_usd != null ? fmtUsd(e.amount_usd) + (e.currency ? " " + e.currency : "") : "—"

  const counterpartyLabel =
    e.kind === "moment_sell" && e.counterparty
      ? "to " + truncAddr(e.counterparty)
      : (e.kind === "moment_buy" || e.kind === "pack_buy") && e.counterparty
        ? "from " + truncAddr(e.counterparty)
        : null

  const titleNode = (
    <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, letterSpacing: "0.01em", color: href ? "#fff" : "rgba(255,255,255,0.85)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {e.title}
    </span>
  )

  return (
    <div className="rpc-tx-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderBottom: "1px solid #1a1a1d" }}>
      {/* Thumbnail */}
      <div style={{ width: 44, height: 44, borderRadius: 5, background: "#1a1a1d", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)", fontFamily: monoFont, fontSize: 16 }}>
        {e.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={e.thumbnail_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : isPack ? "▣" : "?"}
      </div>

      {/* Title + meta */}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span className="rpc-tx-chip" style={{ background: meta.tint + "22", color: meta.tint, border: `1px solid ${meta.tint}66`, flexShrink: 0 }}>{verb}</span>
          {href ? (
            <Link href={href} style={{ textDecoration: "none", minWidth: 0 }}>{titleNode}</Link>
          ) : (
            titleNode
          )}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {e.subtitle && <span>{e.subtitle}</span>}
          <span>{e.collection_name}</span>
          {e.kind === "pack_open" && e.moments_pulled != null && <span>· {e.moments_pulled} pulled</span>}
          {counterpartyLabel && <span>· {counterpartyLabel}</span>}
        </div>
      </div>

      {/* Amount + time */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, gap: 3 }}>
        <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, color: amountTint }}>{amountText}</span>
        <span style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.45)" }}>{relativeTime(e.occurred_at)}</span>
      </div>
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
