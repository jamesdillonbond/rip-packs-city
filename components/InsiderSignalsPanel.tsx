"use client"

// components/InsiderSignalsPanel.tsx
//
// Per-collection insider-alert surface for /[collection]/overview. Fetches
// /api/insider-signals?collection=<kebab>&limit=8 which routes through the
// SECDEF get_insider_signals_top_n RPC. Cards render with severity-tinted
// dots, schonely-flavored empty state, and click through to the collection
// catalogue scoped to the involved player.
//
// Severity → token mapping (locked):
//   1 → var(--rpc-text-muted)
//   2 → var(--rpc-warning)
//   3 → var(--rpc-red)

import { useEffect, useState } from "react"
import Link from "next/link"
import { pickEmpty } from "@/lib/schonely"

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

function severityColor(s: number): string {
  if (s >= 3) return "var(--rpc-red)"
  if (s === 2) return "var(--rpc-warning)"
  return "var(--rpc-text-muted)"
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const min = Math.floor(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function evidencePlayer(ev: Record<string, unknown> | null): string | null {
  if (!ev) return null
  const v = ev["player_name"]
  return typeof v === "string" && v.trim() ? v : null
}

function evidenceSet(ev: Record<string, unknown> | null): string | null {
  if (!ev) return null
  const v = ev["set_name"]
  return typeof v === "string" && v.trim() ? v : null
}

function evidenceTier(ev: Record<string, unknown> | null): string | null {
  if (!ev) return null
  const v = ev["tier"]
  return typeof v === "string" && v.trim() ? v : null
}

export default function InsiderSignalsPanel({
  collection,
  basePath,
}: {
  // Kebab-case collection slug (e.g. "nba-top-shot"); matched against the
  // KEBAB_TO_DB_SLUG map inside /api/insider-signals.
  collection: string
  // The collection's nested route prefix (e.g. "/nba-top-shot") so the alert
  // click-through can route to {basePath}/collection?q=<player>.
  basePath: string
}) {
  const [alerts, setAlerts] = useState<InsiderAlert[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [emptyHook] = useState(() => pickEmpty())

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(
          `/api/insider-signals?collection=${encodeURIComponent(collection)}&limit=8`,
          { credentials: "include" }
        )
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || j.error) {
          setError(j.error ?? `HTTP ${res.status}`)
          return
        }
        setAlerts(Array.isArray(j.alerts) ? j.alerts : [])
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    load()
    // Cron fires hourly; refresh client-side every 5 min to catch new alerts
    // without hammering the API. Same cadence as the dashboard surface.
    const t = setInterval(load, 300_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [collection])

  return (
    <section
      className="rpc-card"
      style={{ padding: "16px 20px" }}
      aria-label="Insider signals"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-red)" }} />
        <span className="rpc-label" style={{ fontFamily: "var(--font-display)" }}>
          Insider Signals
        </span>
        {alerts && alerts.length > 0 && (
          <span
            className="rpc-mono"
            style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}
          >
            · {alerts.length} active
          </span>
        )}
        <span
          className="rpc-mono"
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-xs)",
            color: "var(--rpc-text-muted)",
            letterSpacing: "0.04em",
          }}
        >
          Anomalies in the last 24h
        </span>
      </div>

      {error ? (
        <div
          className="rpc-mono"
          style={{ color: "var(--rpc-danger)", fontSize: "var(--text-xs)", padding: "8px 0" }}
        >
          Couldn&rsquo;t load insider signals.
        </div>
      ) : alerts === null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1, 2, 3].map(i => (
            <div
              key={i}
              className="rpc-skeleton"
              style={{ width: "100%", height: 64, borderRadius: "var(--radius-sm)" }}
            />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div
          className="rpc-mono"
          style={{
            color: "var(--rpc-text-ghost)",
            padding: "20px 0",
            textAlign: "center",
            fontSize: "var(--text-sm)",
          }}
        >
          {emptyHook} No active insider signals — check back later.
        </div>
      ) : (
        <div
          className="rpc-insider-grid"
          style={{
            display: "grid",
            gap: 10,
          }}
        >
          {alerts.map(a => {
            const player = evidencePlayer(a.evidence_jsonb)
            const set = evidenceSet(a.evidence_jsonb)
            const tier = evidenceTier(a.evidence_jsonb)
            const sevColor = severityColor(a.severity)
            const href = player
              ? `${basePath}/collection?q=${encodeURIComponent(player)}`
              : `${basePath}/collection`

            return (
              <Link
                key={a.id}
                href={href}
                style={{
                  display: "block",
                  padding: "10px 12px",
                  background: "var(--rpc-surface-raised)",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: "var(--radius-sm)",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: sevColor,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "var(--text-sm)",
                      color: "var(--rpc-text-primary)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.title}
                  </span>
                  <span
                    className="rpc-mono"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--rpc-text-muted)",
                      marginLeft: "auto",
                    }}
                  >
                    {fmtRelative(a.generated_at)}
                  </span>
                </div>
                {a.summary ? (
                  <div
                    className="rpc-mono"
                    style={{
                      marginTop: 6,
                      fontSize: "var(--text-xs)",
                      color: "var(--rpc-text-secondary)",
                      lineHeight: 1.5,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {a.summary}
                  </div>
                ) : null}
                {(player || set || tier) && (
                  <div
                    className="rpc-mono"
                    style={{
                      marginTop: 6,
                      fontSize: "var(--text-xs)",
                      color: "var(--rpc-text-muted)",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {[player, set, tier].filter(Boolean).join(" · ")}
                  </div>
                )}
              </Link>
            )
          })}
        </div>
      )}

      <style jsx>{`
        :global(.rpc-insider-grid) {
          grid-auto-flow: column;
          grid-auto-columns: minmax(260px, 1fr);
          overflow-x: auto;
          scroll-snap-type: x mandatory;
          padding-bottom: 4px;
        }
        :global(.rpc-insider-grid > a) {
          scroll-snap-align: start;
        }
        @media (min-width: 768px) {
          :global(.rpc-insider-grid) {
            grid-auto-flow: row;
            grid-template-columns: repeat(2, 1fr);
            grid-auto-columns: unset;
            overflow-x: visible;
          }
        }
      `}</style>
    </section>
  )
}
