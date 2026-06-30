// app/api/og/insights/topshot-pack-market/route.tsx
//
// Open Graph card for /insights/topshot-pack-market. 1200x630 PNG via next/og.
// Pulls the live qualifying-dist count from the public API so the preview
// reflects how much of the board has populated.
//
// Note: next/og ImageResponse renders inline styles only (no CSS vars), so the
// brand red is the literal #E03A2F here — the documented exception to the
// no-hardcoded-token rule (same as other /api/og/* cards).

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  let qualifying: number | null = null
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/topshot-pack-market`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      qualifying = j?.market?.qualifying_dists ?? null
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            NBA Top Shot · Public
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 84, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          TOP SHOT PACK MARKET
        </div>
        <div style={{ marginTop: 12, fontSize: 24, color: "rgba(255,255,255,0.68)", letterSpacing: 0.5, lineHeight: 1.35, display: "flex", maxWidth: 1040 }}>
          What a sealed pack actually resells for — above or below the price it dropped at, from the complete sale history.
        </div>

        <div style={{ marginTop: 48, display: "flex", gap: 24 }}>
          {[
            { label: "SEALED RESALE", value: "vs retail" },
            { label: "DISCOUNT · PREMIUM", value: "ranked" },
            { label: "QUALIFYING DISTS", value: qualifying == null ? "—" : String(qualifying) },
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
              <div style={{ fontSize: 13, letterSpacing: 3, color: "rgba(255,255,255,0.55)", textTransform: "uppercase", display: "flex" }}>
                {k.label}
              </div>
              <div style={{ fontSize: 44, fontWeight: 800, color: "#E03A2F", display: "flex" }}>{k.value}</div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 18, color: "rgba(255,255,255,0.55)" }}>
          <div style={{ display: "flex" }}>Sealed-pack secondary market · 5+ sales to qualify</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/topshot-pack-market</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
