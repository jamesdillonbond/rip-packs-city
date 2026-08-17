"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { PipelineHealthResponse, PipelineHealthRow } from "@/lib/analytics-types"

const PIPELINE_LABELS: Record<keyof PipelineHealthResponse["pipelines"], string> = {
  loans: "Loans",
  sales: "Sales",
  fmv: "FMV",
  pack_ev: "Pack EV",
  listings: "Listings",
}

const PIPELINE_ORDER: Array<keyof PipelineHealthResponse["pipelines"]> = [
  "loans",
  "sales",
  "fmv",
  "pack_ev",
  "listings",
]

/**
 * ⚠ `unknown` is NOT a shade of healthy. Both of these functions fall through to
 * GREEN, which is right for "healthy" and wrong for "we have no idea" — and this
 * badge's whole job is to say when something is broken, so defaulting an absent
 * answer to green is the one direction it must never fail in. The unknown branch
 * is deliberately NEUTRAL rather than red: a failed read is not an outage, and
 * painting it red would cry wolf on the reader's own connection.
 */
function statusColor(status: string): { dot: string; ring: string; text: string } {
  if (status === "stale") {
    return { dot: "bg-rose-400", ring: "ring-rose-400/30", text: "text-rose-300" }
  }
  if (status === "degraded") {
    return { dot: "bg-amber-400", ring: "ring-amber-400/30", text: "text-amber-300" }
  }
  if (status === "unknown") {
    return {
      dot: "bg-[color:var(--rpc-text-muted)]",
      ring: "ring-[color:var(--rpc-border)]",
      text: "text-[color:var(--rpc-text-muted)]",
    }
  }
  return { dot: "bg-emerald-400", ring: "ring-emerald-400/30", text: "text-emerald-300" }
}

function statusBadgeClass(status: string): string {
  if (status === "stale") {
    return "border-rose-500/30 bg-rose-500/10 text-rose-300"
  }
  if (status === "degraded") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-300"
  }
  if (status === "unknown") {
    return "border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] text-[color:var(--rpc-text-muted)]"
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
}

function fmtLag(min: number): string {
  if (!Number.isFinite(min)) return "—"
  if (min < 1) return "<1m"
  if (min < 60) return `${Math.round(min)}m`
  const hr = min / 60
  if (hr < 24) return `${hr.toFixed(1)}h`
  return `${(hr / 24).toFixed(1)}d`
}

export default function PipelineHealthBadge() {
  const [data, setData] = useState<PipelineHealthResponse | null>(null)
  // ⚠ Did a load attempt SETTLE? Without this, "no data" conflates "the first
  // request is still in flight" with "the request finished and we got nothing",
  // and the badge sits on "Loading status…" forever — a caption that is false
  // the moment the fetch resolves, and stays false through every 60s retry.
  const [attempted, setAttempted] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch("/api/analytics/health", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (cancelled) return
          setAttempted(true)
          if (j && (j as PipelineHealthResponse).pipelines) {
            setData(j as PipelineHealthResponse)
          }
        })
        .catch(() => {
          // Soft-fail the RENDER, not the FACT: the badge must not disappear or
          // throw, but it also must not keep claiming to be loading.
          if (!cancelled) setAttempted(true)
        })
    }
    load()
    const id = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Click-outside to close
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [open])

  const summary = useMemo(() => {
    // ⚠ NEVER `status: "healthy"` HERE. This branch is reached when we have no
    // data at all — before the first response, and after any failed one — and
    // hardcoding "healthy" painted a GREEN dot on a live ops badge that had just
    // failed to read the pipeline status. A monitor that reports health it has
    // not measured is worse than no monitor: the reader stops checking.
    if (!data) {
      return attempted
        ? { caption: "Status unavailable", status: "unknown" as const }
        : { caption: "Loading status…", status: "unknown" as const }
    }
    const pipelines = data.pipelines
    const status = data.overall_status
    if (status === "healthy") {
      return { caption: "All systems healthy", status }
    }
    const counts = { degraded: 0, stale: 0 }
    for (const key of PIPELINE_ORDER) {
      const row = pipelines[key]
      if (!row) continue
      if (row.status === "stale") counts.stale++
      else if (row.status === "degraded") counts.degraded++
    }
    if (status === "stale") {
      const n = counts.stale
      return { caption: `${n} pipeline${n === 1 ? "" : "s"} stale`, status }
    }
    const n = counts.degraded
    return { caption: `${n} pipeline${n === 1 ? "" : "s"} lagging`, status }
  }, [data, attempted])

  const colors = statusColor(summary.status)

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] px-2.5 py-1.5 text-xs hover:border-[color:var(--rpc-border-hover)] transition-colors"
        aria-expanded={open}
        aria-label="Pipeline health"
      >
        <span className="relative inline-flex">
          <span className={`h-2 w-2 rounded-full ${colors.dot}`} />
          {summary.status === "stale" || summary.status === "degraded" ? (
            <span
              className={`absolute inset-0 inline-flex animate-ping rounded-full opacity-60 ${colors.dot}`}
            />
          ) : null}
        </span>
        <span className={`text-[11px] ${colors.text}`}>{summary.caption}</span>
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] backdrop-blur shadow-xl shadow-black/50 p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-[color:var(--rpc-text-primary)]">Pipeline status</h4>
            {data?.as_of ? (
              <span className="text-[10px] text-[color:var(--rpc-text-muted)]">
                {new Date(data.as_of).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
          {!data ? (
            <div className="py-3 text-xs text-[color:var(--rpc-text-muted)]">
              {attempted
                ? "Couldn't load pipeline status — this says nothing about the pipelines, only that the read failed."
                : "Loading…"}
            </div>
          ) : (
            <ul className="space-y-2">
              {PIPELINE_ORDER.map((key) => {
                const row: PipelineHealthRow | undefined = data.pipelines[key]
                if (!row) return null
                const c = statusColor(row.status)
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--rpc-border-subtle)] bg-[color:var(--rpc-surface-raised)] px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`h-2 w-2 rounded-full flex-shrink-0 ${c.dot} ring-2 ${c.ring}`}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[color:var(--rpc-text-primary)]">
                          {PIPELINE_LABELS[key]}
                        </div>
                        <div className="text-[10px] text-[color:var(--rpc-text-muted)]">{row.cadence}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="text-right">
                        <div className="text-xs tabular-nums text-[color:var(--rpc-text-primary)]">
                          {fmtLag(row.lag_minutes)}
                        </div>
                        <div className="text-[10px] text-[color:var(--rpc-text-muted)]">
                          ≤{fmtLag(row.expected_max_lag_min)}
                        </div>
                      </div>
                      <span
                        className={
                          "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
                          statusBadgeClass(row.status)
                        }
                      >
                        {row.status}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
