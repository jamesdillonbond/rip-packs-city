"use client"

// components/entity/TopFansTable.tsx
//
// Top Fans (2026-11-27). One table per collection; on an aggregated hub the reader picks the
// collection with chips, and on every surface picks the ranking: count (Moments / Pins / Cards),
// FMV, or special serials (#1, perfect #N/N, jersey match — each item counted ONCE, so a 1/1 that
// is both #1 and perfect is one). Data: get_entity_top_fans via lib/entity/top-fans.ts.
//
// Three states per panel (lib/entity/top-fans-format.ts): could not ask → unavailable copy;
// measured empty → says so; rows → the table.

import Link from "next/link"
import { useState, type ReactNode } from "react"
import { Section, fmtCount, fmtUsd } from "@/components/entity/_shared"
import { truncateAddressForDisplay } from "@/lib/address"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import {
  rankTopFans,
  topFanHref,
  topFansSourceNote,
  topFansUpdatedLabel,
  TOP_FANS_LIMIT,
  type TopFansMetric,
  type TopFansPanel,
} from "@/lib/entity/top-fans-format"

function Chip({ on, onClick, disabled, title, children }: { on: boolean; onClick: () => void; disabled?: boolean; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={on ? "rpc-chip active" : "rpc-chip"}
      aria-pressed={on}
      title={title}
      style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, minHeight: 32 }}
    >{children}</button>
  )
}

export default function TopFansTable({ panels, subject, title = "Top Fans" }: { panels: TopFansPanel[]; subject: string; title?: string }) {
  const [active, setActive] = useState(0)
  const [metric, setMetric] = useState<TopFansMetric>("fmv")
  if (panels.length === 0) return null
  const panel = panels[Math.min(active, panels.length - 1)]
  const data = panel.ok ? panel.data : null
  const specialTracked = data?.special_tracked !== false
  const effMetric: TopFansMetric = metric === "special" && !specialTracked ? "fmv" : metric
  const rows = data ? rankTopFans(data.rows, effMetric, TOP_FANS_LIMIT) : []
  const updated = data ? topFansUpdatedLabel(data.refreshed_at) : null

  const col = (m: TopFansMetric) => ({
    color: effMetric === m ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
    fontWeight: effMetric === m ? 800 : 400,
  })

  return (
    <Section title={title}>
      {panels.length > 1 && (
        <div role="group" aria-label="Collection" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {panels.map((p, i) => (
            <Chip key={p.collectionId} on={i === active} onClick={() => setActive(i)}>{p.label}</Chip>
          ))}
        </div>
      )}
      <div role="group" aria-label="Rank by" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
        <span className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginRight: 4 }}>Rank by</span>
        <Chip on={effMetric === "items"} onClick={() => setMetric("items")}>{panel.units}</Chip>
        <Chip on={effMetric === "fmv"} onClick={() => setMetric("fmv")}>FMV</Chip>
        <Chip
          on={effMetric === "special"}
          onClick={() => setMetric("special")}
          disabled={!specialTracked}
          title={specialTracked ? "#1, perfect (#N/N) and jersey-match serials — each counted once" : "Serials aren't tracked for this collection"}
        >Special serials</Chip>
      </div>

      {!panel.ok || !data ? (
        <div className="rpc-mono" style={{ padding: 12, color: "var(--rpc-text-muted)", fontSize: 12 }}>
          Couldn&apos;t load {panel.label} top fans right now — try again shortly.
        </div>
      ) : rows.length === 0 ? (
        <div className="rpc-mono" style={{ padding: 12, color: "var(--rpc-text-muted)", fontSize: 12 }}>
          {effMetric === "special"
            ? <>No collector RPC can see holds a special serial of {subject} on {panel.label}.</>
            : <>No collector RPC can see holds {subject} on {panel.label} yet.</>}
        </div>
      ) : (
        <div className="rpc-scroll-x" {...scrollRegion("Top fans")} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="rpc-mono" aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "minmax(38px, auto) 1fr minmax(80px, auto) minmax(70px, auto) minmax(96px, auto)", gap: 12, padding: "0 12px", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", minWidth: 480 }}>
            <span>#</span><span>Fan</span>
            <span style={{ textAlign: "right" }}>{panel.units}</span>
            <span style={{ textAlign: "right" }}>Special</span>
            <span style={{ textAlign: "right" }}>FMV</span>
          </div>
          {rows.map((r, i) => {
            const label = r.username ? `@${r.username}` : truncateAddressForDisplay(r.owner)
            const partialFmv = r.fmv_usd != null && r.fmv_items < r.items
            return (
              <Link
                key={r.owner}
                href={topFanHref(panel.urlSlug, r.owner)}
                rel="nofollow"
                className="rpc-card"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "minmax(38px, auto) 1fr minmax(80px, auto) minmax(70px, auto) minmax(96px, auto)", gap: 12, padding: "10px 12px", alignItems: "center", minWidth: 480 }}>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15, color: i < 3 ? "var(--rpc-red-text)" : "var(--rpc-text-muted)" }}>#{i + 1}</span>
                  <span title={r.owner} style={{ fontFamily: r.username ? "var(--font-display)" : "var(--font-mono)", fontWeight: r.username ? 700 : 400, fontSize: r.username ? 14 : 12, color: "var(--rpc-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                  <span className="rpc-mono" style={{ fontSize: 12, textAlign: "right", ...col("items") }}>{fmtCount(r.items)}</span>
                  <span className="rpc-mono" style={{ fontSize: 12, textAlign: "right", ...col("special") }}>{specialTracked ? fmtCount(r.special_items ?? 0) : "—"}</span>
                  <span
                    title={partialFmv ? `${fmtCount(r.fmv_items)} of ${fmtCount(r.items)} priced` : undefined}
                    style={{ fontFamily: "var(--font-display)", fontSize: 15, textAlign: "right", ...col("fmv") }}
                  >{fmtUsd(r.fmv_usd)}{partialFmv ? "*" : ""}</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {data && (
        <div className="rpc-mono" style={{ padding: "10px 4px 0", fontSize: 10, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>
          {data.holders != null && data.holders > 0 ? <>{fmtCount(data.holders)} collectors seen holding {fmtCount(data.items)} {panel.units.toLowerCase()} · </> : null}
          {topFansSourceNote(panel.urlSlug)}
          {specialTracked ? <> Special serials are #1, perfect (#N/N) and jersey-match serials; a {panel.units.toLowerCase().replace(/s$/, "")} that is more than one counts once.</> : null}
          {" "}FMV is each edition&apos;s current FMV; * = not every item has one.
          {updated ? <> Updated {updated}.</> : null}
        </div>
      )}
    </Section>
  )
}
