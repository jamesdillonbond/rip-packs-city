"use client"

// Wallet sales-history card for the collection analytics page. Behavior-
// preserving verbatim extraction — fetches /api/wallet-sales-history and renders
// a recent buy/sell table. Self-contained apart from shared format helpers.
import { useEffect, useState } from "react"
import { fmt, relativeDate } from "@/lib/analytics/format"

export default function SalesHistoryCard({ wallet, urlSlug }: { wallet: string; urlSlug: string }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/wallet-sales-history?wallet=${encodeURIComponent(wallet)}&collection=${encodeURIComponent(urlSlug)}&limit=10`)
      .then(async (r) => {
        if (!r.ok) { setMissing(true); return null }
        return r.json()
      })
      .then((j) => {
        if (cancelled || !j) return
        if (j.rows) setRows(j.rows)
        if (j.note) setNote(j.note)
      })
      .catch(() => { setMissing(true) })
    return () => { cancelled = true }
  }, [wallet, urlSlug])
  if (missing || (rows && rows.length === 0)) return null
  if (!rows) return null
  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
        Sales History
      </h2>
      {note && (
        <div className="mb-3 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
          {note}
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
        <thead>
          <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
            <th className="py-1.5 pr-2">Side</th>
            <th className="py-1.5 pr-2">Player</th>
            <th className="py-1.5 pr-2">Set</th>
            <th className="py-1.5 pr-2">Serial</th>
            <th className="py-1.5 pr-2 text-right">Price</th>
            <th className="py-1.5 pr-2">Marketplace</th>
            <th className="py-1.5 text-right">Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const isBuy = s.side === "buy"
            const sideColor = isBuy ? "var(--rpc-success)" : "var(--rpc-red)"
            return (
              <tr key={i} className="border-b border-[color:var(--rpc-border)]">
                <td className="py-1.5 pr-2 text-[10px] uppercase" style={{ color: sideColor }}>{s.side ?? "—"}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-primary)]">{s.player_name ?? "—"}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{s.set_name ?? "—"}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{s.serial_number ? `#${s.serial_number}` : "—"}</td>
                <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-primary)]">{fmt(Number(s.price_usd) || 0)}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{s.marketplace ?? "—"}</td>
                <td className="py-1.5 text-right text-[color:var(--rpc-text-muted)]">{s.sold_at ? relativeDate(s.sold_at) : "—"}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </section>
  )
}
