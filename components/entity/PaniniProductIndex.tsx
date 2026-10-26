// components/entity/PaniniProductIndex.tsx
//
// The Panini products index (/panini-blockchain/product, 2026-10-25) — every product page, grouped by sport,
// biggest first. Data: listPaniniProducts() (panini_product_rollup, newest run). Pure props for testing.
// Counts are editions RPC has SEEN (listing-gated); sales are ON RECORD and lag; no FMV tier anywhere.

import Link from "next/link"
import type { CSSProperties } from "react"
import { fmtUsd, fmtCount } from "@/components/entity/_shared"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { paniniProductHref } from "@/lib/panini/product-url"

export interface PaniniProductIndexRow {
  name: string
  slug: string
  sport: string | null
  editions: number
  sets: number
  fmv_total_usd: number | null
  listed_editions: number
  sales_30d: number
}

const cell: CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }

export default function PaniniProductIndex({
  collection,
  collectionLabel,
  rows,
}: {
  collection: string
  collectionLabel: string
  /** null = the read failed. */
  rows: PaniniProductIndexRow[] | null
}) {
  const groups = new Map<string, PaniniProductIndexRow[]>()
  for (const r of rows ?? []) {
    const k = r.sport ?? "Other"
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  const ordered = [...groups.entries()]
    .map(([sport, list]) => [sport, [...list].sort((a, b) => b.editions - a.editions || a.name.localeCompare(b.name))] as const)
    .sort((a, b) => b[1].reduce((n, r) => n + r.editions, 0) - a[1].reduce((n, r) => n + r.editions, 0))
  return (
    <div data-testid="panini-product-index">
      <Breadcrumbs items={[{ name: collectionLabel, href: `/${collection}/overview` }, { name: "Products" }]} />
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(24px, 5vw, 36px)", letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "8px 0 6px" }}>
        Panini Products
      </h1>
      <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)", marginBottom: 12 }}>
        Every Panini product RPC has seen a card from — its sets, values, sales and packs.
      </div>
      <PaniniCoverageNote coverage={null} />
      {rows === null ? (
        <div data-testid="panini-product-index-failed" className="rpc-mono" style={{ marginTop: 16, padding: "12px 14px", border: "1px dashed var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-muted)", fontSize: 11 }}>
          Products couldn&apos;t be loaded — refresh to try again.
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="panini-product-index-empty" className="rpc-mono" style={{ marginTop: 16, fontSize: 11, color: "var(--rpc-text-muted)" }}>
          No product has been counted yet — the list refreshes hourly.
        </div>
      ) : (
        ordered.map(([sport, list]) => (
          <section key={sport} className="rpc-card" style={{ padding: 18, marginTop: 14 }}>
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 10px" }}>
              {sport}
            </h2>
            <div className="rpc-scroll-x" {...scrollRegion("Products in this sport")}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
                <thead>
                  <tr>
                    <th scope="col" style={head}>Product</th>
                    <th scope="col" style={head}>Editions</th>
                    <th scope="col" style={head}>Sets</th>
                    <th scope="col" style={head}>Listed</th>
                    <th scope="col" style={head}>FMV total</th>
                    <th scope="col" style={head}>Sales 30d</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.slug}>
                      <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                        <Link href={paniniProductHref(collection, r.slug)} style={{ color: "inherit" }}>{r.name}</Link>
                      </td>
                      <td style={cell}>{fmtCount(r.editions)}</td>
                      <td style={cell}>{fmtCount(r.sets)}</td>
                      <td style={cell}>{fmtCount(r.listed_editions)}</td>
                      <td style={cell}>{fmtUsd(r.fmv_total_usd)}</td>
                      <td style={cell}>{fmtCount(r.sales_30d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      <div className="rpc-mono" style={{ marginTop: 10, fontSize: 11, color: "var(--rpc-text-muted)" }}>
        Sales are those on record; Panini sales reach RPC hours to days after they happen.
      </div>
    </div>
  )
}
