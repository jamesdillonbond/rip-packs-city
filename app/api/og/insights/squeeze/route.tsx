// app/api/og/insights/squeeze/route.tsx
//
// Open Graph card for /insights/squeeze. 1200x630 PNG rendered server-side
// via next/og. Falls back to a generic card if the squeeze API is empty.
//
// Surfaces three live "headline" examples so the Twitter / iMessage / Slack
// preview is data-rich rather than a logo + tagline — per the 2026-05-29
// launch plan ("OG cards rendering" is a Week 1 success metric).

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation: number | null
  effectively_buyable: number | null
  squeeze_pct: number | null
}

function normalizeTier(t: string | null): string {
  if (!t) return "—"
  return t.replace(/^MOMENT_TIER_/, "")
}

function tierColor(tier: string): string {
  switch (tier) {
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

export async function GET(req: NextRequest) {
  let rows: Row[] = []
  let totalEditions = 0
  try {
    const origin = new URL(req.url).origin
    // Pull a small page sorted by squeeze%. Cache the OG result for 5 min
    // (matches the API's own Cache-Control: s-maxage=300).
    const r = await fetch(`${origin}/api/public/insights/squeeze?sort=squeeze&limit=3`, {
      cache: "no-store",
    })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.rows)) rows = j.rows as Row[]
      // Pull a second, count-only response so the header number reflects the
      // full board, not just the top-3 page.
      try {
        const r2 = await fetch(`${origin}/api/public/insights/squeeze?sort=squeeze&limit=200`, {
          cache: "no-store",
        })
        if (r2.ok) {
          const j2 = await r2.json()
          totalEditions = j2?.meta?.total_rows ?? 0
        }
      } catch {
        /* count fallback handled below */
      }
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
            {totalEditions > 0 ? `${totalEditions} editions squeezed 50%+` : "Public · No signup"}
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 78,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.02,
            display: "flex",
          }}
        >
          LOCK-RATE SQUEEZE BOARD
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
          Top Shot displays circulation. We display effective supply — what&apos;s actually buyable after locks + burns.
        </div>

        <div
          style={{
            marginTop: 34,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {rows.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              Loading the live board…
            </div>
          ) : (
            rows.slice(0, 3).map((r, i) => {
              const tier = normalizeTier(r.tier)
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
                      {r.player_name ?? "—"}
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
                      <span>{r.set_name ?? "—"}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                      {Math.round(Number(r.squeeze_pct ?? 0))}%
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
                      {r.effectively_buyable ?? 0} of {r.circulation ?? 0} buyable
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
          <div style={{ display: "flex" }}>Hourly refresh · 1.7.0 FMV model</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/squeeze</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
