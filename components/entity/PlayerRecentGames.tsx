// components/entity/PlayerRecentGames.tsx — the player page's "Recent Games" section
// (2026-11-08): ESPN box scores from the espn-game-logs lane, each beside this
// collection's player market cap the day before and the day after the game.
//
// Four states, rendered distinctly (honesty canon):
//   · read failed               → SectionUnavailable (the caller passes ok:false)
//   · no feed / >1 athlete      → nothing (an absence is not a claim; two athletes
//                                 behind one name are never merged)
//   · linked, no games yet      → "No games from the feed yet."
//   · games                     → one row per game
//
// No FMV confidence tier anywhere (internal only). A market-cap move is shown with its
// supply change when supply is a real share of it, and the footnote says what the
// numbers cannot: one game is not evidence that performance moved the price.

import { Section, SectionUnavailable } from "@/components/entity/_shared"
import { marketMove, statLine, type RecentGame, type RecentGamesResult } from "@/lib/player-recent-games"
import { scrollRegion } from "@/lib/a11y/scroll-region"

const LEAGUE_LABEL: Record<string, string> = {
  nba: "NBA", wnba: "WNBA", nfl: "NFL", mlb: "MLB", laliga: "LaLiga", epl: "Premier League", seriea: "Serie A",
  bundesliga: "Bundesliga", ligue1: "Ligue 1", mls: "MLS", ligaportugal: "Liga Portugal", eredivisie: "Eredivisie",
}

const FP_LABEL: Record<string, string> = {
  nba: "DK fantasy points", wnba: "DK fantasy points", nfl: "half-PPR fantasy points",
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

export function gameMoveCell(g: RecentGame): { text: string; tone: "up" | "down" | "flat" | "none"; supply: string | null } {
  const m = marketMove(g)
  if (m.change_pct == null) return { text: "—", tone: "none", supply: null }
  const tone = m.change_pct > 0 ? "up" : m.change_pct < 0 ? "down" : "flat"
  const text = `${m.change_pct > 0 ? "+" : ""}${m.change_pct.toFixed(1)}%`
  const supply = m.supply_driven && m.collector_held_change != null
    ? `supply ${m.collector_held_change > 0 ? "+" : ""}${m.collector_held_change.toLocaleString("en-US")}`
    : null
  return { text, tone, supply }
}

export default function PlayerRecentGames({
  result,
  ok,
  playerName,
}: {
  result: RecentGamesResult | null
  ok: boolean
  playerName: string
}) {
  if (!ok) {
    return (
      <Section title="Recent Games">
        <SectionUnavailable noun={`${playerName}’s recent games`} />
      </Section>
    )
  }
  if (result == null || result.linked !== 1) return null

  const games = result.games ?? []
  const leagues = Array.from(new Set(games.map((g) => g.league)))
  const fpLabel = leagues.length === 1 ? FP_LABEL[leagues[0]] ?? (leagues[0] === "mlb" ? null : "RPC soccer index") : "fantasy points"
  const showFp = games.some((g) => g.fantasy_points != null && !g.did_not_play)

  return (
    <Section
      title="Recent Games"
      action={
        <span className="rpc-mono" data-testid="recent-games-source" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
          ESPN
        </span>
      }
    >
      {games.length === 0 ? (
        <div className="rpc-mono" data-testid="recent-games-empty" style={{ padding: 12, color: "var(--rpc-text-muted)", fontSize: 12 }}>
          No games from the feed yet.
        </div>
      ) : (
        <>
          <div className="rpc-scroll-x" {...scrollRegion("Recent games")}>
            <table data-testid="recent-games-table" style={{ borderCollapse: "collapse", minWidth: 460, width: "100%", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr>
                  <th scope="col" style={th("left")}>Date</th>
                  <th scope="col" style={th("left")}>Opp</th>
                  <th scope="col" style={th("left")}>Line</th>
                  {showFp && <th scope="col" style={th("right")} title={fpLabel ?? undefined}>FP</th>}
                  <th scope="col" style={th("right")} title="Player market cap in this collection, the day before vs the day after the game">Mkt cap</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g, i) => {
                  const move = gameMoveCell(g)
                  const line = g.did_not_play ? "Did not play" : statLine(g.league, g.stats) ?? "—"
                  const vsAvg = !g.did_not_play && g.fantasy_points != null && result.season_avg_fp != null ? g.fantasy_points - result.season_avg_fp : null
                  return (
                    <tr key={`${g.date}-${i}`} data-testid="recent-games-row" style={{ borderTop: "1px solid var(--rpc-border)" }}>
                      <td style={td("left")}>
                        <span style={{ color: "var(--rpc-text-primary)" }}>{fmtDate(g.date)}</span>
                        {leagues.length > 1 && <span style={{ color: "var(--rpc-text-muted)", marginLeft: 6, fontSize: 10 }}>{LEAGUE_LABEL[g.league] ?? g.league}</span>}
                      </td>
                      <td style={td("left")}>{g.opponent ? `${g.is_home === false ? "@" : g.is_home ? "vs" : ""} ${g.opponent}`.trim() : "—"}</td>
                      <td style={{ ...td("left"), whiteSpace: "normal", color: g.did_not_play ? "var(--rpc-text-muted)" : "var(--rpc-text-secondary)" }}>{line}</td>
                      {showFp && (
                        <td style={td("right")}>
                          {g.did_not_play || g.fantasy_points == null ? "—" : g.fantasy_points.toFixed(1)}
                          {vsAvg != null && (
                            <span style={{ display: "block", fontSize: 10, color: "var(--rpc-text-muted)" }}>
                              {vsAvg >= 0 ? "+" : ""}{vsAvg.toFixed(1)} vs avg
                            </span>
                          )}
                        </td>
                      )}
                      <td style={{ ...td("right"), color: move.tone === "up" ? "var(--rpc-success-text)" : move.tone === "down" ? "var(--rpc-red-text)" : "var(--rpc-text-secondary)" }}>
                        {move.text}
                        {move.supply && <span data-testid="recent-games-supply" style={{ display: "block", fontSize: 10, color: "var(--rpc-text-muted)" }}>{move.supply}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="rpc-mono" data-testid="recent-games-footnote" style={{ margin: "8px 0 0", fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
            {showFp && fpLabel ? `FP = ${fpLabel}${result.season_avg_fp != null ? `; season average ${result.season_avg_fp.toFixed(1)}` : ""}. ` : ""}
            Market cap is the day before vs the day after each game; a day’s move mixes price, supply and market noise, so a single game is not evidence that performance moved the price.
          </p>
        </>
      )}
    </Section>
  )
}

function th(align: "left" | "right") {
  return { textAlign: align, padding: "4px 8px", color: "var(--rpc-text-muted)", fontWeight: 400, whiteSpace: "nowrap" as const }
}
function td(align: "left" | "right") {
  return { textAlign: align, padding: "6px 8px", whiteSpace: "nowrap" as const, color: "var(--rpc-text-secondary)", verticalAlign: "top" as const }
}
