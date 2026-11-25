"use client"

// components/dashboard/ValueHistoryCard.tsx
//
// "Value / 30D" on /dashboard: the member's nightly portfolio snapshots — moments FMV and
// sealed packs at the capped lowest live ask.
//
// 2026-11-22 ~3:00 PM PT (Trevor: "Show as a stacked chart, so users can still visualize the
// total over time"): a STACKED AREA — moments on the bottom, sealed packs on top — so the top
// edge is the total, matching the single Portfolio FMV figure above. Supersedes the morning's
// two-separate-lines design.
//
// ⚠ Sealed packs were first recorded live on 2026-11-22; the 30 nights before were BACKFILLED
// from ask history the same day (Trevor: "backfilled fmv data") and carry packs_estimated —
// the tooltip marks them "est.". A night with no pack value at all stays null (NOT $0); if the
// pack series still begins inside the window, a muted note names the start date so the
// step on that night does not read as a gain.
//
// States: loading · couldn't load (never an empty chart that reads as "no history") ·
// no snapshots yet · the chart. Dates are YYYY-MM-DD strings formatted by hand — no
// Date/locale call during render (React #418 class).

import { useEffect, useState } from "react"
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

type Point = { date: string; moments_usd: number | null; packs_usd: number | null; packs_held: number | null; packs_estimated?: boolean }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-")
  const mi = Number(m) - 1
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(d)}` : iso
}
export function fmtAxisUsd(v: number): string {
  return v >= 1000 ? "$" + (v / 1000).toFixed(1) + "K" : "$" + v.toFixed(0)
}
function fmtUsd2(v: number): string {
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** The first night carrying a pack value, when that is NOT the window's first night (else null). */
export function packSeriesStart(points: Point[]): string | null {
  const i = points.findIndex((p) => p.packs_usd != null)
  return i > 0 ? points[i].date : null
}

/** A night's total: the sum of the parts it HAS. Null when neither part was recorded. */
export function nightTotal(p: Pick<Point, "moments_usd" | "packs_usd">): number | null {
  if (p.moments_usd == null && p.packs_usd == null) return null
  return (p.moments_usd ?? 0) + (p.packs_usd ?? 0)
}

/** The tooltip's label for nightTotal: a night missing one part says which part the figure is (2026-11-24). */
export function totalLabel(p: Pick<Point, "moments_usd" | "packs_usd">): string {
  if (p.moments_usd != null && p.packs_usd == null) return "Total (moments only)"
  if (p.moments_usd == null && p.packs_usd != null) return "Total (packs only)"
  return "Total"
}

const mono = "var(--font-mono, monospace)"
const PACK_COLOR = "#F59E0B"

type TipEntry = { dataKey?: unknown; value?: unknown; payload?: Point }
function StackTooltip({ active, payload, label }: { active?: boolean; payload?: TipEntry[]; label?: unknown }) {
  if (!active || !payload || payload.length === 0) return null
  const p = payload[0]?.payload
  if (!p) return null
  const total = nightTotal(p)
  const row = (name: string, v: number | null, strong = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontWeight: strong ? 700 : 400 }}>
      <span>{name}</span>
      <span>{v == null ? "—" : fmtUsd2(v)}</span>
    </div>
  )
  return (
    <div style={{ background: "rgba(0,0,0,0.92)", border: "1px solid rgba(224,58,47,0.4)", borderRadius: 6, fontSize: 11, fontFamily: mono, color: "#e4e4e7", padding: "6px 8px" }}>
      <div style={{ marginBottom: 4 }}>{fmtDay(String(label ?? p.date))}</div>
      {row(totalLabel(p), total, true)}
      {row("Moments", p.moments_usd)}
      {row(p.packs_estimated ? "Sealed packs (est.)" : "Sealed packs", p.packs_usd)}
    </div>
  )
}

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

  // A member who holds no sealed packs has a true $0 every night; that is not a band worth drawing.
  const hasPacks = (points ?? []).some((p) => p.packs_usd != null && p.packs_usd > 0)
  const packsFrom = hasPacks && points ? packSeriesStart(points) : null
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
          <>
            <div style={{ width: "100%", height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 6, right: 10, bottom: 4, left: -10 }}>
                  <CartesianGrid stroke="var(--rpc-border-subtle)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fill: "var(--rpc-text-muted)", fontSize: 9, fontFamily: mono }}
                    axisLine={{ stroke: "var(--rpc-border)" }} tickLine={false} minTickGap={24} />
                  <YAxis tickFormatter={fmtAxisUsd} tick={{ fill: "var(--rpc-text-muted)", fontSize: 9, fontFamily: mono }}
                    axisLine={{ stroke: "var(--rpc-border)" }} tickLine={false} width={50} />
                  <Tooltip content={<StackTooltip />} />
                  {hasPacks ? <Legend wrapperStyle={{ fontSize: 10, fontFamily: mono }} /> : null}
                  <Area type="monotone" stackId="value" dataKey="moments_usd" name="Moments"
                    stroke="var(--rpc-red, #E03A2F)" fill="var(--rpc-red, #E03A2F)" fillOpacity={0.35} strokeWidth={2}
                    dot={false} connectNulls={false} isAnimationActive={false} />
                  {hasPacks ? (
                    <Area type="monotone" stackId="value" dataKey="packs_usd" name="Sealed packs"
                      stroke={PACK_COLOR} fill={PACK_COLOR} fillOpacity={0.35} strokeWidth={2}
                      dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
                  ) : null}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {packsFrom ? (
              <div style={{ marginTop: 6, fontSize: 9, fontFamily: mono, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
                Sealed packs tracked from {fmtDay(packsFrom)}
              </div>
            ) : null}
          </>
        )}
    </section>
  )
}
