// app/api/og/insights/rookies/route.tsx
//
// Open Graph card for /insights/rookies. 1200x630 PNG via next/og.
// Shows the top-3 rookies by GMV for a data-rich preview.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  player_name: string
  gmv_30d: number | null
  avg_price_30d: number | null
  avg_lock_rate_pct: number | null
  max_mint_one_sale_usd: number | null
}

function fmtUsd(n: number | null): string {
  if (n == null || Number(n) === 0) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return `$${v.toFixed(0)}`
}

export async function GET(req: NextRequest) {
  let rows: Row[] = []
  let rookieCount = 0
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/rookies?sort=gmv&limit=3`, {
      cache: "no-store",
    })
    if (r.ok) {
      const j = await r.json()
      rows = Array.isArray(j?.rows) ? j.rows : []
      rookieCount = j?.cohort_stats?.rookie_count ?? 0
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
            {rookieCount > 0 ? `${rookieCount} rookies tracked` : "Public · No signup"}
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 88,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.02,
            display: "flex",
          }}
        >
          2025 ROOKIE INDEX
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
          The 2025 NBA rookie class on Top Shot, ranked by 30-day GMV. Lock rates and mint-#1 trophies.
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
              Loading the live cohort…
            </div>
          ) : (
            rows.slice(0, 3).map((r, i) => (
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 600 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
                    {r.player_name}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: "rgba(255,255,255,0.55)",
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      display: "flex",
                      gap: 14,
                    }}
                  >
                    <span>Lock {Number(r.avg_lock_rate_pct ?? 0).toFixed(0)}%</span>
                    <span>·</span>
                    <span>Avg {fmtUsd(r.avg_price_30d)}</span>
                    <span>·</span>
                    <span>Mint-1 {fmtUsd(r.max_mint_one_sale_usd)}</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                    {fmtUsd(r.gmv_30d)}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: "rgba(255,255,255,0.55)",
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      display: "flex",
                    }}
                  >
                    GMV 30d
                  </div>
                </div>
              </div>
            ))
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
          <div style={{ display: "flex" }}>Series 8 rookie sets · Daily refresh</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/rookies</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
