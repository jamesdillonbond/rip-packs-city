"use client"

// components/entity/SalesTablePaginated.tsx
// Phase 1B. Recent-sales table with "Load 30 more" client-side pagination.

import { useMemo, useState } from "react"
import Link from "next/link"
import { EM_DASH, fmtUsd, relTime, truncWallet } from "./_shared"
import { useResolveUsernames } from "@/lib/analytics/username-resolver"

interface SaleRow {
  serial_number: number | null
  price_usd: number | null
  marketplace: string | null
  source: string | null
  buyer_address: string | null
  seller_address: string | null
  nft_id: string | null
  transaction_hash: string | null
  sold_at: string | null
  // Top Shot: which printing (Standard / Hexwave / ...) the sale belongs to,
  // resolved per-NFT server-side. NULL on other collections -> column hidden.
  parallel?: string | null
}

interface Props {
  collectionUrlSlug: string
  routeSlug: string
  initial: SaleRow[]
  initialOffset: number
  pageSize: number
  isAllDay: boolean
  // P6b — server-resolved { lowercased addr → username } for the initial rows,
  // so the first paint shows @names instead of flashing raw 0x… for ~2s while
  // the client hook resolves. Optional; the hook still fills paginated rows.
  initialNames?: Record<string, string>
}

const TH: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--rpc-text-muted)",
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "1px solid var(--rpc-border)",
}

const TD: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--rpc-text-primary)",
  padding: "8px 10px",
  borderBottom: "1px solid var(--rpc-border-subtle)",
  whiteSpace: "nowrap",
}

function WalletCell({ address, name }: { address: string | null; name?: string | null }) {
  if (!address) return <span style={{ color: "var(--rpc-text-muted)" }}>{EM_DASH}</span>
  const lower = address.toLowerCase().startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`
  return (
    <Link
      href={`/profile/${lower}`}
      title={name ? `${name} · ${lower}` : lower}
      style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}
    >
      {name ? `@${name}` : truncWallet(address)}
    </Link>
  )
}

export default function SalesTablePaginated({ collectionUrlSlug, routeSlug, initial, initialOffset, pageSize, isAllDay, initialNames }: Props) {
  const [rows, setRows] = useState<SaleRow[]>(initial)
  const [offset, setOffset] = useState<number>(initialOffset)
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(initial.length < pageSize)

  const addrs = useMemo(() => {
    const out: string[] = []
    for (const r of rows) {
      if (r.buyer_address) out.push(r.buyer_address)
      if (r.seller_address) out.push(r.seller_address)
    }
    return out
  }, [rows])
  const names = useResolveUsernames(addrs)
  // P6b — prefer the client-resolved name (covers paginated rows), fall back to
  // the server-seeded map so first-page rows never flash a raw 0x….
  const nameFor = (a: string | null) =>
    a ? (names[a.toLowerCase()] ?? initialNames?.[a.toLowerCase()]) : undefined

  async function loadMore() {
    if (loading || exhausted) return
    setLoading(true)
    try {
      const url = `/api/entity/edition?collection=${encodeURIComponent(collectionUrlSlug)}&slug=${encodeURIComponent(routeSlug)}&part=sales&offset=${offset}&limit=${pageSize}`
      const r = await fetch(url, { cache: "no-store" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const next: SaleRow[] = await r.json()
      const safe = Array.isArray(next) ? next : []
      setRows(prev => [...prev, ...safe])
      setOffset(prev => prev + safe.length)
      if (safe.length < pageSize) setExhausted(true)
    } catch {
      setExhausted(true)
    } finally {
      setLoading(false)
    }
  }

  // Parallel/printing attribution column (2026-07-07) — rendered only when the
  // server resolved a printing for at least one row (Top Shot), so other
  // collections keep the 5-column layout.
  const hasParallelCol = rows.some(r => r.parallel != null && r.parallel !== "")

  if (rows.length === 0) {
    return <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>No sales yet.</div>
  }

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={TH}>Serial</th>
              {hasParallelCol && <th style={TH}>Parallel</th>}
              <th style={TH}>Price</th>
              <th style={TH}>Buyer</th>
              <th style={TH}>Seller</th>
              <th style={TH}>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => {
              const serialCell = isAllDay && (s.serial_number === 0 || s.serial_number === null) ? (
                <span style={{
                  display: "inline-block",
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: "rgba(245,158,11,0.10)",
                  border: "1px solid rgba(245,158,11,0.30)",
                  color: "#F59E0B",
                  fontSize: 9,
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                }}>unresolved</span>
              ) : (s.serial_number != null && s.serial_number > 0 ? `#${s.serial_number}` : EM_DASH)
              return (
                <tr key={`${s.transaction_hash ?? "s"}-${s.serial_number ?? "n"}-${i}`}>
                  <td style={TD}>{serialCell}</td>
                  {hasParallelCol && (
                    <td style={{ ...TD, color: s.parallel && s.parallel !== "Standard" ? "var(--rpc-red)" : "var(--rpc-text-secondary)" }}>
                      {s.parallel ?? EM_DASH}
                    </td>
                  )}
                  <td style={TD}>{fmtUsd(s.price_usd)}</td>
                  <td style={TD}><WalletCell address={s.buyer_address} name={nameFor(s.buyer_address)} /></td>
                  <td style={TD}><WalletCell address={s.seller_address} name={nameFor(s.seller_address)} /></td>
                  <td style={{ ...TD, color: "var(--rpc-text-secondary)" }}>{relTime(s.sold_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!exhausted && (
        <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
          <button type="button" className="rpc-btn-ghost" disabled={loading} onClick={loadMore}>
            {loading ? "Loading…" : `Load ${pageSize} more`}
          </button>
        </div>
      )}
    </div>
  )
}
