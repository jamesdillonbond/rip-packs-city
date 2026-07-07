"use client"

// Held-time distribution card for the collection analytics page. Behavior-
// preserving verbatim extraction — fetches /api/wallet-hold-time and renders a
// bucketed bar chart. Self-contained (recharts + local fetch state only).
import { useEffect, useState } from "react"
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip,
} from "recharts"

export default function HeldTimeDistributionCard({ wallet, urlSlug }: { wallet: string; urlSlug: string }) {
  type HoldTimeResponse = {
    buckets?: Array<{ bucket: string; count: number }>
    total?: number
    reason?: string
  }
  const [resp, setResp] = useState<HoldTimeResponse | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/wallet-hold-time?wallet=${encodeURIComponent(wallet)}&collection=${encodeURIComponent(urlSlug)}`)
      .then(async (r) => {
        if (!r.ok) { setMissing(true); return null }
        return r.json()
      })
      .then((j) => { if (!cancelled && j) setResp(j as HoldTimeResponse) })
      .catch(() => { setMissing(true) })
    return () => { cancelled = true }
  }, [wallet, urlSlug])
  if (missing || !resp) return null
  if (resp.reason === "acquisition_data_unavailable") {
    return (
      <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
        <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
          Held Time Distribution
        </h2>
        <div className="text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
          Hold time tracking is Top Shot only today — coming to other collections as cost-basis backfill ships.
        </div>
      </section>
    )
  }
  const total = Number(resp.total ?? 0)
  const buckets = resp.buckets ?? []
  if (total === 0) return null
  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
        Held Time Distribution
      </h2>
      <div className="mb-2 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
        {total.toLocaleString()} moments tracked
      </div>
      <div className="h-56" style={{ fontFamily: "var(--font-mono)" }}>
        <ResponsiveContainer>
          <BarChart data={buckets}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="bucket" stroke="#71717a" tick={{ fontSize: 10 }} />
            <YAxis stroke="#71717a" tick={{ fontSize: 10 }} />
            <ReTooltip contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }} />
            <Bar dataKey="count" fill="var(--rpc-info)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
