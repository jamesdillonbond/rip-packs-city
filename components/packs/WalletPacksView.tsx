"use client"

// WalletPacksView — the "Packs" body under the Collection tab (2026-07-18 IA
// reorg). It shows the connected/searched wallet's SEALED-PACK activity scoped
// to the current collection: a compact P&L hero + a pack timeline, reusing the
// existing (tested) /api/wallet/pack-summary + /api/wallet/pack-history
// endpoints. Wallet resolves from ?wallet=/?address= (the same params the
// Collection Moments view's AutoSearchReader reads) or the local owner key.
//
// This is deliberately lean — the full expand-to-lifecycle view lives at
// /dashboard/packs; here we surface the collection-scoped summary + list and
// link out to the deep view. Gated to Top Shot + NFL All Day (the only
// collections with meaningful pack-ownership data).

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { getOwnerKey } from "@/lib/owner-key"
import { getCollection, toDbSlug } from "@/lib/collections"

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
  by_collection: SummaryCollection[]
}

interface HistoryRow {
  pack_nft_id: string
  dist_id: string | null
  pack_name: string | null
  pack_image: string | null
  collection_slug: string
  status: "ripped" | "flipped" | "sold" | "held" | "other"
  has_buy: boolean
  has_rip: boolean
  has_sell: boolean
  buy_price: number | null
  buy_currency: string | null
  sell_price: number | null
  pull_value_usd: number | null
  realized_pl_usd: number | null
  latest_event_at: string | null
}

interface History {
  packs: HistoryRow[]
  total_count: number
}

const PAGE_SIZE = 25
const mono = "var(--font-mono)"
const display = "var(--font-display)"

