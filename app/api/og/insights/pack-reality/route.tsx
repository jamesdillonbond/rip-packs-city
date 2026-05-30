// app/api/og/insights/pack-reality/route.tsx
//
// Open Graph card for /insights/pack-reality. 1200x630 PNG via next/og.
// Pulls live KPIs from the stats view so the preview is data-rich.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Stats = {
  rips_60d: number | null
  zero_value_pct: number | null
  mean_pull_value_usd: number | null
  rips_over_100_pct: number | null
} | null

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtPct(n: number | null): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(0)}%`
}
function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  return `$${Number(n).toFixed(2)}`
}

export async function GET(req: NextRequest) {
  let stats: Stats = null
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/pack-reality?limit=1`, {
      cache: "no-store",
    })
    if (r.ok) {
      const j = await r.json()
      stats = j?.stats ?? null
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
            {stats?.rips_60d ? `${fmtInt(stats.rips_60d)} rips, 60d` : "Public · No signup"}
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 90,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.02,
            display: "flex",
          }}
        >
          PACK REALITY
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
          We audited every Top Shot pack ripped in the last 60 days. Median pull value $0.
        </div>

        <div
          style={{
            marginTop: 50,
            display: "flex",
            gap: 24,
          }}
        >
          {[
            { label: "DELIVERED $0", value: fmtPct(stats?.zero_value_pct ?? null) },
            { label: "MEAN VALUE", value: fmtUsd(stats?.mean_pull_value_usd ?? null) },
            { label: "OVER $100", value: `${(stats?.rips_over_100_pct ?? 0).toFixed(2)}%` },
          ].map((k) => (
            <div
              key={k.label}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "18px 22px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderLeft: "4px solid #E03A2F",
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  letterSpacing: 3,
                  color: "rgba(255,255,255,0.55)",
                  textTransform: "uppercase",
                  display: "flex",
                }}
              >
                {k.label}
              </div>
              <div style={{ fontSize: 48, fontWeight: 800, color: "#E03A2F", display: "flex" }}>{k.value}</div>
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
          <div style={{ display: "flex" }}>Honest pack ranker · Confidence flags</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/pack-reality</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
