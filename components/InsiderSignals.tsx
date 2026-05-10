"use client"

// components/InsiderSignals.tsx
//
// Dashboard surface for non-expired topshot_insider_alerts. Severity 1=blue,
// 2=orange, 3=red. Title + summary always visible; click a row to expand the
// JSON evidence panel. Light client polling (3 min) keeps freshness without
// SSE plumbing.

import { useEffect, useState } from "react"

interface InsiderAlert {
  id: string
  alert_type: string
  title: string
  summary: string | null
  evidence_jsonb: Record<string, unknown> | null
  severity: number
  generated_at: string
  expires_at: string | null
}

function severityStyle(s: number): { bg: string; fg: string; label: string } {
  if (s >= 3) return { bg: "#7f1d1d", fg: "#fecaca", label: "High" }
  if (s === 2) return { bg: "#7c2d12", fg: "#fed7aa", label: "Medium" }
  return { bg: "#1e3a8a", fg: "#bfdbfe", label: "Low" }
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export default function InsiderSignals() {
  const [alerts, setAlerts] = useState<InsiderAlert[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch("/api/insider-signals", { credentials: "include" })
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || j.error) {
          setError(j.error ?? `HTTP ${res.status}`)
          return
        }
        setAlerts(j.alerts ?? [])
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    load()
    const t = setInterval(load, 180_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  if (alerts === null && !error) {
    return (
      <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 16 }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 8px", color: "#fafafa" }}>Insider signals</h2>
        <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: 0 }}>Loading…</p>
      </section>
    )
  }

  if (error) {
    return (
      <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 16 }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 8px", color: "#fafafa" }}>Insider signals</h2>
        <p style={{ color: "#fecaca", fontSize: 13, margin: 0 }}>Couldn't load: {error}</p>
      </section>
    )
  }

  return (
    <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 16 }}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 12px", color: "#fafafa", letterSpacing: "0.02em" }}>
        Insider signals
        {alerts && alerts.length > 0 && (
          <span style={{ marginLeft: 8, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>· {alerts.length}</span>
        )}
      </h2>

      {alerts && alerts.length === 0 && (
        <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: 0 }}>No active signals.</p>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {(alerts ?? []).map(a => {
          const isOpen = expanded.has(a.id)
          const sev = severityStyle(a.severity)
          return (
            <li key={a.id} style={{ background: "#0a0a0a", border: "1px solid #27272a", borderRadius: 8, padding: 12 }}>
              <button
                onClick={() => {
                  const next = new Set(expanded)
                  if (next.has(a.id)) next.delete(a.id)
                  else next.add(a.id)
                  setExpanded(next)
                }}
                style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", textAlign: "left", width: "100%", color: "#fafafa" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ background: sev.bg, color: sev.fg, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{sev.label}</span>
                  <span style={{ background: "#27272a", color: "rgba(255,255,255,0.65)", padding: "2px 8px", borderRadius: 999, fontSize: 11 }}>{a.alert_type}</span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>{formatRelative(a.generated_at)}</span>
                </div>
                <div style={{ fontWeight: 600, margin: "8px 0 4px", fontSize: 14 }}>{a.title}</div>
                {a.summary && (
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", lineHeight: 1.5 }}>{a.summary}</div>
                )}
              </button>
              {isOpen && a.evidence_jsonb && (
                <pre style={{ marginTop: 8, background: "#000", color: "#a7f3d0", border: "1px solid #27272a", borderRadius: 6, padding: 8, fontSize: 11, lineHeight: 1.4, overflowX: "auto" }}>
                  {JSON.stringify(a.evidence_jsonb, null, 2)}
                </pre>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
