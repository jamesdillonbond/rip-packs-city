// PaniniSetSales — the Sales section of a Panini set page (2026-09-30), over panini_set_sales
// (lib/panini/set-sales.ts). Server-rendered; no client JS.

import Link from "next/link"
import { StatCell, fmtCount, fmtUsd } from "@/components/entity/_shared"
import { editionRouteHref } from "@/lib/entity-href"
import type { PaniniSetSales, PaniniSetSale } from "@/lib/panini/set-sales"

/**
 * A Panini set's top and most recent sales on record, with a 30-day summary
 * (lib/panini/set-sales.ts). Counts read "at least" unless every edition of the set has its
 * sales fully on record; a failed read says so and never renders as "no sales".
 */
export default function PaniniSetSalesBody({ collection, res }: { collection: string; res: PaniniSetSales | null }) {
  const muted: React.CSSProperties = { padding: "4px 0 8px", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }
  if (res === null) {
    return <div role="alert" style={muted}>Couldn&rsquo;t load this set&rsquo;s sales — refresh to try again. This is not the same as there being no sales.</div>
  }
  const ptDay = (iso: string) => {
    const t = Date.parse(iso)
    return Number.isNaN(t) ? "—" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
  }
  const complete = res.editions > 0 && res.editionsRead >= res.editions
  const floor = complete ? "" : "≥ "
  const w = res.window30d
  const list = (rows: PaniniSetSale[], label: string) => (
    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 6 }}>{label}</div>
      {rows.length === 0 ? (
        <div style={muted}>No sale of this set&rsquo;s cards on record yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((s, i) => (
            <Link key={`${s.editionKey}-${s.serial}-${s.soldAt}-${i}`} href={editionRouteHref(collection, s.editionKey)} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 8px", border: "1px solid var(--rpc-border)", borderRadius: 6, textDecoration: "none", color: "inherit", minWidth: 0 }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "var(--rpc-text-primary)" }}>
                {s.playerName ?? "—"}{s.serial != null ? ` · #${s.serial}${s.mintCap != null ? `/${s.mintCap}` : ""}` : ""}
              </span>
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)" }}>{fmtUsd(s.amountUsd)} · {ptDay(s.soldAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
  return (
    <>
      <div data-testid="panini-set-sales-summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 10 }}>
        <StatCell label="Sales · 30 days" value={`${floor}${fmtCount(w.sales)}`} sub={`${floor}${fmtCount(w.editionsTraded)} editions traded`} />
        <StatCell label="Volume · 30 days" value={`${floor}${fmtUsd(w.volumeUsd)}`} />
        <StatCell label="Median sale · 30 days" value={fmtUsd(w.medianUsd)} sub={complete ? undefined : "of the sales on record"} />
      </div>
      <div style={muted}>
        {complete
          ? `Every sale of this set's ${fmtCount(res.editions)} editions is on record.`
          : `Sales RPC holds across this set's ${fmtCount(res.editions)} editions — ${fmtCount(res.editionsRead)} of them with every sale on record so far; the rest fill in as the walk reads them, so counts are floors.`}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        {list(res.top, "Top sales")}
        {list(res.recent, "Most recent")}
      </div>
    </>
  )
}
