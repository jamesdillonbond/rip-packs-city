// components/entity/CandyMarketHistory.tsx
// Candy MLB edition page — "Market history" (Top Shot parity, 2026-10-26). Server
// component over lib/candy/edition-market-history.ts. Three states: failed read says
// so; an empty record says what is empty (and since when); rows render newest first.

import { Section, fmtUsd } from "./_shared"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { CANDY_MARKET_HISTORY_SINCE, type CandyMarketDay } from "@/lib/candy/edition-market-history"

/** "2026-10-26" → "Oct 26, 2026" — calendar-day math only, no wall clock. */
function fmtDay(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (Number.isNaN(t)) return day
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

const cell: React.CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: React.CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)", textAlign: "left" }
const note: React.CSSProperties = { padding: "12px 14px", border: "1px dashed var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }

export default function CandyMarketHistory({ rows, ok }: { rows: CandyMarketDay[]; ok: boolean }) {
  const since = fmtDay(CANDY_MARKET_HISTORY_SINCE)
  return (
    <Section title="Market history">
      <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
        The cheapest Magic Eden listing RPC confirmed, how many copies were listed, and the best bid — once a day, recorded since {since}. A day RPC could not re-read the listings has no row.
      </div>
      {!ok ? (
        <div style={note} data-testid="candy-market-history-failed">Market history couldn&apos;t be loaded — refresh to try again.</div>
      ) : rows.length === 0 ? (
        <div style={note} data-testid="candy-market-history-empty">{`No day recorded for this edition yet (the record starts ${since}).`}</div>
      ) : (
        <div className="rpc-scroll-x" {...scrollRegion("Market history for this edition")}>
          <table data-testid="candy-market-history" style={{ borderCollapse: "collapse", width: "100%", minWidth: 420 }}>
            <thead>
              <tr>
                <th scope="col" style={head}>Day</th>
                <th scope="col" style={head}>Floor ask</th>
                <th scope="col" style={head}>Change</th>
                <th scope="col" style={head}>Listed</th>
                <th scope="col" style={head}>Best bid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prev = rows[i + 1]?.floorAskUsd ?? null
                const move = r.floorAskUsd != null && prev != null && prev > 0 ? ((r.floorAskUsd - prev) / prev) * 100 : null
                return (
                  <tr key={r.day}>
                    <td style={cell}>{fmtDay(r.day)}</td>
                    <td style={{ ...cell, color: r.floorAskUsd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)" }}>
                      {r.floorAskUsd != null ? fmtUsd(r.floorAskUsd) : "none listed"}
                    </td>
                    <td style={cell}>{move == null ? "—" : `${move > 0 ? "+" : ""}${move.toFixed(1)}%`}</td>
                    <td style={cell}>{r.listedCount}</td>
                    <td style={cell}>{r.bestOfferUsd != null ? `${fmtUsd(r.bestOfferUsd)}${r.offerCount > 1 ? ` (${r.offerCount} bids)` : ""}` : "—"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
