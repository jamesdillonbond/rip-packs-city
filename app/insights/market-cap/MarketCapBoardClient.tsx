// app/insights/market-cap/MarketCapBoardClient.tsx
//
// Client layer for the Market Cap board. The collection totals and the default
// drill-down arrive server-rendered; this adds the collection + grain switcher,
// which reads /api/public/insights/market-cap via fetchJson (discriminating on
// `ok`, never on an empty body). RPC tokens only — no hardcoded hex.
//
// ⚠ An UNKNOWN cap (no burn source for that collection) renders as "Unknown" with
// the minted-supply upper bound beside it — never as $0 and never as the bound.
"use client"

import { useState, type CSSProperties } from "react"
import Link from "next/link"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { sectionEmptyCopy } from "@/lib/entity/section-empty-copy"
import {
  GROUP_LABELS,
  METHOD_NOTE,
  collectionDisplayName,
  fmtCount,
  fmtUsdCompact,
  highConfidenceShare,
  sevenDayChange,
  rowDetail,
  rowHref,
  rowLabel,
  type MarketCapBoard,
  type MarketCapGroup,
  type MarketCapRow,
} from "@/lib/insights/market-cap-board"

const DRILL_GROUPS: MarketCapGroup[] = ["player", "team", "set", "series", "tier", "badge", "edition"]

function thStyle(align: "left" | "right"): CSSProperties {
  return { textAlign: align, padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
}
function tdStyle(align: "left" | "right"): CSSProperties {
  return { textAlign: align, padding: "12px", borderBottom: "1px solid var(--rpc-border-subtle)", verticalAlign: "middle" }
}
function pillStyle(active: boolean): CSSProperties {
  return {
    padding: "6px 12px", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer",
    borderRadius: 4, border: `1px solid ${active ? "var(--rpc-red)" : "var(--rpc-border)"}`,
    background: active ? "var(--rpc-red-bg)" : "transparent",
    color: active ? "var(--rpc-red)" : "var(--rpc-text-secondary)",
  }
}

function fmtPct(share: number | null): string {
  if (share == null || !Number.isFinite(share)) return "—"
  return `${Math.round(share * 100)}%`
}

function fmtChange(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "—"
  const v = Math.round(x * 1000) / 10
  return `${v > 0 ? "+" : ""}${v}%`
}

/** The cap cell: a known number, or an explicit "Unknown" carrying its upper bound. */
function CapCell({ r }: { r: MarketCapRow }) {
  if (r.mcap_usd == null) {
    return (
      <span>
        <span className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>Unknown</span>
        {r.mcap_minted_usd != null && (
          <span className="rpc-mono" style={{ display: "block", fontSize: 10, color: "var(--rpc-text-ghost)" }}>
            ≤ {fmtUsdCompact(r.mcap_minted_usd)} on minted supply
          </span>
        )}
      </span>
    )
  }
  return (
    <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, color: "var(--rpc-text-primary)" }}>
      {fmtUsdCompact(r.mcap_usd)}
    </span>
  )
}

function Coverage({ r }: { r: MarketCapRow }) {
  if (r.editions_supply_known === r.editions) return <>{fmtCount(r.editions)}</>
  return (
    <span title="Editions with a known burned / issuer-held split, of all editions in the group">
      {fmtCount(r.editions_supply_known)}
      <span style={{ color: "var(--rpc-text-ghost)" }}> / {fmtCount(r.editions)}</span>
    </span>
  )
}

function Label({ r, group }: { r: MarketCapRow; group: MarketCapGroup }) {
  const href = rowHref(r, group)
  const label = rowLabel(r, group)
  const detail = rowDetail(r, group)
  const text = (
    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--rpc-text-primary)" }}>{label}</span>
  )
  return (
    <span>
      {href ? <Link href={href} style={{ textDecoration: "none" }}>{text}</Link> : text}
      {detail && (
        <span className="rpc-mono" style={{ display: "block", marginTop: 2, fontSize: 10, color: "var(--rpc-text-muted)" }}>{detail}</span>
      )}
    </span>
  )
}

