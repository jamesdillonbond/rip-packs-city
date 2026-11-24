// app/insights/candy-serial-premiums/page.tsx
//
// PUBLIC INSIGHTS — Candy Serial Premiums (2026-11-23, Candy parity pass 1; the Candy leg of /insights/serial-premiums,
// /insights/allday-serial-premiums and /insights/pinnacle-serial-premiums). Every #1, jersey-match and perfect-serial
// (#N of N) Candy sale, with what the same card's other serials sold for around then and the premium. These are the
// three special serials Candy edition pages already flag; this board is the sales evidence for them.
//
// Every Candy set RPC catalogues (not only the 2026 Base Series): realised sales are facts on any set, and one-of-one
// generative cards are excluded in SQL (their #1 is the only copy). Server-rendered so the rows are crawlable; the read
// is lib/insights/candy-parity-boards.ts. A failed read renders the degraded notice, never an empty board; a premium
// without ≥ 3 comparables is "—", never 1.0×. Buyers never named.

import Link from "next/link"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import {
  CANDY_SERIAL_BAND_LABEL,
  fetchCandySerialPremiums,
  type CandySerialBand,
  type CandySerialPayload,
} from "@/lib/insights/candy-parity-boards"
import { fmtBoardDay, fmtBoardUsd, fmtMultiplier } from "@/lib/insights/pinnacle-board-format"
import { editionRouteHref } from "@/lib/entity-href"

export const revalidate = 3600

// 25 s, not the shared 8 s: an hourly background regeneration with no client refetch (#33). Measured 11-23: ~1 s.
const READ_BUDGET_MS = 25_000

const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" }
const head: React.CSSProperties = { ...cell, fontWeight: 600, color: "var(--rpc-text-muted)" }

const TILES: Array<{ band: CandySerialBand; label: string }> = [
  { band: "first", label: "#1 serials" },
  { band: "jersey", label: "Jersey-match serials" },
  { band: "perfect", label: "Perfect serials" },
]

export default async function CandySerialPremiumsPage() {
  const empty: CandySerialPayload = { stats: [], rows: [] }
  const res = await fetchBoardForPage("Candy serial premiums", empty, (db) => fetchCandySerialPremiums(db), READ_BUDGET_MS)
  const { stats, rows } = res.data

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 18px 64px", display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--rpc-red-text)" }}>
          RPC Insights · Public
        </span>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 38, letterSpacing: "0.02em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1.05 }}>
          Candy Serial Premiums
        </h1>
        <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.55, maxWidth: 760 }}>
          What a <strong>#1</strong>, a <strong>jersey-match</strong> serial (the player&rsquo;s own number) or a{" "}
          <strong>perfect serial</strong> (the last number — #250 of 250) is actually worth on Candy: every such sale on
          record, beside what the same card&rsquo;s other serials sold for around the same time.
        </p>
      </header>

      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Candy serial premiums", res.ok)])} />

      {res.ok && stats.length > 0 ? (
        <section style={{ display: "flex", gap: 12, flexWrap: "wrap" }} aria-label="Median premium by serial">
          {TILES.map(({ band, label }) => {
            const s = stats.find((x) => x.band === band)
            return (
              <div key={band} style={{ flex: "1 1 220px", background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderRadius: 8, padding: 14 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 800, color: "var(--rpc-text-primary)" }}>{fmtMultiplier(s?.median_multiplier)}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                  median premium · {s ? `${s.sales.toLocaleString("en-US")} sales, ${s.with_comps.toLocaleString("en-US")} with comparables` : "no sales"}
                </div>
              </div>
            )
          })}
        </section>
      ) : null}

      {res.ok && rows.length === 0 ? (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)" }}>No #1, jersey-match or perfect-serial sale on record yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderRadius: 8, padding: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ ...head, textAlign: "left" }}>Card</th>
                  <th scope="col" style={head}>Serial</th>
                  <th scope="col" style={head}>Sold</th>
                  <th scope="col" style={head}>Price</th>
                  <th scope="col" style={head}>Other serials (median)</th>
                  <th scope="col" style={head}>Premium</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.external_id}-${r.serial_number}-${r.sold_at}`} style={{ borderTop: "1px solid var(--rpc-border-subtle)" }}>
                    <td style={{ ...cell, textAlign: "left", whiteSpace: "normal", minWidth: 200 }}>
                      <Link prefetch={false} href={editionRouteHref("candy-mlb", r.external_id)} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                        {r.name ?? r.external_id}
                      </Link>
                      <div style={{ color: "var(--rpc-text-muted)", fontSize: 10, marginTop: 2 }}>{r.set_name ?? ""}</div>
                    </td>
                    <td style={cell}>
                      #{r.serial_number}{r.circulation_count != null ? ` / ${r.circulation_count}` : ""}
                      <div style={{ color: "var(--rpc-text-muted)", fontSize: 10 }}>{CANDY_SERIAL_BAND_LABEL[r.band]}</div>
                    </td>
                    <td style={cell}>{fmtBoardDay(r.sold_at)}</td>
                    <td style={{ ...cell, fontWeight: 700 }}>{fmtBoardUsd(r.price_usd)}</td>
                    <td style={{ ...cell, color: "var(--rpc-text-secondary)" }}>
                      {fmtBoardUsd(r.comp_median_usd)}
                      <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
                        {r.n_comps} {r.n_comps === 1 ? "sale" : "sales"}{r.comp_median_usd == null ? " — too few" : ""}
                      </div>
                    </td>
                    <td style={{ ...cell, fontWeight: 700 }}>{fmtMultiplier(r.multiplier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <footer style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Method: a <strong>jersey-match</strong> serial equals the player&rsquo;s uniform number; a{" "}
          <strong>perfect serial</strong> is the last number of the run (#N of N). The premium is the sale price ÷ the
          median price of the same card&rsquo;s other serials (not #1, not jersey, not perfect) sold within 60 days either
          side; it is shown only when at least 3 such sales exist. One-of-one cards are left out (their #1 is the only
          copy). Self-trades are left out; buyers are not named. Sales from Magic Eden and on-chain fills, every Candy
          set RPC tracks. Newest sales first, up to 200.
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/insights" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>← All insights</Link>
          <Link href="/insights/candy-mlb?tab=serials" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Who holds Candy&rsquo;s special serials</Link>
          <Link href="/insights/serial-premiums" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Top Shot serial premiums</Link>
          <Link href="/candy-mlb/overview" style={{ color: "var(--rpc-text-secondary)", textDecoration: "none" }}>Candy</Link>
        </div>
      </footer>
    </div>
  )
}
