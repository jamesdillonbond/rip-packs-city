// PaniniSalesChart — every sale on record for one Panini edition, price over time
// (edition page Sales section, 2026-09-28). Server-rendered SVG, no client JS: a
// <title> on each point is its tooltip, and the table beneath the chart is its
// table view.
//
// Honesty: when the edition's history is complete only SINCE a moment (a gap, or a
// Recent list that did not reach its first sale), the span before that moment is
// shaded and labelled partial, so missing sales never read as a quiet period. A log
// scale is used when prices span more than 20x, and the axis says so.

import type { PaniniEditionSale, PaniniSalesCoverage } from "@/lib/panini/edition-market"

const W = 640
const H = 180
const PAD = { l: 52, r: 12, t: 12, b: 26 }

function usdTick(n: number): string {
  if (n >= 1000) return "$" + Math.round(n / 100) / 10 + "k"
  return "$" + (n >= 10 ? Math.round(n) : Math.round(n * 100) / 100)
}
function ptDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "America/Los_Angeles" })
}

export default function PaniniSalesChart({ sales, coverage }: { sales: PaniniEditionSale[]; coverage: PaniniSalesCoverage | null }) {
  const pts = sales
    .map((s) => ({ t: Date.parse(s.soldAt), v: s.amountUsd, s }))
    .filter((p) => Number.isFinite(p.t) && p.v > 0)
  if (pts.length < 2) return null

  const t0 = Math.min(...pts.map((p) => p.t))
  const t1 = Math.max(...pts.map((p) => p.t))
  const vMin = Math.min(...pts.map((p) => p.v))
  const vMax = Math.max(...pts.map((p) => p.v))
  const log = vMax / vMin > 20
  const f = (v: number) => (log ? Math.log10(v) : v)
  const y0 = log ? f(vMin) : 0
  const yRange = f(vMax) - y0
  const span = t1 - t0
  // A zero span (every sale at one instant) or a flat price centres the dots — never a
  // made-up divisor.
  const x = (t: number) => (span > 0 ? PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r) : (PAD.l + W - PAD.r) / 2)
  const y = (v: number) => (yRange > 0 ? H - PAD.b - ((f(v) - y0) / yRange) * (H - PAD.t - PAD.b) : (PAD.t + H - PAD.b) / 2)
  const ticks = log
    ? [vMin, Math.sqrt(vMin * vMax), vMax]
    : [0, vMax / 2, vMax]

  const since = coverage?.kind === "since" ? Date.parse(coverage.since) : NaN
  const shadeTo = Number.isFinite(since) && since > t0 ? x(Math.min(since, t1)) : null

  return (
    <figure style={{ margin: "0 0 12px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${pts.length} sales on record, ${ptDate(t0)} to ${ptDate(t1)}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {shadeTo != null && (
          <g>
            <rect x={PAD.l} y={PAD.t} width={Math.max(0, shadeTo - PAD.l)} height={H - PAD.t - PAD.b} fill="var(--rpc-surface)" />
            <text x={PAD.l + 4} y={PAD.t + 12} fontSize={10} fontFamily="var(--font-mono)" fill="var(--rpc-text-muted)">partial before {ptDate(since)}</text>
          </g>
        )}
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(Math.max(v, log ? vMin : 0))} y2={y(Math.max(v, log ? vMin : 0))} stroke="var(--rpc-border)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(Math.max(v, log ? vMin : 0)) + 3} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--rpc-text-muted)">{usdTick(v)}</text>
          </g>
        ))}
        <text x={PAD.l} y={H - 8} fontSize={10} fontFamily="var(--font-mono)" fill="var(--rpc-text-muted)">{ptDate(t0)}</text>
        <text x={W - PAD.r} y={H - 8} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--rpc-text-muted)">{ptDate(t1)}</text>
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r={4} fill="var(--rpc-red)" stroke="var(--rpc-bg, var(--rpc-black))" strokeWidth={2}>
            <title>{`${usdTick(p.v)} · ${ptDate(p.t)}${p.s.serial != null ? ` · #${p.s.serial}${p.s.mintCap != null ? `/${p.s.mintCap}` : ""}` : ""}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 2 }}>
        Each dot is one sale on record{log ? " · price axis is logarithmic" : ""}. Hover a dot for the price, date (PT) and serial.
      </figcaption>
    </figure>
  )
}
