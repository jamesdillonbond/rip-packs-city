"use client"

// WalletSoldMomentsView — the "Sold" body under the Collection tab's
// Moments sub-toggle (Trevor 2026-07-18: "for Moments have Owned and Sold").
//
// Owned is the existing wmc-backed grid; this is its counterpart: the moments
// this wallet has SOLD, newest first, with art / title / set / serial / sale
// price / buyer.
//
// Data: the existing (tested) /api/wallet/transaction-history?kind=sells,
// which wraps SECDEF get_wallet_transaction_history. No new backend surface.
//
// TWO HONEST CONSTRAINTS, both surfaced in the UI rather than hidden:
//  1. That route gates on a VERIFIED saved wallet (saved_wallets.verified_at),
//     exactly like pack P&L — so this is an own-wallet view. A 401/403 renders
//     a sign-in / verify CTA, not an error.
//  2. The RPC has no collection parameter, so we filter by collection_slug
//     client-side over one fetched page. Selling is rare (the reference wallet
//     has 7 sells lifetime), so a single 200-row page covers essentially every
//     real wallet — but when total_count exceeds the page we say so instead of
//     silently truncating.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { getOwnerKey } from "@/lib/owner-key"
import { getCollection, toDbSlug, fromDbSlug } from "@/lib/collections"
import {
  fmtSoldUsd,
  relativeSaleTime,
  shortSellerAddr,
  filterSoldEventsByCollection,
  sumSoldProceeds,
  isSoldListTruncated,
} from "@/lib/collection-sold-moments-format"

const mono = "var(--font-mono)"
const display = "var(--font-display)"
const FETCH_LIMIT = 200

interface SellEvent {
  kind: string
  nft_id: string | null
  title: string | null
  subtitle: string | null
  thumbnail_url: string | null
  serial_number: number | null
  amount_usd: number | null
  currency: string | null
  occurred_at: string | null
  counterparty: string | null
  collection_slug: string | null
}

interface TxHistory {
  events: SellEvent[]
  total_count: number
}