function CollectionsTable({ rows }: { rows: MarketCapRow[] }) {
  return (
    <div className="rpc-scroll-x" style={{ marginTop: 14, overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 820, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle("left")}>Collection</th>
            <th style={thStyle("right")}>Market cap</th>
            <th style={thStyle("right")}>7d</th>
            <th style={thStyle("right")}>High-confidence</th>
            <th style={thStyle("right")}>Collector-held</th>
            <th style={thStyle("right")}>Burned</th>
            <th style={thStyle("right")}>Issuer-held</th>
            <th style={thStyle("right")}>Minted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.collection_slug}>
              <td style={tdStyle("left")}><Label r={r} group="collection" /></td>
              <td style={tdStyle("right")}><CapCell r={r} /></td>
              <td style={tdStyle("right")} className="rpc-mono" title={r.mcap_usd_7d_ago == null ? "Daily history began Oct 3, 2026" : undefined}>
                {fmtChange(sevenDayChange(r.mcap_usd, r.mcap_usd_7d_ago))}
              </td>
              <td style={tdStyle("right")} className="rpc-mono">{fmtPct(highConfidenceShare(r))}</td>
              <td style={tdStyle("right")} className="rpc-mono">{fmtCount(r.collector_held)}</td>
              <td style={tdStyle("right")} className="rpc-mono">{fmtCount(r.burned)}</td>
              <td style={tdStyle("right")} className="rpc-mono">{fmtCount(r.issuer_held)}</td>
              <td style={tdStyle("right")} className="rpc-mono">{fmtCount(r.minted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DrillTable({ rows, group }: { rows: MarketCapRow[]; group: MarketCapGroup }) {
  return (
    <div className="rpc-scroll-x" style={{ marginTop: 14, overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle("right")}>#</th>
            <th style={thStyle("left")}>{GROUP_LABELS[group].replace(/s$/, "")}</th>
            <th style={thStyle("right")}>Market cap</th>
            <th style={thStyle("right")}>High-confidence</th>
            <th style={thStyle("right")}>Collector-held</th>
            <th style={thStyle("right")}>Editions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.collection_slug}|${r.group_key}`}>
              <td style={tdStyle("right")} className="rpc-mono">{i + 1}</td>
              <td style={tdStyle("left")}><Label r={r} group={group} /></td>
              <td style={tdStyle("right")}><CapCell r={r} /></td>
              <td style={tdStyle("right")} className="rpc-mono">{fmtPct(highConfidenceShare(r))}</td>
              <td style={tdStyle("right")} className="rpc-mono">{fmtCount(r.collector_held)}</td>
              <td style={tdStyle("right")} className="rpc-mono"><Coverage r={r} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function MarketCapBoardClient({
  initialCollections,
  initialCollectionsFailed = false,
  initialDrill,
  initialDrillFailed = false,
  initialFetchedAt,
}: {
  initialCollections: MarketCapBoard
  /** The SERVER read failed — the fallback is an empty board, indistinguishable from a real one. */
  initialCollectionsFailed?: boolean
  initialDrill: MarketCapBoard
  initialDrillFailed?: boolean
  /** ⚠ `null` when the server read FAILED; FreshnessStamp renders "—". */
  initialFetchedAt: string | null
}) {
  const [drill, setDrill] = useState<MarketCapBoard>(initialDrill)
  const [drillFailed, setDrillFailed] = useState(initialDrillFailed)
  const [loading, setLoading] = useState(false)
  const [collection, setCollection] = useState<string>(initialDrill.collection ?? "nba_top_shot")
  const [group, setGroup] = useState<MarketCapGroup>(initialDrill.group)

  const collectionRows = initialCollections.rows
  const collectionOptions = collectionRows.length > 0
    ? collectionRows.map((r) => r.collection_slug)
    : [initialDrill.collection ?? "nba_top_shot"]

  async function load(nextCollection: string, nextGroup: MarketCapGroup) {
    setCollection(nextCollection)
    setGroup(nextGroup)
    setLoading(true)
    const url = `/api/public/insights/market-cap?group=${encodeURIComponent(nextGroup)}&collection=${encodeURIComponent(nextCollection)}&limit=50`
    const res = await fetchJson<{ rows: MarketCapRow[] }>(url)
    if (res.ok && res.json && Array.isArray(res.json.rows)) {
      setDrill({ group: nextGroup, collection: nextCollection, rows: res.json.rows })
      setDrillFailed(false)
    } else {
      // Keep the grain the reader asked for, with NO rows from another grain under it.
      setDrill({ group: nextGroup, collection: nextCollection, rows: [] })
      setDrillFailed(true)
    }
    setLoading(false)
  }

  const known = collectionRows.filter((r) => r.mcap_usd != null)
  const knownTotal = known.reduce((s, r) => s + (r.mcap_usd ?? 0), 0)
  const unknownCount = collectionRows.length - known.length

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px 60px" }}>
      <div className="rpc-mono" style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--rpc-red)", textTransform: "uppercase" }}>
        Rip Packs City · Insights
      </div>
      <h1 style={{ margin: "10px 0 0", fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 40, letterSpacing: "0.03em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1.03 }}>
        Market Cap
      </h1>
      <p style={{ margin: "10px 0 0", maxWidth: 760, fontSize: 15, lineHeight: 1.5, color: "var(--rpc-text-secondary)" }}>
        What every collection, player, team, set and badge is worth on the{" "}
        <strong style={{ color: "var(--rpc-text-primary)" }}>supply collectors actually hold</strong> — fair market value
        times circulating copies, with burned Moments and unopened or unreleased packs taken out.
      </p>

      <div className="rpc-mono" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 16, fontSize: 11, color: "var(--rpc-text-muted)" }}>
        {known.length > 0 && (
          <span>
            {fmtUsdCompact(knownTotal)} across {known.length} collection{known.length === 1 ? "" : "s"} with a known supply split
            {unknownCount > 0 ? ` · ${unknownCount} unknown` : ""}
          </span>
        )}
        <span>· Refreshed <FreshnessStamp iso={initialFetchedAt} /></span>
      </div>

      <h2 style={{ margin: "28px 0 0", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
        By collection
      </h2>
      {collectionRows.length === 0 ? (
        <div className="rpc-card" style={{ marginTop: 14, padding: 24, textAlign: "center", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
          {sectionEmptyCopy(!initialCollectionsFailed, "Collection market caps", "No priced collections yet.")}
        </div>
      ) : (
        <CollectionsTable rows={collectionRows} />
      )}

      <h2 style={{ margin: "32px 0 0", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
        Drill down
      </h2>
      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Collection{" "}
          <select
            value={collection}
            onChange={(e) => load(e.target.value, group)}
            disabled={loading}
            className="rpc-mono"
            style={{ marginLeft: 6, padding: "6px 8px", fontSize: 12, borderRadius: 4, border: "1px solid var(--rpc-border)", background: "var(--rpc-surface)", color: "var(--rpc-text-primary)" }}
          >
            {collectionOptions.map((slug) => (
              <option key={slug} value={slug}>{collectionDisplayName(slug)}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {DRILL_GROUPS.map((g) => (
          <button key={g} type="button" onClick={() => load(collection, g)} disabled={loading} className="rpc-mono" style={pillStyle(group === g)}>
            {GROUP_LABELS[g]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="rpc-card" style={{ marginTop: 14, padding: 24, textAlign: "center", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
          Loading…
        </div>
      ) : drill.rows.length === 0 ? (
        <div className="rpc-card" style={{ marginTop: 14, padding: 24, textAlign: "center", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
          {sectionEmptyCopy(
            !drillFailed,
            `${GROUP_LABELS[drill.group]} market caps`,
            `No ${GROUP_LABELS[drill.group].toLowerCase()} carry this field in ${collectionDisplayName(drill.collection ?? collection)}.`,
          )}
        </div>
      ) : (
        <DrillTable rows={drill.rows} group={drill.group} />
      )}

      <p className="rpc-mono" style={{ marginTop: 24, maxWidth: 820, fontSize: 11, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>
        {METHOD_NOTE} &quot;High-confidence&quot; is the share of the market cap priced from recent sales at high or medium
        confidence; the rest leans on asks or thin history.
      </p>
    </div>
  )
}
