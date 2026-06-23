// app/api/og/insights/allday-scarcity/route.tsx
//
// OG card for /insights/allday-scarcity. 1200x630 PNG via next/og.
// Pulls live top-3 by scarcity vs family for a data-rich preview.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  mint_count: number | null
  family_avg_mint: number | null
  scarcity_vs_family_pct: number | null
}

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

export async function GET(req: NextRequest) {
  let rows: Row[] = []
  let total = 0
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/allday-scarcity?sort=scarcity&limit=3`, {
      cache: "no-store",
    })
    if (r.ok) {
      const j = await r.json()
      rows = Array.isArray(j?.rows) ? j.rows : []
      total = j?.meta?.total_rows ?? 0
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
            {total > 0 ? `All Day · live` : "Public · No signup"}
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 76,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.02,
            display: "flex",
          }}
        >
          ALL DAY SCARCITY
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
          All Day doesn&apos;t lock or burn. Its scarcity is mint count + set + tier. Editions ranked vs their family&apos;s average.
        </div>

        <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              Loading the live board…
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 760 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
                    {r.player_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: "rgba(255,255,255,0.55)",
                      letterSpacing: 1.5,
                      display: "flex",
                      gap: 12,
                    }}
                  >
                    <span style={{ textTransform: "uppercase" }}>{r.tier ?? "—"}</span>
                    <span>·</span>
                    <span>{(r.set_name ?? "").slice(0, 60)}</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <div style={{ fontSize: 30, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                    {Number(r.scarcity_vs_family_pct ?? 0).toFixed(1)}%
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
                    {fmtInt(r.mint_count)} mint · family avg {fmtInt(Math.round(Number(r.family_avg_mint ?? 0)))}
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
          <div style={{ display: "flex" }}>Family-relative scarcity · Hourly refresh</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/allday-scarcity</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
