// app/api/og/insights/pack-sniper/route.tsx
//
// Open Graph card for /insights/pack-sniper. 1200x630 PNG rendered server-side
// via next/og. Mirrors app/api/og/insights/squeeze/route.tsx — surfaces a few
// live "headline" deals (honest, lottery packs excluded) so the Twitter /
// iMessage / Slack preview is data-rich rather than a logo + tagline. Falls
// back to a generic card if the live feed is empty.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Deal = {
  title: string | null
  tier: string | null
  lowestAsk: number | null
  grossEV: number | null
  liveValueRatio: number | null
}

function tierColor(tier: string): string {
  switch (tier.toUpperCase()) {
    case "LEGENDARY":
      return "#FFD700"
    case "ULTIMATE":
      return "#FF6B35"
    case "RARE":
      return "#818CF8"
    case "FANDOM":
      return "#34D399"
    case "COMMON":
      return "#94A3B8"
    default:
      return "rgba(255,255,255,0.55)"
  }
}

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `$${Math.round(n)}`
}

export async function GET(req: NextRequest) {
  let deals: Deal[] = []
  let total = 0
  try {
    const origin = new URL(req.url).origin
    // Honest deals only (lottery packs hidden), matching the board's default
    // crawlable view. Pull a small page for the headline rows.
    const r = await fetch(
      `${origin}/api/public/insights/pack-sniper?collection=nba-top-shot&include_high_variance=false&limit=3`,
      { cache: "no-store" },
    )
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.deals)) deals = j.deals as Deal[]
      total = Number(j?.meta?.stats?.positiveEv ?? 0)
    }
  } catch {
    /* generic card fallback */
  }

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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 18,
              letterSpacing: 6,
              color: "#E03A2F",
              textTransform: "uppercase",
            }}
          >
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            {total > 0 ? `${total} sealed packs below EV` : "Public · No signup"}
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 84,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.02,
            display: "flex",
          }}
        >
          PACK SNIPER
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
          Sealed packs listed below expected pull value — ranked by live ask vs EV. Lottery packs flagged, not promoted.
        </div>

        <div
          style={{
            marginTop: 34,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {deals.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              Loading the live board…
            </div>
          ) : (
            deals.slice(0, 3).map((d, i) => {
              const tier = (d.tier ?? "—").toUpperCase()
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "16px 22px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderLeft: "4px solid #E03A2F",
                    borderRadius: 6,
                    fontSize: 24,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 760 }}>
                    <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
                      {d.title ?? "—"}
                    </div>
                    <div
                      style={{
                        fontSize: 15,
                        color: "rgba(255,255,255,0.55)",
                        letterSpacing: 1,
                        display: "flex",
                        gap: 10,
                      }}
                    >
                      <span style={{ color: tierColor(tier), textTransform: "uppercase" }}>{tier}</span>
                      <span>·</span>
                      <span>ask {fmtUsd(d.lowestAsk)} · EV {fmtUsd(d.grossEV)}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                      {Number(d.liveValueRatio ?? 0).toFixed(1)}×
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        color: "rgba(255,255,255,0.55)",
                        letterSpacing: 1.5,
                        textTransform: "uppercase",
                        display: "flex",
                      }}
                    >
                      EV / ask
                    </div>
                  </div>
                </div>
              )
            })
          )}
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
          <div style={{ display: "flex" }}>Live Dapper Studio asks · 1.7.0 FMV model</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/pack-sniper</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
