"use client"

// components/entity/PaniniPropertyProducts.tsx
//
// A league / brand's Panini products, with a brand-line filter (2026-11-26): Prizm · Select · Donruss Optic …
// The line is read from the product's own name (lib/panini/brand-line.ts); a product whose name carries no
// line keeps a dash and is shown only under "All". The chips appear only when there are two or more lines.

import Link from "next/link"
import { useMemo, useState, type CSSProperties } from "react"
import { fmtCount, fmtUsd } from "@/components/entity/_shared"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { brandLineOptions, paniniBrandLine } from "@/lib/panini/brand-line"
import { paniniProductHref } from "@/lib/panini/product-url"

export interface PropertyProductRow {
  slug: string
  name: string
  editions: number
  sets: number
  listed_editions: number
  fmv_total_usd: number | null
  sales_30d: number
}

const cell: CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }
const chip = (on: boolean): CSSProperties => ({
  fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer",
  padding: "6px 10px", borderRadius: 6, minHeight: 32, whiteSpace: "nowrap",
  background: on ? "var(--rpc-red-bg)" : "var(--rpc-surface)",
  border: `1px solid ${on ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
  color: "var(--rpc-text-primary)",
})

export default function PaniniPropertyProducts({ collection, products }: { collection: string; products: PropertyProductRow[] }) {
  const [line, setLine] = useState("")
  const options = useMemo(() => brandLineOptions(products.map((p) => p.name)), [products])
  const rows = line ? products.filter((p) => paniniBrandLine(p.name) === line) : products
  return (
    <>
      {options.length >= 2 ? (
        <div role="group" aria-label="Brand line" data-testid="panini-property-lines" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <button type="button" aria-pressed={line === ""} onClick={() => setLine("")} style={chip(line === "")}>All · {fmtCount(products.length)}</button>
          {options.map((o) => (
            <button key={o.line} type="button" aria-pressed={line === o.line} onClick={() => setLine(o.line)} style={chip(line === o.line)}>
              {o.line} · {fmtCount(o.products)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rpc-scroll-x" {...scrollRegion("Products")}>
        <table data-testid="panini-property-products" style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
          <thead>
            <tr>
              <th scope="col" style={head}>Product</th>
              <th scope="col" style={head}>Line</th>
              <th scope="col" style={head}>Cards</th>
              <th scope="col" style={head}>Sets</th>
              <th scope="col" style={head}>Listed</th>
              <th scope="col" style={head}>FMV total</th>
              <th scope="col" style={head}>Sales 30d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.slug}>
                <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                  <Link href={paniniProductHref(collection, r.slug)} style={{ color: "inherit" }}>{r.name}</Link>
                </td>
                <td style={cell}>{paniniBrandLine(r.name) ?? "—"}</td>
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
    </>
  )
}
