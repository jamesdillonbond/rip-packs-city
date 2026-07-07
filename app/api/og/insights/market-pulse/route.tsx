// app/api/og/insights/market-pulse/route.tsx — OG card for /insights/market-pulse.
// Hardcoded #E03A2F is the documented Satori CSS-var exception.
import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = { collection_name: string; volume_7d: number; sales_7d: number; buyers_7d: number }

function usd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`
  return `$${(n ?? 0).toFixed(0)}`
}
function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`
}

export async function GET(req: NextRequest) {
  let rows: Row[] = []
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/market-pulse`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.rows)) rows = (j.rows as Row[]).filter((x) => x.sales_7d > 0).slice(0, 4)
    }
  } catch {
    /* generic fallback */
  }

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0D0D0D", color: "#F1F1F1", padding: "56px 64px", fontFamily: "sans-serif" }}>
        <div style={{ color: "#E03A2F", fontSize: 24, fontWeight: 700, letterSpacing: 2 }}>RIP PACKS CITY · MARKET PULSE</div>
        <div style={{ fontSize: 52, fontWeight: 800, marginTop: 14, lineHeight: 1.05, maxWidth: 920 }}>
          Every Flow collection&apos;s market, one view
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 34 }}>
          {rows.length > 0 ? rows.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.04)", borderRadius: 14, padding: "16px 24px" }}>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{r.collection_name}</div>
              <div style={{ fontSize: 22, color: "rgba(255,255,255,0.7)" }}>{usd(r.volume_7d)} · {k(r.sales_7d)} sales · {k(r.buyers_7d)} buyers <span style={{ color: "rgba(255,255,255,0.4)" }}>7d</span></div>
            </div>
          )) : (
            <div style={{ fontSize: 26, color: "rgba(255,255,255,0.7)" }}>Volume, sales, buyers and sellers across 24h / 7d / 30d — free.</div>
          )}
        </div>
        <div style={{ marginTop: "auto", fontSize: 22, color: "rgba(255,255,255,0.5)" }}>rippackscity.com/insights/market-pulse</div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
