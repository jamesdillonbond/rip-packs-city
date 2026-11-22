"use client"

// components/dashboard/ValueHistoryCard.tsx
//
// "Value / 30D" on /dashboard (Trevor, 2026-11-22: "Both"): the member's nightly portfolio
// snapshots — moments FMV and, as its own line, sealed packs at the capped lowest live ask
// (recorded from 2026-11-22, so that line starts short and fills in). Two lines, never one
// sum: the pack line is a different kind of number (an ask, not a fair-market value).
//
// States: loading · couldn't load (never an empty chart that reads as "no history") ·
// no snapshots yet · the chart. Dates are YYYY-MM-DD strings formatted by hand — no
// Date/locale call during render (React #418 class).
//
// ⚠ The moments line is the snapshot's total_fmv, which INCLUDES stale-priced moments;
// the Portfolio FMV tile above excludes them (it shows them as a caption). The legend says
// so, so a chart sitting ~$5k above the tile does not read as a contradiction.

import { useEffect, useState } from "react"
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

type Point = { date: string; moments_usd: number | null; packs_usd: number | null; packs_held: number | null }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-")
  const mi = Number(m) - 1
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(d)}` : iso
}
export function fmtAxisUsd(v: number): string {
  return v >= 1000 ? "$" + (v / 1000).toFixed(1) + "K" : "$" + v.toFixed(0)
}

const mono = "var(--font-mono, monospace)"

export default function ValueHistoryCard() {
  const [points, setPoints] = useState<Point[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    fetch("/api/profile/value-history", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
      .then((d) => {
        if (!alive) return
        setPoints(Array.isArray(d?.history) ? d.history : [])
        setFailed(false)
      })
      .catch(() => {
        if (!alive) return
        setPoints(null)
        setFailed(true)
      })
    return () => { alive = false }
  }, [])

  const hasPacks = (points ?? []).some((p) => p.packs_usd != null)
  const box = { background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, padding: "12px 16px" } as const
  const msg = (t: string) => (
    <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-muted)", fontFamily: mono, fontSize: 11, textAlign: "center" }}>{t}</div>
  )

  return (
    <section style={box} aria-label="Portfolio value, last 30 days">
      <div style={{ fontSize: 9, fontFamily: mono, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>
        Value / 30D · nightly snapshot
      </div>
      {failed ? msg("Couldn't load your value history just now.")
        : points == null ? msg("Loading…")
        : points.length === 0 ? msg("No snapshots yet — your first is taken tonight.")
        : (
          <div style={{ width: "100%", height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 6, right: 10, bottom: 4, left: -10 }}>
                <CartesianGrid stroke="var(--rpc-border-subtle)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fill: "var(--rpc-text-muted)", fontSize: 9, fontFamily: mono }}
                  axisLine={{ stroke: "var(--rpc-border)" }} tickLine={false} minTickGap={24} />
                <YAxis tickFormatter={fmtAxisUsd} tick={{ fill: "var(--rpc-text-muted)", fontSize: 9, fontFamily: mono }}
                  axisLine={{ stroke: "var(--rpc-border)" }} tickLine={false} width={50} />
                <Tooltip
                  contentStyle={{ background: "rgba(0,0,0,0.92)", border: "1px solid rgba(224,58,47,0.4)", borderRadius: 6, fontSize: 11, fontFamily: mono }}
                  labelStyle={{ color: "#e4e4e7" }}
                  labelFormatter={(v: unknown) => fmtDay(String(v ?? ""))}
                  formatter={(v: unknown, name: unknown): [string, string] => [
                    v == null || !Number.isFinite(Number(v)) ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                    String(name ?? ""),
                  ]}
                />
                {hasPacks ? <Legend wrapperStyle={{ fontSize: 10, fontFamily: mono }} /> : null}
                <Line type="monotone" dataKey="moments_usd" name="Moments (FMV, incl. stale-priced)" stroke="var(--rpc-red, #E03A2F)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                {hasPacks ? (
                  <Line type="monotone" dataKey="packs_usd" name="Sealed packs (low ask)" stroke="#F59E0B" strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
    </section>
  )
}
