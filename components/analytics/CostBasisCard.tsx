"use client"

// Cost-basis & P&L card for the collection analytics page. Behavior-preserving
// verbatim extraction — fetches /api/wallet-cost-basis and renders summary KPIs
// plus top gainers/losers. Self-contained apart from the shared `fmt` helper.
import { useEffect, useState } from "react"
import { fmt } from "@/lib/analytics/format"

export default function CostBasisCard({ wallet, urlSlug }: { wallet: string; urlSlug: string }) {
  type Mover = {
    player_name: string | null
    set_name: string | null
    tier: string | null
    serial_number: number | null
    buy_price: number
    current_fmv: number
    pnl_pct: number
  }
  type CostBasisResponse = {
    summary?: {
      tracked_count: number
      total_cost_basis: number
      total_current_fmv: number
      total_pnl_usd: number
      total_pnl_pct: number
      win_count: number
      loss_count: number
    }
    top_movers?: { gainers: Mover[]; losers: Mover[] }
    sample_size_note?: string
    reason?: string
  }
  const [resp, setResp] = useState<CostBasisResponse | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/wallet-cost-basis?wallet=${encodeURIComponent(wallet)}&collection=${encodeURIComponent(urlSlug)}`)
      .then(async (r) => {
        if (!r.ok) { setMissing(true); return null }
        return r.json()
      })
      .then((j) => { if (!cancelled && j) setResp(j as CostBasisResponse) })
      .catch(() => { setMissing(true) })
    return () => { cancelled = true }
  }, [wallet, urlSlug])
  if (missing || !resp || resp.reason) return null
  const s = resp.summary
  if (!s || s.tracked_count === 0) return null
  const pnlColor = s.total_pnl_usd >= 0 ? "var(--rpc-success)" : "var(--rpc-danger)"
  const winDenom = s.win_count + s.loss_count
  const gainers = resp.top_movers?.gainers ?? []
  const losers = resp.top_movers?.losers ?? []
  const renderMover = (m: Mover, kind: "gain" | "loss") => {
    const color = kind === "gain" ? "var(--rpc-success)" : "var(--rpc-danger)"
    const sign = m.pnl_pct >= 0 ? "+" : ""
    return (
      <li key={`${kind}-${m.player_name}-${m.serial_number}-${m.pnl_pct}`} className="flex items-center justify-between gap-2 py-1">
        <span className="truncate text-[color:var(--rpc-text-primary)]">
          {m.player_name ?? "—"}
          {m.serial_number ? <span className="text-[color:var(--rpc-text-muted)]"> #{m.serial_number}</span> : null}
          <span className="block text-[10px] text-[color:var(--rpc-text-muted)]">{m.set_name ?? "—"}</span>
        </span>
        <span className="shrink-0 text-[11px]" style={{ color, fontFamily: "var(--font-mono)" }}>
          {sign}{m.pnl_pct.toFixed(1)}%
        </span>
      </li>
    )
  }
  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="mb-3 text-[11px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Cost Basis &amp; P&amp;L</div>
      {resp.sample_size_note && (
        <div className="mb-2 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
          {resp.sample_size_note}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" style={{ fontFamily: "var(--font-mono)" }}>
        <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Tracked</div>
          <div className="text-2xl font-black text-[color:var(--rpc-text-primary)]">{s.tracked_count.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Cost Basis</div>
          <div className="text-2xl font-black text-[color:var(--rpc-text-primary)]">{fmt(s.total_cost_basis)}</div>
        </div>
        <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Current FMV</div>
          <div className="text-2xl font-black text-[color:var(--rpc-text-primary)]">{fmt(s.total_current_fmv)}</div>
        </div>
        <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Total P&amp;L</div>
          <div className="text-2xl font-black" style={{ color: pnlColor }}>
            {s.total_pnl_usd >= 0 ? "+" : ""}{fmt(s.total_pnl_usd)}
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: pnlColor }}>
            {s.total_pnl_pct >= 0 ? "+" : ""}{s.total_pnl_pct.toFixed(1)}%
          </div>
        </div>
      </div>
      {winDenom > 0 && (
        <div className="mt-2 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
          Win rate: {s.win_count.toLocaleString()} of {winDenom.toLocaleString()}
        </div>
      )}
      {(gainers.length > 0 || losers.length > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
            <div className="mb-2 text-[10px] uppercase tracking-widest" style={{ color: "var(--rpc-success)" }}>Top Gainers</div>
            {gainers.length === 0 ? (
              <div className="text-[11px] text-[color:var(--rpc-text-muted)]">No tracked gainers.</div>
            ) : (
              <ul className="text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
                {gainers.map((m) => renderMover(m, "gain"))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
            <div className="mb-2 text-[10px] uppercase tracking-widest" style={{ color: "var(--rpc-danger)" }}>Top Losers</div>
            {losers.length === 0 ? (
              <div className="text-[11px] text-[color:var(--rpc-text-muted)]">No tracked losers.</div>
            ) : (
              <ul className="text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
                {losers.map((m) => renderMover(m, "loss"))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
