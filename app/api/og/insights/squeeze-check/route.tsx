// app/api/og/insights/squeeze-check/route.tsx
//
// OG card for /insights/squeeze-check. 1200x630 PNG via next/og. Static —
// the tool is wallet-specific so we don't pull live data; we lead with
// the "paste your wallet" hook instead.

import { ImageResponse } from "next/og"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
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
            Tool · No signup
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 96,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.0,
            display: "flex",
          }}
        >
          WHAT&apos;S LIQUID
        </div>
        <div
          style={{
            fontSize: 96,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.0,
            display: "flex",
          }}
        >
          IN YOUR BAG?
        </div>

        <div
          style={{
            marginTop: 24,
            fontSize: 24,
            color: "rgba(255,255,255,0.65)",
            letterSpacing: 0.5,
            lineHeight: 1.35,
            display: "flex",
            maxWidth: 1000,
          }}
        >
          Paste your Flow wallet. We&apos;ll show you how much of your Top Shot collection is actually liquid vs sitting in challenge-locked or burned editions.
        </div>

        <div
          style={{
            marginTop: 40,
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          {[
            { label: "LIQUID", border: "#34D399" },
            { label: "MODERATE", border: "#F59E0B" },
            { label: "SQUEEZED", border: "#FB923C" },
            { label: "EXTREME", border: "#E03A2F" },
          ].map((b) => (
            <div
              key={b.label}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "20px 26px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderLeft: `4px solid ${b.border}`,
                borderRadius: 6,
                minWidth: 200,
              }}
            >
              <div
                style={{
                  fontSize: 16,
                  letterSpacing: 3,
                  color: "rgba(255,255,255,0.55)",
                  textTransform: "uppercase",
                  display: "flex",
                }}
              >
                {b.label}
              </div>
              <div
                style={{
                  fontSize: 26,
                  color: "rgba(255,255,255,0.85)",
                  letterSpacing: 0.5,
                  display: "flex",
                }}
              >
                bucket
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
          <div style={{ display: "flex" }}>Top Shot only · Personal scope</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/squeeze-check</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
