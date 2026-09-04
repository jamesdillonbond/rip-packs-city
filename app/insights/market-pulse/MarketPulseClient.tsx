"use client"

// app/insights/market-pulse/MarketPulseClient.tsx
//
// Client for /insights/market-pulse. Renders the server's rows immediately (SEO)
// with a 24h / 7d / 30d window toggle. Pure presentation over the windowed pulse
// — no refetch needed (all three windows arrive in one payload).

import { useMemo, useState } from "react"
import Link from "next/link"
import type { MarketPulseRow } from "@/lib/market-pulse-board"
import { fromDbSlug } from "@/lib/collections"

type Win = "24h" | "7d" | "30d"
const WINDOWS: Win[] = ["24h", "7d", "30d"]

function usd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`
  if (v >= 1) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}
function cnt(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`
  return v.toLocaleString("en-US")
}

function pick(r: MarketPulseRow, w: Win) {
  if (w === "24h") return { volume: r.volume_24h, sales: r.sales_24h, buyers: r.buyers_24h, sellers: null as number | null, top: r.top_sale_24h }
  if (w === "7d") return { volume: r.volume_7d, sales: r.sales_7d, buyers: r.buyers_7d, sellers: r.sellers_7d, top: r.top_sale_7d }
  return { volume: r.volume_30d, sales: r.sales_30d, buyers: r.buyers_30d, sellers: null as number | null, top: r.top_sale_30d }
}

export default function MarketPulseClient({ initialRows, fetchedAt }: { initialRows: MarketPulseRow[]; fetchedAt: string }) {
  const [win, setWin] = useState<Win>("7d")

  const ranked = useMemo(() => {
    return [...initialRows].sort((a, b) => pick(b, win).volume - pick(a, win).volume)
  }, [initialRows, win])

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px 80px" }}>
      <header style={{ marginBottom: 20 }}>
        <div className="rpc-label" style={{ color: "var(--rpc-red)", letterSpacing: "0.12em", fontSize: 11 }}>SURFACE · LIVE</div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 5vw, 44px)", margin: "6px 0 10px", lineHeight: 1.02 }}>Market Pulse</h1>
        <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 720, fontSize: 15, lineHeight: 1.5 }}>
          Secondary-market health for every Flow collection in one view — volume, sales, buyers and sellers.
          Top Shot and dapper.market show one league at a time; this shows all five.
        </p>
      </header>

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => setWin(w)}
            className="rpc-mono"
            style={{
              padding: "8px 18px", borderRadius: 999, fontSize: 13, cursor: "pointer",
              border: `1px solid ${win === w ? "var(--rpc-red)" : "var(--rpc-border)"}`,
              background: win === w ? "var(--rpc-red)" : "transparent",
              color: win === w ? "#fff" : "var(--rpc-text-secondary)",
            }}
          >
            {w}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
        {ranked.map((r) => {
          const d = pick(r, win)
          // Canonical URL slug (registry) so UFC → "ufc", not the "ufc-strike"
          // alias a naive underscore→hyphen replace on the sales-table slug
          // would emit — a self-canonicalizing duplicate /overview link.
          const collSlug = fromDbSlug(r.slug) ?? r.slug.replace(/_/g, "-")
          return (
            <div key={r.slug} style={{ border: "1px solid var(--rpc-border)", borderRadius: 12, padding: 18, background: "var(--rpc-surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                <Link href={`/${collSlug}/overview`} style={{ fontFamily: "var(--font-display)", fontSize: 20, color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                  {r.collection_name}
                </Link>
                {d.top != null && <span style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>top {usd(d.top)}</span>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: d.sellers != null ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr", gap: 10 }}>
                <Stat label="Volume" value={usd(d.volume)} big />
                <Stat label="Sales" value={cnt(d.sales)} />
                <Stat label="Buyers" value={cnt(d.buyers)} />
                {d.sellers != null && <Stat label="Sellers" value={cnt(d.sellers)} />}
              </div>
            </div>
          )
        })}
      </div>

      <p style={{ marginTop: 18, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
        Secondary-market sales across all indexed sources (not just one marketplace). Buyers/sellers are distinct wallets in the window.{" "}
        Updated {new Date(fetchedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET.{" "}
        See the biggest individual sales on <Link href="/insights/top-sales" style={{ color: "var(--rpc-red)" }}>Top Sales</Link>.
      </p>
    </main>
  )
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div className="rpc-mono" style={{ fontSize: big ? 20 : 16, fontWeight: 800, color: big ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)" }}>{value}</div>
    </div>
  )
}