export default function WalletSoldMomentsView({ collection }: { collection: string }) {
  const searchParams = useSearchParams()
  const accent = getCollection(collection)?.accent ?? "var(--rpc-red)"
  // Resolve the canonical DB slug ("nba_top_shot") the RPC emits. `collection` is
  // normally the URL slug ("nba-top-shot"), but accept it ALREADY being the DB
  // slug too (fromDbSlug resolves it) so a mis-passed form can't silently zero the
  // board. Null only when the collection is genuinely unrecognizable.
  const dbSlug = toDbSlug(collection) ?? (fromDbSlug(collection) ? collection : null)

  const [wallet, setWallet] = useState<string | null>(null)
  const [data, setData] = useState<TxHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authRequired, setAuthRequired] = useState(false)

  useEffect(() => {
    const fromUrl = searchParams.get("wallet") || searchParams.get("address")
    const owner = getOwnerKey()
    const resolved = (fromUrl || owner || "").trim().toLowerCase()
    setWallet(resolved && resolved.startsWith("0x") ? resolved : null)
  }, [searchParams])

  const load = useCallback(async () => {
    if (!wallet) { setData(null); return }
    setLoading(true)
    setError(null)
    setAuthRequired(false)
    try {
      const res = await fetch(
        "/api/wallet/transaction-history?" +
          new URLSearchParams({ wallet, kind: "sells", limit: String(FETCH_LIMIT), offset: "0" }).toString(),
        { cache: "no-store" },
      )
      if (res.status === 401 || res.status === 403) {
        setAuthRequired(true)
        setData(null)
        return
      }
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setError(json?.error ?? "Failed to load sold moments")
        setData(null)
        return
      }
      setData(json as TxHistory)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [wallet])

  useEffect(() => { load() }, [load])

  // Collection filter is client-side (the RPC takes no collection param). Accept
  // either identifier form (DB slug or raw prop) and TRIM the event value, so a
  // slug-form or stray-whitespace mismatch can't drop every real row — matching
  // the sibling WalletPacksView's two-form comparison. Both members of `accept`
  // are THIS collection's own identifiers, so this never leaks another
  // collection's sales onto the board. When the collection is unresolvable
  // (dbSlug null), fall back to showing everything (documented) rather than nothing.
  const rows = useMemo(() => {
    return filterSoldEventsByCollection(data?.events ?? [], dbSlug, collection)
  }, [data, dbSlug, collection])

  // Diagnostic: if the fetch returned events but the filter zeroed them out,
  // surface dbSlug + the raw prop + a sample of event slugs side-by-side in the
  // console, so a slug mismatch is visible rather than a silent empty board.
  useEffect(() => {
    if (!loading && (data?.events?.length ?? 0) > 0 && rows.length === 0) {
      console.warn("[WalletSoldMomentsView] filtered to 0 rows", {
        dbSlug,
        collection,
        sampleEventSlugs: Array.from(
          new Set((data?.events ?? []).map((e) => e.collection_slug)),
        ).slice(0, 5),
      })
    }
  }, [loading, data, rows.length, dbSlug, collection])

  const totalProceeds = useMemo(() => sumSoldProceeds(rows), [rows])

  const truncated = isSoldListTruncated(data?.total_count, FETCH_LIMIT)
  const label = getCollection(collection)?.label ?? "this collection"

  if (!wallet) {
    return (
      <div className="rpc-card" style={{ padding: 32, textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 30, color: "var(--rpc-text-ghost)" }}>💸</div>
        <div className="rpc-heading" style={{ fontSize: 16 }}>Moments you&apos;ve sold</div>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)", maxWidth: 460, lineHeight: 1.7 }}>
          Search a wallet to see the moments it has sold in {label}.
        </div>
      </div>
    )
  }

  if (authRequired) {
    return (
      <div className="rpc-card" style={{ padding: 32, textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 30, color: "var(--rpc-text-ghost)" }}>🔒</div>
        <div className="rpc-heading" style={{ fontSize: 16 }}>Sign in to see sold moments</div>
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)", maxWidth: 460, lineHeight: 1.7 }}>
          Sale history is part of your personal dashboard — it&apos;s available for wallets verified on your
          own account.
        </div>
        <a href="/login" className="rpc-chip" style={{ marginTop: 4, color: accent, borderColor: accent }}>Sign in →</a>
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <div className="rpc-card" style={{ padding: "12px 14px" }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>Moments sold</div>
          <div style={{ fontFamily: display, fontWeight: 800, fontSize: 26, lineHeight: 1.1, color: "var(--rpc-text-primary)", marginTop: 4 }}>
            {loading ? "—" : rows.length.toLocaleString("en-US")}
          </div>
        </div>
        <div className="rpc-card" style={{ padding: "12px 14px" }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>Total proceeds</div>
          <div style={{ fontFamily: display, fontWeight: 800, fontSize: 26, lineHeight: 1.1, color: "#34D399", marginTop: 4 }}>
            {loading ? "—" : fmtSoldUsd(totalProceeds)}
          </div>
        </div>
      </section>

      <section className="rpc-card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading sold moments…</div>
        ) : error ? (
          <div style={{ padding: 16, fontFamily: mono, fontSize: 12, color: "#F87171" }}>{error}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 26, textAlign: "center", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-muted)" }}>
            No moments sold from this wallet in {label}.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse", fontFamily: mono, fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--rpc-border)", color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 9 }}>
                  <th style={{ padding: "9px 12px", textAlign: "left", fontWeight: 700 }}>Moment</th>
                  <th style={{ padding: "9px 12px", textAlign: "left", fontWeight: 700 }}>Serial</th>
                  <th style={{ padding: "9px 12px", textAlign: "left", fontWeight: 700 }}>When</th>
                  <th style={{ padding: "9px 12px", textAlign: "left", fontWeight: 700 }}>Buyer</th>
                  <th style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700 }}>Sold for</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.nft_id ?? "row"}-${i}`} style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                    <td style={{ padding: "9px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 52, height: 52, borderRadius: 6, background: "var(--rpc-surface-hover)", overflow: "hidden", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "var(--rpc-text-ghost)" }}>
                          {r.thumbnail_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.thumbnail_url} alt="" width={52} height={52} style={{ objectFit: "cover", width: 52, height: 52 }} />
                          ) : (
                            <span aria-hidden>🏀</span>
                          )}
                        </span>
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontFamily: display, fontWeight: 700, fontSize: 12, color: "var(--rpc-text-primary)" }}>
                            {r.title ?? `Moment #${r.nft_id ?? "—"}`}
                          </span>
                          {r.subtitle && (
                            <span style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{r.subtitle}</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "9px 12px", color: "var(--rpc-text-secondary)" }}>
                      {r.serial_number != null ? `#${r.serial_number}` : "—"}
                    </td>
                    <td style={{ padding: "9px 12px", color: "var(--rpc-text-secondary)" }}>{relativeSaleTime(r.occurred_at)}</td>
                    <td style={{ padding: "9px 12px", color: "var(--rpc-text-secondary)" }}>{shortSellerAddr(r.counterparty)}</td>
                    <td style={{ padding: "9px 12px", textAlign: "right", fontFamily: display, fontWeight: 700, color: "#34D399" }}>
                      {fmtSoldUsd(r.amount_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {truncated && (
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--rpc-border)", fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Showing the {FETCH_LIMIT} most recent sales across all collections; this wallet has {data?.total_count.toLocaleString("en-US")} total.
          </div>
        )}

        {/* Coverage disclosure — REQUIRED, do not drop. A "Sold" list that looks
            complete but isn't is worse than no list. `sales` only carries
            buyer/seller for rows ingested by the ON-CHAIN indexer; the bulk of
            history came from the Dapper studio-platform backfills, which carry
            price/edition/serial but NO wallet addresses. Measured 2026-07-18:
            counterparty coverage is 20.9% of NBA Top Shot sales (2.96M rows),
            12.1% All Day, 0.2% Golazos, ~0% UFC Strike. So this list is a
            LOWER BOUND — older sales legitimately go missing. */}
        {!loading && !error && (
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--rpc-border)", fontFamily: mono, fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
            Shows sales where the seller was recorded on-chain. Much of the historical sales record was
            imported with price and edition but no wallet addresses, so sales you made before RPC indexed
            your wallet — or on a venue we only have summary data for — won&apos;t appear here yet. Treat this
            as a lower bound, not a complete sale history.
          </div>
        )}
      </section>
    </div>
  )
}
