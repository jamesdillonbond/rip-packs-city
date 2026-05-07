"use client"

// InsiderSignals — composes alerts, recent buybacks, and external
// announcements into a single panel at the top of /analytics. The component
// is self-gating: when the route returns has_data=false it returns null and
// renders nothing. The panel only appears when there's signal worth showing.

import { useEffect, useState } from "react"
import { ShieldAlert, ExternalLink } from "lucide-react"
import type { InsiderSignalsResponse } from "@/lib/analytics-types"

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

function severityColor(severity: number | null): string {
  if (severity === 3) return "var(--rpc-danger)"
  if (severity === 2) return "var(--rpc-warning)"
  return "var(--rpc-info)"
}

export default function InsiderSignals() {
  const [resp, setResp] = useState<InsiderSignalsResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/analytics/insider/signals")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setResp(j as InsiderSignalsResponse) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!resp || !resp.has_data) return null

  const { alerts, buybacks, announcements } = resp

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert size={16} className="text-emerald-400" />
        <h2 className="text-lg font-semibold text-slate-100">Insider Signals</h2>
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-amber-300 border border-amber-500/30">
          BETA
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {/* Alerts */}
        <div>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Alerts
          </h3>
          {alerts.length === 0 ? (
            <p className="text-[12px] text-slate-500">No active alerts.</p>
          ) : (
            <ul className="space-y-2">
              {alerts.map((a) => (
                <li key={a.id} className="rounded border border-slate-800 bg-slate-950 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: severityColor(a.severity) }}
                      aria-hidden
                    />
                    <span className="text-sm font-semibold text-slate-100 truncate">
                      {a.title ?? "Insider alert"}
                    </span>
                  </div>
                  {a.summary ? (
                    <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">{a.summary}</p>
                  ) : null}
                  <div className="mt-1 text-[10px] text-slate-500">{fmtRelative(a.generated_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent Buybacks */}
        <div>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            Recent Buybacks
          </h3>
          {buybacks.length === 0 ? (
            <p className="text-[12px] text-slate-500">No recent buybacks detected.</p>
          ) : (
            <ul className="space-y-2">
              {buybacks.map((b) => (
                <li key={b.id} className="rounded border border-slate-800 bg-slate-950 p-2.5">
                  <div className="text-sm font-semibold text-slate-100">Insider buyback detected</div>
                  <div className="mt-1 truncate text-[11px] text-slate-400">
                    {b.player_name ?? "Unknown moment"}
                    {b.set_name ? <span className="text-slate-500"> · {b.set_name}</span> : null}
                    {b.serial_number ? <span className="text-slate-500"> · #{b.serial_number}</span> : null}
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[12px] font-bold text-white tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                      {fmtUsd(b.price_usd)}
                    </span>
                    <span className="text-[10px] text-slate-500">{fmtRelative(b.sold_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* External Announcements */}
        <div>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            External Announcements
          </h3>
          {announcements.length === 0 ? (
            <p className="text-[12px] text-slate-500">No recent announcements.</p>
          ) : (
            <ul className="space-y-2">
              {announcements.map((a) => (
                <li key={a.id} className="rounded border border-slate-800 bg-slate-950 p-2.5">
                  <div className="flex items-center gap-1.5">
                    {a.source ? (
                      <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-slate-300">
                        {a.source}
                      </span>
                    ) : null}
                    <span className="text-sm font-semibold text-slate-100 truncate">
                      {a.title ?? "Announcement"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[10px] text-slate-500">{fmtRelative(a.posted_at)}</span>
                    {a.source_url ? (
                      <a
                        href={a.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300"
                      >
                        Open <ExternalLink size={10} />
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
