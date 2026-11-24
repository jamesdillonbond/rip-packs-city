// app/insights/candy-squeeze/page.tsx
//
// PUBLIC INSIGHTS — Candy Listed-Share Squeeze (2026-11-23, Candy parity pass 1; the Candy leg of /insights/squeeze,
// /insights/allday-squeeze and /insights/pinnacle-squeeze). Candy has no lock or burn mechanic, so its supply squeeze
// is how few of an edition's collector-held copies carry a live Magic Eden listing (re-seen by RPC's whole-book sweep
// within 12 h — the same "confirmed" ask the edition pages use).
//
// Every 2026 Candy set (Base, All-Star Game, Gold, Quest rewards — 20261124023333); holders are counted from RPC's
// on-chain census. Legacy (2021–2025) sets stay out until their listing sweep is a census. Server-rendered; the read is lib/insights/candy-parity-boards.ts. A failed read renders the
// degraded notice, never an empty board; the newest sweep time is shown so "0 listed" is dated. No FMV confidence.

import Link from "next/link"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchCandySqueeze, type CandySqueezePayload } from "@/lib/insights/candy-parity-boards"
import { fmtBoardUsd } from "@/lib/insights/pinnacle-board-format"
import { editionRouteHref } from "@/lib/entity-href"

// The Candy listings sweep runs every 3 h; refresh at half that.
export const revalidate = 1800

// 25 s, not the shared 8 s (#33). Measured 11-23: ~0.8 s cold.
const READ_BUDGET_MS = 25_000

const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" }
const head: React.CSSProperties = { ...cell, fontWeight: 600, color: "var(--rpc-text-muted)" }

function fmtSweep(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" })
}

export default async function CandySqueezePage() {
  const empty: CandySqueezePayload = { listings_seen_at: null, sets: [], min_held: 25, editions_ranked: 0, editions_zero_listed: 0, rows: [] }
  const res = await fetchBoardForPage("Candy squeeze", empty, (db) => fetchCandySqueeze(db), READ_BUDGET_MS)
  const d = res.data

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 18px 64px", display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--rpc-red-text)" }}>
          RPC Insights · Public
        </span>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 38, letterSpacing: "0.02em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1.05 }}>
          Candy Squeeze Board
        </h1>
        <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.55, maxWidth: 760 }}>
          Which 2026 Candy ICONs are collectors <strong>not selling</strong>? Every ICON across the 2026 Base Series,
          All-Star Game and Gold sets with {d.min_held}+ copies in collectors&rsquo; hands, ranked by the share of those
          copies listed on Magic Eden right now — the tightest supply first.
        </p>
        {res.ok ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Listings as of {fmtSweep(d.listings_seen_at)} · {d.editions_ranked.toLocaleString("en-US")} ICONs ranked ·{" "}
            {d.editions_zero_listed.toLocaleString("en-US")} with none listed
          </span>
        ) : null}
        {res.ok && d.sets.length > 1 ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
            {d.sets.map((s) => `${s.set_name}: ${s.ranked.toLocaleString("en-US")} ranked, ${s.zero_listed.toLocaleString("en-US")} unlisted`).join(" · ")}
          </span>
        ) : null}
      </header>

      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Candy squeeze", res.ok)])} />

      {d.rows.length > 0 ? (
        <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderRadius: 8, padding: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ ...head, textAlign: "left" }}>ICON</th>
                  <th scope="col" style={head}>Listed</th>
                  <th scope="col" style={head}>Collector-held</th>
                  <th scope="col" style={head}>% listed</th>
                  <th scope="col" style={head}>Floor</th>
                  <th scope="col" style={head}>FMV</th>
                  <th scope="col" style={head}>Sales 30d</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.external_id} style={{ borderTop: "1px solid var(--rpc-border-subtle)" }}>
                    <td style={{ ...cell, textAlign: "left", whiteSpace: "normal", minWidth: 200 }}>
                      <Link prefetch={false} href={editionRouteHref("candy-mlb", r.external_id)} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                        {r.player_name ?? r.external_id}
                      </Link>
                      <div style={{ color: "var(--rpc-text-muted)", fontSize: 10, marginTop: 2 }}>{[r.rarity_label, r.set_name].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td style={{ ...cell, fontWeight: 700 }}>{r.listed.toLocaleString("en-US")}</td>
                    <td style={cell}>
                      {r.collector_held.toLocaleString("en-US")}
                      {r.issuer_held > 0 ? <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>+{r.issuer_held.toLocaleString("en-US")} Candy-held</div> : null}
                    </td>
                    <td style={{ ...cell, fontWeight: 700 }}>{r.pct_listed != null ? `${r.pct_listed}%` : "—"}</td>
                    <td style={cell}>{r.floor_ask_usd != null ? fmtBoardUsd(r.floor_ask_usd) : "none listed"}</td>
                    <td style={cell}>{fmtBoardUsd(r.fmv_usd)}</td>
                    <td style={cell}>{r.sales_30d.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : res.ok ? (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)" }}>No 2026 ICON has {d.min_held}+ collector-held copies.</p>
      ) : null}

      <footer style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Method: <strong>collector-held</strong> = copies in collectors&rsquo; wallets, counted from RPC&rsquo;s on-chain
          census; copies in Candy&rsquo;s own wallets (inventory, ICON buyback and pack treasury) are shown as Candy-held
          and left out. <strong>Listed</strong> = Magic Eden listings of the ICON that
          RPC&rsquo;s whole-book sweep has seen in the last 12 hours (asks far above the card&rsquo;s value are left out), so
          0 means none were live at that time. Ties are broken by 30-day sales, so an ICON that trades but is rarely
          offered ranks above one nobody trades. ICONs with fewer than {d.min_held} collector-held copies are left out.
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/insights" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>← All insights</Link>
          <Link href="/insights/candy-mlb?tab=scarcity" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Candy scarcity</Link>
          <Link href="/insights/squeeze" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Top Shot squeeze</Link>
          <Link href="/candy-mlb/market" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Candy market</Link>
        </div>
      </footer>
    </div>
  )
}
