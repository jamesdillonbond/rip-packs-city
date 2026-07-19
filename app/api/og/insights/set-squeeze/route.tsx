// app/api/og/insights/set-squeeze/route.tsx
//
// OG card for /insights/set-squeeze. 1200x630 PNG via next/og. Pulls live
// top-3 sets by avg-squeeze for a data-rich preview.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  set_name: string | null
  set_tier: string | null
  series: number | null
  editions_covered: number | null
  avg_squeeze_pct: number | null
  total_buyable: number | null
  total_circ: number | null
}

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

function tierColor(tier: string | null): string {
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
  let total = 0
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/set-squeeze?sort=squeeze&limit=3`, {
      cache: "no-store",
    })
    if (r.ok) {
      const j = await r.json()
      rows = Array.isArray(j?.rows) ? j.rows : []
      total = j?.meta?.total_rows ?? 0
    }
    if (total < 3) {
      const r2 = await fetch(`${origin}/api/public/insights/set-squeeze?sort=squeeze&limit=100`, {
        cache: "no-store",
      })
      if (r2.ok) {
        const j2 = await r2.json()
        total = j2?.meta?.total_rows ?? total
      }
    }
  } catch {
    /* fallback */
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
            {total > 0 ? `${total} sets ranked` : "Public · No signup"}
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
          SET SQUEEZE BOARD
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
          Top Shot sets ranked by avg lock + burn across their editions. If you&apos;re completing a set, how scarce is the whole journey?
        </div>

        <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>Loading the live board…</div>
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 760 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>{r.set_name ?? "—"}</div>
                  <div
                    style={{
                      fontSize: 14,
                      color: "rgba(255,255,255,0.55)",
                      letterSpacing: 1.5,
                      display: "flex",
                      gap: 12,
                    }}
                  >
                    <span style={{ color: tierColor(r.set_tier), textTransform: "uppercase" }}>{r.set_tier ?? "—"}</span>
                    <span>·</span>
                    <span>S{r.series ?? "—"}</span>
                    <span>·</span>
                    <span>{fmtInt(r.editions_covered)} eds</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <div style={{ fontSize: 30, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                    {Number(r.avg_squeeze_pct ?? 0).toFixed(1)}%
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
                    {fmtInt(r.total_buyable)} of {fmtInt(r.total_circ)} buyable
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
          <div style={{ display: "flex" }}>Per-set scarcity · Min 5 covered editions</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/set-squeeze</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
