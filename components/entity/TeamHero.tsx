// components/entity/TeamHero.tsx
// Team Hub Phase 1 (C1). Branded hero for /[collection]/team/[slug].
// Server component (no "use client"); the only interactive bit — the logo's
// onError fallback — is delegated to the TeamLogo client island.
//
// When the team is present in teams_master (primaryColor set), renders a
// team-colored banner with the official logo (NBA CDN, else initials), the
// team name, and abbreviation + league chips. When it is not (NFL/Golazos
// teams not yet in teams_master, or Pinnacle franchises), it falls back to the
// original plain-text hero markup so nothing regresses.
//
// Team colors arrive as data props (team identity, not RPC brand) — this is the
// one sanctioned place to use non-token colors. Everything else uses var(--rpc-*).

import type { CSSProperties } from "react"
import TeamLogo from "./TeamLogo"

interface TeamHeroProps {
  teamName: string
  noun: string
  abbreviation?: string | null
  primaryColor?: string | null
  secondaryColor?: string | null
  leagueLabel?: string | null
  externalId?: string | null
  isFranchise: boolean
}

const H1_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 32,
  letterSpacing: "0.04em",
  lineHeight: 1.05,
  textTransform: "uppercase",
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="rpc-mono"
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "#fff",
        background: "rgba(0,0,0,0.30)",
        border: "1px solid rgba(255,255,255,0.25)",
      }}
    >
      {children}
    </span>
  )
}

export default function TeamHero({
  teamName,
  noun,
  abbreviation,
  primaryColor,
  secondaryColor,
  leagueLabel,
  externalId,
  isFranchise,
}: TeamHeroProps) {
  // ── Fallback: plain-text hero (unbranded teams / franchises) ──────────────
  if (!primaryColor) {
    return (
      <section className="rpc-card" style={{ padding: 18 }}>
        <div
          className="rpc-mono"
          style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 8 }}
        >
          {noun}
        </div>
        <h1 style={{ ...H1_STYLE, color: "var(--rpc-text-primary)" }}>{teamName}</h1>
      </section>
    )
  }

  // ── Branded banner ────────────────────────────────────────────────────────
  const isNba = (leagueLabel ?? "").toUpperCase() === "NBA"
  const logoUrl = externalId && isNba ? `https://cdn.nba.com/logos/nba/${externalId}/global/L/logo.svg` : null
  const accent = secondaryColor || "var(--rpc-red)"
  const gradient = `linear-gradient(105deg, ${primaryColor} 0%, var(--rpc-surface) 88%)`

  return (
    <section className="rpc-card" style={{ padding: 0, overflow: "hidden", borderTop: `3px solid ${accent}` }}>
      <div style={{ background: gradient, padding: 18, display: "flex", gap: 16, alignItems: "center" }}>
        <TeamLogo logoUrl={logoUrl} abbreviation={abbreviation ?? null} secondaryColor={secondaryColor ?? null} />
        <div style={{ minWidth: 0 }}>
          <div
            className="rpc-mono"
            style={{ fontSize: 10, color: "rgba(255,255,255,0.78)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 8 }}
          >
            {noun}
          </div>
          <h1 style={{ ...H1_STYLE, color: "#fff", textShadow: "0 1px 8px rgba(0,0,0,0.45)" }}>{teamName}</h1>
          {(abbreviation || leagueLabel) && (
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {abbreviation && <Chip>{abbreviation}</Chip>}
              {leagueLabel && <Chip>{leagueLabel}</Chip>}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
