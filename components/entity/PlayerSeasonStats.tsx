// components/entity/PlayerSeasonStats.tsx — the player page's "Season stats"
// section (batch 48, 2026-09-25): ESPN's per-season lines, keyed to the player
// through the league-id crosswalk (player_identities → player_season_stats).
//
// Three states, rendered distinctly (honesty canon):
//   · read failed        → SectionUnavailable (the caller passes ok:false)
//   · no feed (null)     → nothing (the feed cannot key this player; an
//                          absence is not a claim, and most non-NBA/NFL players
//                          land here)
//   · keyed, no rows     → "no season stats from the feed yet"
//   · rows               → one compact table per category

import { Section, SectionUnavailable, relTime } from "@/components/entity/_shared"
import { buildSeasonStatsTables, type SeasonStatsResult } from "@/lib/player-page-season-stats"

export default function PlayerSeasonStats({
  result,
  ok,
  playerName,
}: {
  result: SeasonStatsResult | null
  ok: boolean
  playerName: string
}) {
  if (!ok) {
    return (
      <Section title="Season Stats">
        <SectionUnavailable noun={`${playerName}’s season stats`} />
      </Section>
    )
  }
  if (result == null) return null

  const tables = buildSeasonStatsTables(result)
  const refreshed = result.rows_refreshed_at ?? result.stats_refreshed_at
  return (
    <Section
      title="Season Stats"
      action={
        <span className="rpc-mono" data-testid="season-stats-source" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
          {refreshed ? `ESPN · refreshed ${relTime(refreshed)}` : "ESPN"}
        </span>
      }
    >
      {tables.length === 0 ? (
        <div className="rpc-mono" data-testid="season-stats-empty" style={{ padding: 12, color: "var(--rpc-text-muted)", fontSize: 12 }}>
          No season stats from the feed yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {tables.map((t) => (
            <div key={t.category} data-testid={`season-stats-${t.category}`}>
              <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>
                {t.title}
              </div>
              <div className="rpc-scroll-x">
                <table style={{ borderCollapse: "collapse", minWidth: 420, width: "100%", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--rpc-text-muted)", fontWeight: 400, whiteSpace: "nowrap" }}>Season</th>
                      {t.labels.map((l, i) => (
                        <th key={`${l}-${i}`} style={{ textAlign: "right", padding: "4px 8px", color: "var(--rpc-text-muted)", fontWeight: 400, whiteSpace: "nowrap" }}>{l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.seasons.map((s) => (
                      <tr key={s.season} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "var(--rpc-text-primary)" }}>
                          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13 }}>{s.seasonLabel}</span>
                          {s.team ? <span style={{ color: "var(--rpc-text-muted)", marginLeft: 8, fontSize: 11 }}>{s.team}</span> : null}
                        </td>
                        {s.values.map((v, i) => (
                          <td key={i} style={{ padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap", color: "var(--rpc-text-secondary)" }}>{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}
