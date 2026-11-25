// app/insights/pinnacle-pack-reality/page.tsx
//
// PUBLIC INSIGHTS — Disney Pinnacle Pack Reality (2026-11-23; the Pinnacle leg of /insights/pack-reality
// and /insights/allday-pack-reality). "Did the packs pay?" — per drop opened since Sept 2026, the retail
// price beside what the opened packs' pulls were worth when opened and are worth today.
//
// Server-rendered so the rows are crawlable. The read and its shape live in
// lib/insights/pinnacle-pack-reality-board.ts; a failed read renders the degraded notice, never an
// empty board, and an unknown value renders "—", never $0. No FMV confidence anywhere (internal only).

import Link from "next/link"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import {
  fetchPinnacleReality,
  valueToPriceRatio,
  type PinnacleRealityPayload,
} from "@/lib/insights/pinnacle-pack-reality-board"
import { usdSignFirst } from "@/lib/usd-format"

export const revalidate = 3600

// ⚠ This page's read gets 25 s, not the shared 8 s BOARD_LIVE_TIMEOUT_MS (the panini-premiums fix,
// 070bd9eaf). Measured 2026-11-23: the function runs in ~0.4 s warm / ~1.2 s cold, but its first
// build prerender exceeded 8 s under the build's concurrent board reads, and this board has no
// client refetch — ISR would serve that "couldn't load" for the whole hour (#33). An hourly
// regeneration runs in the background, so the role's budget (service_role 30 s; Next's prerender
// limit 60 s) is the right ceiling.
const PINNACLE_PACK_REALITY_READ_BUDGET_MS = 25_000

function fmtUsd(v: number | null): string {
  const neg = usdSignFirst(v, fmtUsd); if (neg !== null) return neg
  if (v == null) return "—"
  if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  // A fixed zone so the server render and any client re-render agree (#418).
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" }
const head: React.CSSProperties = { ...cell, fontWeight: 600, color: "var(--rpc-text-muted)" }

export default async function PinnaclePackRealityPage() {
  const empty: PinnacleRealityPayload = { since: "", min_opens: 25, drops: [] }
  const res = await fetchBoardForPage("Pinnacle pack reality", empty, (db) => fetchPinnacleReality(db), PINNACLE_PACK_REALITY_READ_BUDGET_MS)
  const { drops, min_opens } = res.data

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 18px 64px", display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--rpc-red-text)" }}>
          RPC Insights · Public
        </span>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 38, letterSpacing: "0.02em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1.05 }}>
          Disney Pinnacle Pack Reality
        </h1>
        <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.55, maxWidth: 760 }}>
          Did the packs pay? For every Disney Pinnacle drop opened since September 2026, the price you paid beside what
          the pins that came out were worth <strong>when opened</strong> and are worth <strong>today</strong> — read
          from every on-chain pack open, priced by RPC&rsquo;s own per-pin FMV.
        </p>
      </header>

      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Pinnacle pack reality", res.ok)])} />

      {res.ok && drops.length === 0 ? (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)" }}>
          No drop has {min_opens}+ observed opens since September yet.
        </p>
      ) : null}

      {drops.length > 0 ? (
        <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderRadius: 8, padding: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ ...head, textAlign: "left" }}>Drop</th>
                  <th scope="col" style={head}>Price</th>
                  <th scope="col" style={head}>Opened</th>
                  <th scope="col" style={head}>Avg at open</th>
                  <th scope="col" style={head}>Avg today</th>
                  <th scope="col" style={head}>Median today</th>
                  <th scope="col" style={head}>Today ÷ price</th>
                  <th scope="col" style={head}>Packs worth ≥ price</th>
                  <th scope="col" style={head}>Best pull</th>
                </tr>
              </thead>
              <tbody>
                {drops.map((d) => {
                  const ratio = valueToPriceRatio(d)
                  const color = ratio == null ? "var(--rpc-text-secondary)" : ratio >= 1 ? "var(--rpc-success, var(--rpc-text-primary))" : "var(--rpc-red-text)"
                  return (
                    <tr key={d.dist_ids.join("-") || d.drop_name} style={{ borderTop: "1px solid var(--rpc-border-subtle)" }}>
                      <td style={{ ...cell, textAlign: "left", whiteSpace: "normal", minWidth: 180 }}>
                        {d.dist_ids[0] ? (
                          <Link prefetch={false} href={`/disney-pinnacle/pack/dist/${encodeURIComponent(d.dist_ids[0])}`} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                            {d.drop_name}
                          </Link>
                        ) : d.drop_name}
                        <div style={{ color: "var(--rpc-text-muted)", fontSize: 10, marginTop: 2 }}>
                          {fmtDay(d.first_open_at)}{d.dist_ids.length > 1 ? ` · ${d.dist_ids.length} pools, one pack` : ""}
                        </div>
                      </td>
                      <td style={cell}>{fmtUsd(d.price_usd)}</td>
                      <td style={cell}>{d.packs_opened.toLocaleString("en-US")}</td>
                      <td style={{ ...cell, color: "var(--rpc-text-secondary)" }}>
                        {fmtUsd(d.avg_value_at_open)}
                        {d.avg_value_at_open != null && d.n_at_open < d.packs_opened ? <span style={{ fontSize: 10 }}> ({d.n_at_open.toLocaleString("en-US")})</span> : null}
                      </td>
                      <td style={{ ...cell, fontWeight: 700, color }}>
                        {fmtUsd(d.avg_value_today)}
                        {d.avg_value_today != null && d.n_today < d.packs_opened ? <span style={{ fontSize: 10, fontWeight: 400 }}> ({d.n_today.toLocaleString("en-US")})</span> : null}
                      </td>
                      <td style={cell}>{fmtUsd(d.median_value_today)}</td>
                      <td style={{ ...cell, color }}>{ratio != null ? `${ratio.toFixed(2)}×` : "—"}</td>
                      <td style={cell}>{d.pct_today_at_or_above_price != null ? `${d.pct_today_at_or_above_price}%` : "—"}</td>
                      <td style={cell}>{fmtUsd(d.best_pull_today)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <footer style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Method: every opened pack counts once. <strong>At open</strong> = the first price RPC put on the pulls, used only
          when it was set within 3 days of the open; where a pack was priced later, each pin&rsquo;s price from RPC&rsquo;s
          price history at the open (or within 3 days after) is used instead, and a pack with no such price is left
          blank, not zero. <strong>Today</strong> = the sum of each pulled pin&rsquo;s current FMV; a pack with any
          unpriced pin is left out — the number in brackets is how many packs a figure covers when it is not all of them.
          A &ldquo;Standard&rdquo; pack that Disney Pinnacle splits into several pools is one row, because a buyer
          can&rsquo;t pick a pool. Drops need {min_opens}+ opens. Excluded: Disney&rsquo;s internal test distributions,
          and the Walt Disney Mugs capsule&rsquo;s LE-pin pool (its other capsules minted mugs outside any pack open, so
          the pool alone would overstate the capsule). Prices are retail as listed by Disney Pinnacle.
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/insights" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>← All insights</Link>
          <Link href="/disney-pinnacle/packs" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Pinnacle packs</Link>
          <Link href="/insights/pack-reality" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Top Shot Pack Reality</Link>
        </div>
      </footer>
    </div>
  )
}
