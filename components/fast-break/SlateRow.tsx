"use client"
// components/fast-break/SlateRow.tsx
//
// Tonight's NBA slate — horizontal scrolling row on mobile, inline on desktop.
// Tipoff time is converted from the source ISO to the user's local time zone
// after mount; SSR shows ET so the layout doesn't shift catastrophically when
// the locale resolves on the client.

import { useEffect, useState } from "react"

interface SlateGame {
  gameId: string
  homeTeam: string
  awayTeam: string
  tipoffAt: string | null
  status: string
}

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 12,
  overflowX: "auto",
  paddingBottom: 6,
  marginBottom: 24,
  scrollbarWidth: "thin",
}

const CARD_STYLE: React.CSSProperties = {
  flex: "0 0 200px",
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-md)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 8,
}

const TEAM_LINE_STYLE: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 800,
  fontSize: 18,
  letterSpacing: "0.06em",
  color: "var(--rpc-text-primary)",
  textTransform: "uppercase",
}

const META_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.12em",
  color: "var(--rpc-text-secondary)",
  textTransform: "uppercase",
}

const BADGE_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  borderRadius: 999,
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  width: "fit-content",
}

function formatLocal(iso: string | null): string {
  if (!iso) return "TBD"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "TBD"
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms))
}

function formatET(iso: string | null): string {
  if (!iso) return "TBD"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "TBD"
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms)) + " ET"
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  if (s === "live") {
    return (
      <span style={{ ...BADGE_BASE, background: "rgba(224,58,47,0.16)", color: "var(--rpc-red)", border: "1px solid var(--rpc-red-border)" }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--rpc-red)",
            animation: "rpcPulse 1.4s ease-in-out infinite",
          }}
        />
        Live
      </span>
    )
  }
  if (s === "final") {
    return (
      <span style={{ ...BADGE_BASE, background: "rgba(255,255,255,0.05)", color: "var(--rpc-text-muted)", border: "1px solid var(--rpc-border)" }}>
        Final
      </span>
    )
  }
  return (
    <span style={{ ...BADGE_BASE, background: "rgba(255,255,255,0.04)", color: "var(--rpc-text-secondary)", border: "1px solid var(--rpc-border)" }}>
      Scheduled
    </span>
  )
}

export default function SlateRow({ games, gameDate }: { games: SlateGame[]; gameDate: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  if (!games.length) {
    return (
      <div style={{ ...CARD_STYLE, marginBottom: 24, alignItems: "flex-start" }}>
        <div style={TEAM_LINE_STYLE}>No games tonight</div>
        <div style={META_STYLE}>{gameDate} · slate empty</div>
      </div>
    )
  }

  return (
    <>
      <style>{`@keyframes rpcPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
      <div style={ROW_STYLE} aria-label="Tonight's NBA slate">
        {games.map(g => {
          const time = mounted ? formatLocal(g.tipoffAt) : formatET(g.tipoffAt)
          const tzNote = mounted ? "local" : "ET"
          return (
            <div key={g.gameId} style={CARD_STYLE}>
              <div style={TEAM_LINE_STYLE}>
                {g.awayTeam} <span style={{ color: "var(--rpc-text-muted)", fontWeight: 500 }}>@</span> {g.homeTeam}
              </div>
              <div style={META_STYLE}>{time} · {tzNote}</div>
              <StatusBadge status={g.status} />
            </div>
          )
        })}
      </div>
    </>
  )
}
