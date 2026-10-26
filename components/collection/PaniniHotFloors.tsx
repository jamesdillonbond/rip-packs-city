// components/collection/PaniniHotFloors.tsx
//
// Panini Hot Floors body (/panini-blockchain/hot-floors, Top Shot parity 2026-10-25): editions being
// SWEPT — one buyer taking 3+ copies with no gap over 60 minutes — over the last N days of sales on
// record. Same columns as Top Shot's board. Pure props (data: lib/hot-floors/panini.ts) so a test can
// render every state.
//
// Honesty: a failed read says so and makes no claim about the market; an empty ok read says no sweep is
// ON RECORD (Panini sales arrive late, so "none" is never stated as fact about the newest days); buyers
// are counted, never named; no FMV tier anywhere.

import Link from "next/link"
import type { CSSProperties } from "react"
import MomentMedia from "@/components/MomentMedia"
import { fmtUsd, fmtCount, relTime } from "@/components/entity/_shared"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { paniniAssetUrl } from "@/lib/panini/assets"
import type { PaniniHotEdition } from "@/lib/hot-floors/panini"

const th: CSSProperties = { padding: "10px 12px", textAlign: "right" }
const td: CSSProperties = { padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }

export default function PaniniHotFloors({
  collection,
  editions,
  ok,
  days,
  newestSaleAt,
}: {
  collection: string
  editions: PaniniHotEdition[]
  ok: boolean
  days: number
  newestSaleAt: string | null
}) {
  return (
    <div style={{ padding: "8px 0 40px" }} data-testid="panini-hot-floors">
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 26, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
          Hot Floors
        </h1>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.6, margin: "8px 0 0", maxWidth: 720 }}>
          Panini editions being <strong style={{ color: "var(--rpc-text-primary)" }}>swept</strong> — one buyer taking three or more copies in quick succession — over
          the last {days} days of sales on record. Ranked by how many different buyers swept them. Buyers are counted, never named.
        </p>
        <p data-testid="panini-hot-floors-lag" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", margin: "6px 0 0", maxWidth: 720 }}>
          Panini sales reach RPC hours to days after they happen, so the newest days are not complete.
          {newestSaleAt ? ` Newest sale on record: ${relTime(newestSaleAt)}.` : ""}
        </p>
      </header>

      {!ok ? (
        <div data-testid="panini-hot-floors-failed" style={{ color: "var(--rpc-red-text)", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16 }}>
          Couldn&rsquo;t load hot floors right now. Try again shortly.
        </div>
      ) : editions.length === 0 ? (
        <div data-testid="panini-hot-floors-empty" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16 }}>
          No sweep is on record for the last {days} days.
        </div>
      ) : (
        <div {...scrollRegion("Hot floors")} style={{ overflowX: "auto", border: "1px solid var(--rpc-border)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 13, minWidth: 720 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>
                <th scope="col" style={{ padding: "10px 12px" }}>#</th>
                <th scope="col" style={{ padding: "10px 12px" }}>Card</th>
                <th scope="col" style={th}>Sweepers</th>
                <th scope="col" style={th}>Swept sales</th>
                <th scope="col" style={th}>Swept $</th>
                <th scope="col" style={th}>Avg paid</th>
                <th scope="col" style={th}>Ask</th>
                <th scope="col" style={th}>FMV</th>
                <th scope="col" style={th}>Last</th>
              </tr>
            </thead>
            <tbody>
              {editions.map((e, i) => {
                const img = paniniAssetUrl(e.thumbnail_url)
                const sub = [e.parallel ?? e.set_name, e.mint_cap ? `/${e.mint_cap}` : null].filter(Boolean).join(" ")
                return (
                  <tr key={e.external_id} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                    <td style={{ padding: "10px 12px", color: "var(--rpc-text-muted)" }}>{i + 1}</td>
                    <td style={{ padding: "8px 12px" }}>
                      <Link href={`/${collection}/edition/${encodeURIComponent(e.external_id)}`} style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                        <span style={{ width: 34, height: 44, flexShrink: 0, display: "inline-block" }}>
                          {img ? <MomentMedia thumbnailUrl={img} alt="" size={34} rounded={4} /> : null}
                        </span>
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontWeight: 600 }}>{e.player_name ?? "—"}</span>
                          <span style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>{sub || "—"}</span>
                        </span>
                      </Link>
                    </td>
                    <td style={{ ...td, fontWeight: 700, color: "var(--rpc-text-primary)" }}>{fmtCount(e.sweep_buyers)}</td>
                    <td style={td}>{fmtCount(e.swept_sales)}</td>
                    <td style={td}>{fmtUsd(e.swept_spend)}</td>
                    <td style={{ ...td, color: "var(--rpc-text-primary)" }}>
                      {e.swept_sales > 0 && e.swept_spend != null ? fmtUsd(Number(e.swept_spend) / e.swept_sales) : "—"}
                    </td>
                    <td style={td}>{e.floor_ask != null ? fmtUsd(e.floor_ask) : "not listed"}</td>
                    <td style={{ ...td, color: "var(--rpc-text-muted)" }}>{fmtUsd(e.fmv_usd)}</td>
                    <td style={{ ...td, color: "var(--rpc-text-muted)" }}>{e.last_swept_at ? relTime(e.last_swept_at) : "—"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
