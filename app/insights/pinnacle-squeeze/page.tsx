// app/insights/pinnacle-squeeze/page.tsx
//
// PUBLIC INSIGHTS — Disney Pinnacle Listed-Share Squeeze (2026-11-23; the Pinnacle leg of /insights/squeeze and
// /insights/allday-squeeze). Pinnacle has no lock or burn mechanic, so its supply squeeze is how few of a pin's
// collector-held copies are listed for sale, from the last COMPLETE listings sweep (a census, not a window).
//
// Server-rendered; the read is lib/insights/pinnacle-boards.ts. A failed read renders the degraded notice, never an
// empty board; the sweep's own time is shown so "0 listed" is dated. No FMV confidence.

import Link from "next/link"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchPinnacleSqueeze, type PinnacleSqueezePayload } from "@/lib/insights/pinnacle-boards"
import { fmtBoardUsd } from "@/lib/insights/pinnacle-board-format"

// The listings sweep runs ~5×/day; refresh with it.
export const revalidate = 1800

// 25 s, not the shared 8 s (#33; see pinnacle-pack-reality). Measured 11-23: well under 1 s.
const READ_BUDGET_MS = 25_000

const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" }
const head: React.CSSProperties = { ...cell, fontWeight: 600, color: "var(--rpc-text-muted)" }

function fmtSweep(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" })
}

export default async function PinnacleSqueezePage() {
  const empty: PinnacleSqueezePayload = { listings_seen_at: null, min_held: 25, pins_ranked: 0, pins_zero_listed: 0, rows: [] }
  const res = await fetchBoardForPage("Pinnacle squeeze", empty, (db) => fetchPinnacleSqueeze(db), READ_BUDGET_MS)
  const d = res.data

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 18px 64px", display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--rpc-red-text)" }}>
          RPC Insights · Public
        </span>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 38, letterSpacing: "0.02em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1.05 }}>
          Disney Pinnacle Squeeze Board
        </h1>
        <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.55, maxWidth: 760 }}>
          Which pins are collectors <strong>not selling</strong>? Every pin with {d.min_held}+ copies in collectors&rsquo;
          hands, ranked by the share of those copies listed for sale right now — the tightest supply first.
        </p>
        {res.ok ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Listings as of {fmtSweep(d.listings_seen_at)} · {d.pins_ranked.toLocaleString("en-US")} pins ranked ·{" "}
            {d.pins_zero_listed.toLocaleString("en-US")} with none listed
          </span>
        ) : null}
      </header>

      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Pinnacle squeeze", res.ok)])} />

      {d.rows.length > 0 ? (
        <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderRadius: 8, padding: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ ...head, textAlign: "left" }}>Pin</th>
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
                  <tr key={r.render_id} style={{ borderTop: "1px solid var(--rpc-border-subtle)" }}>
                    <td style={{ ...cell, textAlign: "left", whiteSpace: "normal", minWidth: 200 }}>
                      <Link prefetch={false} href={`/pinnacle/moment/${encodeURIComponent(r.render_id)}`} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                        {r.character_name ?? r.render_id}
                      </Link>
                      <div style={{ color: "var(--rpc-text-muted)", fontSize: 10, marginTop: 2 }}>
                        {[r.variant, r.edition_type, r.is_chaser ? "Chaser" : null, r.set_name].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td style={{ ...cell, fontWeight: 700 }}>{r.listed.toLocaleString("en-US")}</td>
                    <td style={cell}>
                      {r.collector_held.toLocaleString("en-US")}
                      {r.issuer_held > 0 ? <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>+{r.issuer_held.toLocaleString("en-US")} issuer</div> : null}
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
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)" }}>No pin has {d.min_held}+ collector-held copies with a known supply split.</p>
      ) : null}

      <footer style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Method: <strong>collector-held</strong> = minted − burned − copies Disney Pinnacle itself still holds (unsold or
          reserve stock), from on-chain supply data. <strong>Listed</strong> = every listing of the pin in RPC&rsquo;s last
          complete sweep of the Disney Pinnacle marketplace, so 0 means none were listed at that time. Ties are broken by
          30-day sales, so a pin that trades but is rarely offered ranks above one nobody trades. Pins with fewer than{" "}
          {d.min_held} collector-held copies are left out (one listing would swing them too far).
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/insights" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>← All insights</Link>
          <Link href="/insights/pinnacle-scarcity" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Pinnacle scarcity</Link>
          <Link href="/insights/squeeze" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Top Shot squeeze</Link>
        </div>
      </footer>
    </div>
  )
}
