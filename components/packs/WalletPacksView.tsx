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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { getOwnerKey } from "@/lib/owner-key"
import { getCollection, toDbSlug } from "@/lib/collections"
import {
  fmtPackUsd,
  netPlTint,
  packDisplayName,
  packStatusColor,
  realizedPlTint,
  relativePackTime,
  PACK_FILTERS,
  PACK_FILTER_LABEL,
  PACK_FILTER_STATUS,
  type PackFilter,
} from "@/lib/packs-wallet-view-format"

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

export type { PackFilter }

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

  // ── Opened | Unopened sub-filter (Trevor 2026-07-18) ─────────────────────
  // Maps onto get_wallet_pack_history's existing p_status rather than
  // filtering client-side, so server-side pagination + total_count stay
  // correct for the active tab.
  //   Unopened -> 'held'     (still sealed in the wallet)
  //   Opened   -> 'ripped'   (has a pack_rips row)
  //   Sold     -> 'sold_any' (flipped + sold — sold on while still sealed)
  // Together these cover every status the classifier can emit except 'other',
  // which is degenerate (no buy, no sell, no rip) and measured empty
  // platform-wide. Verified on this wallet: held 94 + ripped 117 = 211 = all.
  const [packFilter, setPackFilter] = useState<PackFilter>("unopened")

  useEffect(() => { setPage(0) }, [wallet, collection, packFilter])

  // Monotonic request id — only the newest load()'s response is applied.
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!wallet) { setSummaryRow(null); setHistory(null); return }
    // Stale-response guard. `page` is reset to 0 in a separate effect on a
    // filter/wallet change, so a filter switch while on page ≥ 1 issues two
    // overlapping fetches (stale offset, then offset 0). Without a guard a slow
    // stale response can land last and paint page-2 rows under a "Showing 1–25"
    // footer, or the wrong filter's rows. Only the newest request applies —
    // same reqIdRef pattern the sibling TeamChecklist loader uses.
    const myReq = ++reqIdRef.current
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
              status: PACK_FILTER_STATUS[packFilter],
              limit: String(PAGE_SIZE),
              offset: String(page * PAGE_SIZE),
              ...(dbSlug ? { collection: dbSlug } : {}),
            }).toString(),
          { cache: "no-store" },
        ),
      ])
      if (myReq !== reqIdRef.current) return // superseded by a newer load
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
      if (myReq !== reqIdRef.current) return // superseded during body parse
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
      if (myReq === reqIdRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (myReq === reqIdRef.current) setLoading(false)
    }
  }, [wallet, dbSlug, collection, page, packFilter])

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
          Search a wallet on the <strong>Moments</strong>{" "}tab to see its pack buys, rips,
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
        <Stat label="Total spent" value={fmtPackUsd(summaryRow?.spent_usd)} tint="var(--rpc-text-primary)" />
        <Stat label="Ripped value" value={fmtPackUsd(summaryRow?.ripped_value_usd)} tint="#34D399" />
        <Stat
          label="Net P&L"
          value={fmtPackUsd(summaryRow?.net_pl_usd)}
          tint={summaryRow ? netPlTint(summaryRow.net_pl_usd) : "var(--rpc-red)"}
        />
      </section>

      {/* Opened | Unopened sub-filter */}
      <div style={{ display: "flex", gap: 6 }}>
        {PACK_FILTERS.map((f) => {
          const on = packFilter === f
          return (
            <button
              key={f}
              type="button"
              onClick={() => setPackFilter(f)}
              aria-pressed={on}
              style={{
                fontFamily: display,
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                padding: "6px 14px",
                minHeight: 32,
                borderRadius: 4,
                cursor: "pointer",
                background: on ? accent : "transparent",
                color: on ? "#fff" : "var(--rpc-text-muted)",
                border: `1px solid ${on ? accent : "var(--rpc-border)"}`,
              }}
            >
              {PACK_FILTER_LABEL[f]}
            </button>
          )
        })}
      </div>

      {/* History table */}
      <section className="rpc-card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading packs…</div>
        ) : error ? (
          <div style={{ padding: 16, fontFamily: mono, fontSize: 12, color: "#F87171" }}>{error}</div>
        ) : !history || history.packs.length === 0 ? (
          <div style={{ padding: 26, textAlign: "center", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-muted)" }}>
            {packFilter === "unopened"
              ? `No sealed packs held in ${getCollection(collection)?.label ?? "this collection"}.`
              : packFilter === "opened"
                ? `No opened packs for this wallet in ${getCollection(collection)?.label ?? "this collection"}.`
                : `No packs sold on while sealed in ${getCollection(collection)?.label ?? "this collection"}.`}
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
                  const sc = packStatusColor(row.status)
                  const plTint = realizedPlTint(row.realized_pl_usd)
                  const packName = packDisplayName(row.pack_name, row.pack_nft_id)
                  return (
                    <tr key={row.pack_nft_id} style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                      <td style={{ padding: "9px 12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {/* Sealed packs have no distribution linked yet (the
                              Top Shot primary_withdraw event carries no dist id
                              — it resolves on open), so pack_image is NULL for
                              them. Render a pack glyph rather than an empty
                              grey square so an unopened row reads as "sealed",
                              not "broken image". */}
                          <span style={{ width: 34, height: 34, borderRadius: 4, background: "var(--rpc-surface-hover)", overflow: "hidden", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: "var(--rpc-text-ghost)" }}>
                            {row.pack_image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={row.pack_image} alt="" width={34} height={34} style={{ objectFit: "cover", width: 34, height: 34 }} />
                            ) : (
                              <span aria-hidden>📦</span>
                            )}
                          </span>
                          {/* EVERY row is reachable. dist_id is NULL for every
                              sealed pack (the Top Shot primary_withdraw event
                              carries no dist id — it resolves on open), so
                              gating the only interactive element on dist_id
                              left the Unopened tab with ZERO click targets.
                              Fall back to the per-pack lifecycle route, which
                              is keyed on the pack_nft_id we already have and
                              308-redirects to the distribution page when the
                              lifecycle data is thin. */}
                          {row.dist_id ? (
                            <Link
                              href={`/${collection}/packs/simulator/${encodeURIComponent(row.dist_id)}`}
                              style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontFamily: display, fontWeight: 700, fontSize: 12 }}
                            >
                              {packName}
                            </Link>
                          ) : (
                            <Link
                              href={`/${collection}/pack/${encodeURIComponent(row.pack_nft_id)}`}
                              title="Sealed pack — which distribution it came from is only recorded on-chain when the pack is opened."
                              style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontFamily: display, fontWeight: 700, fontSize: 12 }}
                            >
                              {packName}
                            </Link>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 3, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", background: sc + "22", color: sc, border: `1px solid ${sc}66` }}>
                          {row.status}
                        </span>
                      </td>
                      <td style={{ padding: "9px 12px", color: "var(--rpc-text-secondary)" }}>{relativePackTime(row.latest_event_at)}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>
                        {row.has_buy ? fmtPackUsd(row.buy_price) + (row.buy_currency ? ` ${row.buy_currency}` : "") : "—"}
                      </td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{row.has_sell ? fmtPackUsd(row.sell_price) : "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{row.has_rip ? fmtPackUsd(row.pull_value_usd) : "—"}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: plTint, fontFamily: display, fontWeight: 700 }}>{fmtPackUsd(row.realized_pl_usd)}</td>
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
