// app/api/og/insights/new-collectors/route.tsx
//
// Open Graph card for /insights/new-collectors. 1200x630 PNG rendered
// server-side via next/og. Surfaces the live acquisition headline (active
// buyers, new collectors, gateway player) so the Twitter / iMessage / Slack
// preview is data-rich rather than a logo + tagline. Falls back to a generic
// card if the API is empty. The hardcoded #E03A2F is the documented universal
// Satori exception all insights OG routes share (Satori can't resolve CSS vars).

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type SummaryRow = {
  window_label: string
  new_debiased: number
  active_buyers: number
  returning_buyers: number
  market_usd: number
}
type GatewayRow = { kind: string; name: string; buyers: number; rnk: number }

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtMoneyCompact(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`
  return `$${Math.round(v).toLocaleString("en-US")}`
}

export async function GET(req: NextRequest) {
  let summary: SummaryRow | null = null
  let topPlayer: GatewayRow | null = null
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/new-collectors`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.summary)) {
        summary = (j.summary as SummaryRow[]).find((s) => s.window_label === "30d") ?? null
      }
      const players: GatewayRow[] = j?.gateway?.["30d"]?.players ?? j?.gateway?.["90d"]?.players ?? []
      topPlayer = players.find((p) => p.rnk === 1) ?? players[0] ?? null
    }
  } catch {
    /* generic card fallback */
  }

  const stats: { label: string; value: string }[] = [
    { label: "Active buyers · 30d", value: fmtInt(summary?.active_buyers) },
    { label: "New collectors · 30d", value: fmtInt(summary?.new_debiased) },
    { label: "Market · 30d", value: fmtMoneyCompact(summary?.market_usd) },
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
          fontFamily: "system-ui",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            Public · No signup
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 74, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          NEW COLLECTORS
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: 22,
            color: "rgba(255,255,255,0.65)",
            letterSpacing: 0.5,
            lineHeight: 1.35,
            display: "flex",
            maxWidth: 1000,
          }}
        >
          Who&apos;s entering Top Shot, what they buy first, and how cohorts retain.
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
              <div style={{ fontSize: 46, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <div style={{ display: "flex" }}>
            {topPlayer ? `Gateway player: ${topPlayer.name}` : "Buyer-resolved on-chain sales"}
          </div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/new-collectors</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
