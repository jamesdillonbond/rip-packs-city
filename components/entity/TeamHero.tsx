// components/entity/TeamHero.tsx
// Team Hub Phase 1 (C1) + Phase 4 (F1/F2). Branded hero for /[collection]/team/[slug].
// Server component (no "use client"); the interactive bits are delegated to
// client islands: TeamLogo (logo onError fallback) and TeamFollowButton (the
// per-league favorite toggle).
//
// When the team is present in teams_master (primaryColor set), renders a
// team-colored banner with the official logo (NBA CDN, else initials), the
// team name, and abbreviation + league chips. When it is not (NFL/Golazos
// teams not yet in teams_master, or Pinnacle franchises), it falls back to the
// original plain-text hero markup so nothing regresses.
//
// Phase 4 adds, in both variants: a live-game chip (F2, in-season only, self-
// hides when nextGame is null) and a Follow control (F1, rendered only for teams
// that carry a teams_master short slug + league).
//
// Team colors arrive as data props (team identity, not RPC brand) — this is the
// one sanctioned place to use non-token colors. Everything else uses var(--rpc-*).

import type { CSSProperties } from "react"
import TeamLogo from "./TeamLogo"
import TeamFollowButton from "./TeamFollowButton"
import { relTime } from "./_shared"

export interface TeamNextGame {
  opponent_abbr: string | null
  home_away: "home" | "away" | null
  tipoff_at: string | null
  game_date: string | null
  status: string | null
  is_playoff: boolean | null
  series_label: string | null
  team_score: number | null
  opp_score: number | null
}

interface TeamHeroProps {
  teamName: string
  noun: string
  abbreviation?: string | null
  primaryColor?: string | null
  secondaryColor?: string | null
  leagueLabel?: string | null
  externalId?: string | null
  isFranchise: boolean
  // Phase 4
  nextGame?: TeamNextGame | null
  followLeague?: string | null
  followShortSlug?: string | null
  teamPath?: string
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

function gameLabel(g: TeamNextGame): string {
  const opp = g.opponent_abbr ?? "TBD"
  const vs = g.home_away === "away" ? "@" : "vs"
  const scheduled = (g.status ?? "").toLowerCase() === "scheduled"
  if (scheduled) {
    const when = g.tipoff_at ? ` · ${relTime(g.tipoff_at)}` : ""
    return `Plays ${vs} ${opp}${when}`
  }
  if (g.team_score != null && g.opp_score != null) {
    const won = g.team_score > g.opp_score
    return `${won ? "Beat" : "Lost to"} ${opp} ${g.team_score}–${g.opp_score}`
  }
  return `Last: ${vs} ${opp}`
}

// Live-game chip (F2). Rendered only when a game row exists; off-season this is
// null for everyone and the chip is absent — expected, not a bug.
function GameChip({ game, dark }: { game: TeamNextGame; dark: boolean }) {
  return (
    <span
      className="rpc-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        borderRadius: 6,
        fontSize: 11,
        letterSpacing: "0.04em",
        color: dark ? "#fff" : "var(--rpc-text-primary)",
        background: dark ? "rgba(0,0,0,0.30)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${dark ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)"}`,
      }}
    >
      {game.is_playoff ? "🏀 Playoffs · " : "🏀 "}{gameLabel(game)}
    </span>
  )
}

function HeroExtras({
  dark,
  nextGame,
  followLeague,
  followShortSlug,
  teamPath,
}: {
  dark: boolean
  nextGame?: TeamNextGame | null
  followLeague?: string | null
  followShortSlug?: string | null
  teamPath?: string
}) {
  const showFollow = !!followLeague && !!followShortSlug && !!teamPath
  if (!nextGame && !showFollow) return null
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
      {nextGame && <GameChip game={nextGame} dark={dark} />}
      {showFollow && (
        <TeamFollowButton league={followLeague!} teamShortSlug={followShortSlug!} teamPath={teamPath!} dark={dark} />
      )}
    </div>
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
  nextGame,
  followLeague,
  followShortSlug,
  teamPath,
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
        <HeroExtras dark={false} nextGame={nextGame} followLeague={followLeague} followShortSlug={followShortSlug} teamPath={teamPath} />
      </section>
    )
  }

  // ── Branded banner ────────────────────────────────────────────────────────
  // Official CDN logos: NBA + WNBA share the same id family and path shape on
  // their respective CDNs. Every other league (NFL/LaLiga) has no external_id
  // and falls back to the initials badge inside TeamLogo.
  const league = (leagueLabel ?? "").toUpperCase()
  const logoUrl = externalId
    ? league === "NBA"
      ? `https://cdn.nba.com/logos/nba/${externalId}/global/L/logo.svg`
      : league === "WNBA"
        ? `https://cdn.wnba.com/logos/wnba/${externalId}/global/L/logo.svg`
        : null
    : null
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
          <HeroExtras dark={true} nextGame={nextGame} followLeague={followLeague} followShortSlug={followShortSlug} teamPath={teamPath} />
        </div>
      </div>
    </section>
  )
}
