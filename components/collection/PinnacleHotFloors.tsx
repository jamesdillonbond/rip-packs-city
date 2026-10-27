// components/collection/PinnacleHotFloors.tsx
//
// Disney Pinnacle Hot Floors body (/disney-pinnacle/hot-floors, Top Shot parity 2026-10-26): PINS being SWEPT —
// one buyer taking 3+ copies with no gap over 60 minutes — over the last N days of on-chain sales. Same columns
// as Top Shot's board. Pure props (data: lib/hot-floors/pinnacle.ts) so a test can render every state.
//
// Honesty: a failed read says so and makes no claim about the market; an empty ok read says no sweep was seen
// in the window; collectors are counted, never named; no FMV tier anywhere; the floor ask carries its last
// sweep check (askAgeStamp, "checked" kind for Pinnacle), and a pin with no open ask says so.

import Link from "next/link"
import type { CSSProperties } from "react"
import { fmtUsd, fmtCount, relTime } from "@/components/entity/_shared"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { askAgeStamp } from "@/lib/market/ask-freshness"
import type { PinnacleHotPin } from "@/lib/hot-floors/pinnacle"

const th: CSSProperties = { padding: "10px 12px", textAlign: "right" }
const td: CSSProperties = { padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }

export default function PinnacleHotFloors({
  editions,
  ok,
  days,
  newestSaleAt,
  now,
}: {
  editions: PinnacleHotPin[]
  ok: boolean
  days: number
  newestSaleAt: string | null
  /** Tests pin a clock; omitted, relTime / askAgeStamp use their own default. */
  now?: number
}) {
  return (
    <div style={{ padding: "8px 0 40px" }} data-testid="pinnacle-hot-floors">
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 26, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
          Hot Floors
        </h1>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.6, margin: "8px 0 0", maxWidth: 720 }}>
          Disney Pinnacle pins being <strong style={{ color: "var(--rpc-text-primary)" }}>swept</strong> — one collector buying three or more copies in quick
          succession — over the last {days} days. Ranked by how many different collectors swept them. Collectors are counted, never named.
        </p>
        {newestSaleAt && (
          <p data-testid="pinnacle-hot-floors-newest" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", margin: "6px 0 0", maxWidth: 720 }}>
            Newest sale on record: {relTime(newestSaleAt, now)}.
          </p>
        )}
      </header>

      {!ok ? (
        <div data-testid="pinnacle-hot-floors-failed" style={{ color: "var(--rpc-red-text)", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16 }}>
          Couldn&rsquo;t load hot floors right now. Try again shortly.
        </div>
      ) : editions.length === 0 ? (
        <div data-testid="pinnacle-hot-floors-empty" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16 }}>
          No sweeps in the last {days} days.
        </div>
      ) : (
        <div {...scrollRegion("Hot floors")} style={{ overflowX: "auto", border: "1px solid var(--rpc-border)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 13, minWidth: 720 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>
                <th scope="col" style={{ padding: "10px 12px" }}>#</th>
                <th scope="col" style={{ padding: "10px 12px" }}>Pin</th>
                <th scope="col" style={th}>Sweepers</th>
                <th scope="col" style={th}>Swept sales</th>
                <th scope="col" style={th}>Swept $</th>
                <th scope="col" style={th}>Avg paid</th>
                <th scope="col" style={th}>Floor</th>
                <th scope="col" style={th}>FMV</th>
                <th scope="col" style={th}>Last</th>
              </tr>
            </thead>
            <tbody>
              {editions.map((e, i) => {
                const sub = [e.set_name, e.tier, e.circulation_count ? `/${e.circulation_count.toLocaleString("en-US")}` : null]
                  .filter(Boolean)
                  .join(" · ")
                const stamp = askAgeStamp(e.floor_ask_verified_at, e.floor_ask, "disney_pinnacle", now)
                return (
                  <tr key={e.external_id} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                    <td style={{ padding: "10px 12px", color: "var(--rpc-text-muted)" }}>{i + 1}</td>
                    <td style={{ padding: "8px 12px" }}>
                      <Link href={`/pinnacle/moment/${encodeURIComponent(e.external_id)}`} style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                        <span style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 4, overflow: "hidden", background: "var(--rpc-surface-hover)", display: "inline-block" }}>
                          {/* The pin's own same-origin image route (as on the pin page), keyed by render_id —
                              never a stored thumbnail URL straight into <img> (moment-art-reaches-the-proxy). */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/public/pinnacle-image/${encodeURIComponent(e.external_id)}`} alt="" width={34} height={34} loading="lazy" style={{ objectFit: "cover", width: 34, height: 34 }} />
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
                    <td style={td}>
                      {e.floor_ask != null ? (
                        <>
                          {fmtUsd(e.floor_ask)}
                          {stamp && (
                            <span data-testid="pinnacle-hot-floors-ask-age" title={stamp.title} style={{ display: "block", fontSize: 10, color: stamp.stale ? "var(--rpc-red-text)" : "var(--rpc-text-muted)" }}>
                              {stamp.label}
                            </span>
                          )}
                        </>
                      ) : (
                        "not listed"
                      )}
                    </td>
                    <td style={{ ...td, color: "var(--rpc-text-muted)" }}>{fmtUsd(e.fmv_usd)}</td>
                    <td style={{ ...td, color: "var(--rpc-text-muted)" }}>{e.last_swept_at ? relTime(e.last_swept_at, now) : "—"}</td>
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
