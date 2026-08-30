// app/api/og/insights/market-pulse/route.tsx — OG card for /insights/market-pulse.
// Hardcoded #E03A2F is the documented Satori CSS-var exception. Text nodes wrapped
// in display:flex divs + system-ui font, mirroring the serial-premiums OG route.
import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"

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
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  let rows: Row[] = []
  try {
    const origin = new URL(req.url).origin
    const r = await ogFetch(`${origin}/api/public/insights/market-pulse`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.rows)) rows = (j.rows as Row[]).filter((x) => x.sales_7d > 0).slice(0, 4)
    }
  } catch {
    /* generic fallback */
  }

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0D0D0D", color: "#F1F1F1", padding: "56px 64px", fontFamily: fam.display }}>
        <div style={{ display: "flex", color: "#E03A2F", fontSize: 24, fontWeight: 700, letterSpacing: 2 }}>RIP PACKS CITY · MARKET PULSE</div>
        <div style={{ display: "flex", fontSize: 52, fontWeight: 800, marginTop: 14, lineHeight: 1.05, maxWidth: 920 }}>
          Every Flow collection's market, one view
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 34 }}>
          {rows.length > 0 ? rows.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.04)", borderRadius: 14, padding: "16px 24px", marginBottom: 12 }}>
              <div style={{ display: "flex", fontSize: 28, fontWeight: 700 }}>{r.collection_name}</div>
              <div style={{ display: "flex", fontSize: 22, color: "rgba(255,255,255,0.7)" }}>{usd(r.volume_7d)} · {k(r.sales_7d)} sales · {k(r.buyers_7d)} buyers 7d</div>
            </div>
          )) : (
            <div style={{ display: "flex", fontSize: 26, color: "rgba(255,255,255,0.7)" }}>Volume, sales, buyers and sellers across 24h / 7d / 30d — free.</div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", fontSize: 22, color: "rgba(255,255,255,0.5)" }}>rippackscity.com/insights/market-pulse</div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  )
}