const STATUS_COLOR: Record<HistoryRow["status"], string> = {
  ripped: "#3B82F6",
  flipped: "#A855F7",
  sold: "#34D399",
  held: "var(--rpc-text-muted)",
  other: "var(--rpc-text-muted)",
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

export default function WalletPacksView({ collection }: { collection: string }) {
  const searchParams = useSearchParams()
  const accent = getCollection(collection)?.accent ?? "var(--rpc-red)"
  const dbSlug = toDbSlug(collection)

  const [wallet, setWallet] = useState<string | null>(null)
  useEffect(() => {
    const fromUrl = searchParams.get("wallet") || searchParams.get("address")
    const owner = getOwnerKey()
    const resolved = (fromUrl || owner || "").trim().toLowerCase()
    setWallet(resolved && resolved.startsWith("0x") ? resolved : null)
  }, [searchParams])

  const [summaryRow, setSummaryRow] = useState<SummaryCollection | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authRequired, setAuthRequired] = useState(false)
  const [page, setPage] = useState(0)

  useEffect(() => { setPage(0) }, [wallet, collection])

  const load = useCallback(async () => {
    if (!wallet) { setSummaryRow(null); setHistory(null); return }
    setLoading(true)
    setError(null)
    setAuthRequired(false)
    try {
      const [sumRes, histRes] = await Promise.all([
        fetch("/api/wallet/pack-summary?wallet=" + encodeURIComponent(wallet), { cache: "no-store" }),
        fetch(
          "/api/wallet/pack-history?" +
            new URLSearchParams({
              wallet,
              status: "all",
              limit: String(PAGE_SIZE),
              offset: String(page * PAGE_SIZE),
              ...(dbSlug ? { collection: dbSlug } : {}),
            }).toString(),
          { cache: "no-store" },
        ),
      ])
      // Pack P&L (buy price / realized P&L) stays behind sign-in per the un-gate
      // policy — a 401/403 means "sign in", not a hard error.
      if (histRes.status === 401 || histRes.status === 403 || sumRes.status === 401 || sumRes.status === 403) {
        setAuthRequired(true)
        setHistory(null)
        setSummaryRow(null)
        return
      }
      const sumJson = await sumRes.json().catch(() => null)
      const histJson = await histRes.json().catch(() => null)
      if (!histRes.ok) {
        setError(histJson?.error ?? "Failed to load pack history")
        setHistory(null)
      } else {
        setHistory(histJson as History)
      }
      const row =
        sumRes.ok && sumJson?.by_collection
          ? ((sumJson as Summary).by_collection.find(
              (c) => c.collection_slug === dbSlug || c.collection_slug === collection,
            ) ?? null)
          : null
      setSummaryRow(row)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [wallet, dbSlug, collection, page])

  useEffect(() => { load() }, [load])

  const totalPages = useMemo(
    () => (history ? Math.max(1, Math.ceil(history.total_count / PAGE_SIZE)) : 1),
    [history],
  )

  // ── No wallet: honest CTA ──────────────────────────────────────────────
  if (!wallet) {
    return (
      <div className="rpc-card" style={{ padding: 32, textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 30, color: "var(--rpc-text-ghost)" }}>📦</div>
        <div className="rpc-heading" style={{ fontSize: 16 }}>Your sealed packs</div>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)", maxWidth: 460, lineHeight: 1.7 }}>
          Search a wallet on the <strong>Moments</strong> tab (or connect yours) to see its pack buys, rips,
          flips, and realized P&amp;L for {getCollection(collection)?.label ?? "this collection"}.
        </div>
        <Link href="/dashboard/packs" className="rpc-chip" style={{ marginTop: 4, color: accent, borderColor: accent }}>
          Full pack history →
        </Link>
      </div>
    )
  }

  // ── Auth required: pack P&L is a signed-in feature ─────────────────────
  if (authRequired) {
    return (
      <div className="rpc-card" style={{ padding: 32, textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 30, color: "var(--rpc-text-ghost)" }}>🔒</div>
        <div className="rpc-heading" style={{ fontSize: 16 }}>Sign in to see pack P&amp;L</div>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)", maxWidth: 460, lineHeight: 1.7 }}>
          Pack buy prices, rips, and realized P&amp;L are part of your personal dashboard. Sign in to view the
          full pack history for this wallet.
        </div>
        <Link href="/login" className="rpc-chip" style={{ marginTop: 4, color: accent, borderColor: accent }}>
          Sign in →
        </Link>
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Collection-scoped hero */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Stat label="Packs purchased" value={summaryRow ? summaryRow.packs_purchased.toLocaleString("en-US") : "—"} tint="var(--rpc-text-primary)" />
        <Stat label="Total spent" value={fmtUsd(summaryRow?.spent_usd)} tint="var(--rpc-text-primary)" />
        <Stat label="Ripped value" value={fmtUsd(summaryRow?.ripped_value_usd)} tint="#34D399" />
        <Stat
          label="Net P&L"
          value={fmtUsd(summaryRow?.net_pl_usd)}
          tint={summaryRow && summaryRow.net_pl_usd >= 0 ? "#34D399" : "var(--rpc-red)"}
        />
      </section>

      {/* History table */}
      <section className="rpc-card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading packs…</div>
        ) : error ? (
          <div style={{ padding: 16, fontFamily: mono, fontSize: 12, color: "#F87171" }}>{error}</div>
        ) : !history || history.packs.length === 0 ? (
          <div style={{ padding: 26, textAlign: "center", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-muted)" }}>
            No pack activity for this wallet in {getCollection(collection)?.label ?? "this collection"}.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse", fontFamily: mono, fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--rpc-border)", color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 9 }}>
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
                  const sc = STATUS_COLOR[row.status] ?? "var(--rpc-text-muted)"
                  const plTint = row.realized_pl_usd != null ? (row.realized_pl_usd >= 0 ? "#34D399" : "var(--rpc-red)") : "var(--rpc-text-muted)"
                  const packName = row.pack_name ?? `Pack #${row.pack_nft_id.slice(-6)}`
                  return (
                    <tr key={row.pack_nft_id} style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                      <td style={{ padding: "9px 12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ width: 34, height: 34, borderRadius: 4, background: "var(--rpc-surface-hover)", overflow: "hidden", flexShrink: 0, display: "inline-block" }}>
                            {row.pack_image && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={row.pack_image} alt="" width={34} height={34} style={{ objectFit: "cover", width: 34, height: 34 }} />
                            )}
                          </span>
                          {row.dist_id ? (
                            <Link
                              href={`/${collection}/packs/simulator/${encodeURIComponent(row.dist_id)}`}
                              style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontFamily: display, fontWeight: 700, fontSize: 12 }}
                            >
                              {packName}
                            </Link>
                          ) : (
                            <span style={{ fontFamily: display, fontWeight: 700, fontSize: 12, color: "var(--rpc-text-secondary)" }}>{packName}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 3, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", background: sc + "22", color: sc, border: `1px solid ${sc}66` }}>
                          {row.status}
                        </span>
                      </td>
                      <td style={{ padding: "9px 12px", color: "var(--rpc-text-secondary)" }}>{relativeTime(row.latest_event_at)}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>
                        {row.has_buy ? fmtUsd(row.buy_price) + (row.buy_currency ? ` ${row.buy_currency}` : "") : "—"}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{row.has_sell ? fmtUsd(row.sell_price) : "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{row.has_rip ? fmtUsd(row.pull_value_usd) : "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: plTint, fontFamily: display, fontWeight: 700 }}>{fmtUsd(row.realized_pl_usd)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {history && history.total_count > PAGE_SIZE && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderTop: "1px solid var(--rpc-border)", fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            <span>Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, history.total_count)} of {history.total_count}</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="rpc-chip" style={{ opacity: page === 0 ? 0.4 : 1 }}>← Prev</button>
              <button type="button" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} className="rpc-chip" style={{ opacity: page + 1 >= totalPages ? 0.4 : 1 }}>Next →</button>
            </span>
          </div>
        )}
      </section>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Link href="/dashboard/packs" className="rpc-chip" style={{ color: accent, borderColor: accent }}>
          Full pack history + lifecycle →
        </Link>
      </div>
    </div>
  )
}

function Stat({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div className="rpc-card" style={{ padding: "12px 14px" }}>
      <div style={{ fontFamily: mono, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 26, lineHeight: 1.1, color: tint, marginTop: 4 }}>{value}</div>
    </div>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th style={{ padding: "9px 12px", textAlign: right ? "right" : "left", fontWeight: 700 }}>{children}</th>
}
