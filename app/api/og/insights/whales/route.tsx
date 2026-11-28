// app/api/og/insights/whales/route.tsx
//
// Open Graph card for /insights/whales. 1200x630 PNG via next/og. Shows the live
// headline (whales tracked, active this week, spent this week) and the week's top
// spender, read from the public route. A failed read renders "—" for every value,
// never a zero. The hardcoded #E03A2F is the documented Satori exception every
// insights OG route shares (Satori can't resolve CSS vars).

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"
import { usdSignFirst } from "@/lib/usd-format"
import { whaleName, type WhaleLeader } from "@/lib/whale-watch-board"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtMoneyCompact(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtMoneyCompact); if (neg !== null) return neg
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`
  return `$${Math.round(v).toLocaleString("en-US")}`
}

export async function GET(req: NextRequest) {
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)

  let tracked: number | null = null
  let active: number | null = null
  let spend: number | null = null
  let top: WhaleLeader | null = null
  try {
    const origin = new URL(req.url).origin
    const r = await ogFetch(`${origin}/api/public/insights/whales`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      if (typeof j?.tracked_wallets === "number") tracked = j.tracked_wallets
      if (typeof j?.active_7d === "number") active = j.active_7d
      if (typeof j?.spend_7d_usd === "number") spend = j.spend_7d_usd
      const leaders: WhaleLeader[] = Array.isArray(j?.leaders?.["7d"]) ? j.leaders["7d"] : []
      top = leaders[0] ?? null
    }
  } catch {
    /* generic card fallback */
  }

  const stats: { label: string; value: string }[] = [
    { label: "Whales tracked", value: fmtInt(tracked) },
    { label: "Active this week", value: fmtInt(active) },
    { label: "Spent this week", value: fmtMoneyCompact(spend) },
  ]

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#0D0D0D",
          color: "#F1F1F1",
          padding: 60,
          fontFamily: fam.display,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>Public · No signup</div>
        </div>

        <div style={{ marginTop: 22, fontSize: 80, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          WHALE WATCH
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: "rgba(255,255,255,0.65)", lineHeight: 1.35, display: "flex", maxWidth: 1000 }}>
          Who&apos;s spending big on Top Shot, Panini, All Day and more, and what they just bought.
        </div>

        <div style={{ marginTop: 30, display: "flex", gap: 16 }}>
          {stats.map((s, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "20px 24px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderLeft: "4px solid #E03A2F",
                borderRadius: 6,
                minWidth: 250,
              }}
            >
              <div style={{ fontSize: 15, color: "rgba(255,255,255,0.55)", letterSpacing: 1, textTransform: "uppercase", display: "flex" }}>
                {s.label}
              </div>
              <div style={{ fontSize: 46, fontWeight: 800, color: "#E03A2F", display: "flex" }}>{s.value}</div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 18, color: "rgba(255,255,255,0.55)" }}>
          <div style={{ display: "flex" }}>
            {top ? `Top spender this week: ${whaleName(top)} · ${fmtMoneyCompact(top.spent_usd)}` : "Every collection we track"}
          </div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/whales</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  )
}
