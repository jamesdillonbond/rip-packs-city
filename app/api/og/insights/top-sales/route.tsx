// app/api/og/insights/top-sales/route.tsx
//
// Open Graph card for /insights/top-sales. 1200x630 PNG rendered server-side
// via next/og. Surfaces the top sales by price (with buyer/seller @handles) so
// the Twitter / iMessage / Slack preview is data-rich rather than a logo +
// tagline. Falls back to a generic card if the API is empty.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  price_usd: number | null
  buyer_name: string | null
  seller_name: string | null
}

function tierColor(tier: string | null): string {
  const t = (tier ?? "").replace(/^MOMENT_TIER_/, "")
  switch (t) {
    case "LEGENDARY":
      return "#FFD700"
    case "ULTIMATE":
      return "#FF6B35"
    case "RARE":
      return "#818CF8"
    default:
      return "rgba(255,255,255,0.55)"
  }
}

function fmtPrice(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(0)}`
}

export async function GET(req: NextRequest) {
  let rows: Row[] = []
  let total = 0
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/top-sales?window=7d&sort=price&limit=3`, {
      cache: "no-store",
    })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.rows)) rows = j.rows as Row[]
      total = j?.meta?.total_rows ?? 0
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
            {total > 0 ? `${total} sales this week` : "Public · No signup"}
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 84, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          TOP SALES
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
          The biggest recent sales across Top Shot and All Day — and who bought and sold each one.
        </div>

        <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 12 }}>
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 800 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
                    {r.player_name ?? r.set_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontSize: 15,
                      color: "rgba(255,255,255,0.55)",
                      letterSpacing: 0.5,
                      display: "flex",
                      gap: 10,
                    }}
                  >
                    <span style={{ color: tierColor(r.tier), textTransform: "uppercase" }}>
                      {(r.tier ?? "").replace(/^MOMENT_TIER_/, "") || "—"}
                    </span>
                    <span>·</span>
                    <span>{r.buyer_name ? `buyer ${r.buyer_name}` : (r.set_name ?? "")}</span>
                  </div>
                </div>
                <div style={{ display: "flex", fontSize: 32, fontWeight: 800, color: "#E03A2F" }}>
                  {fmtPrice(r.price_usd)}
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
          <div style={{ display: "flex" }}>Who bought it · who sold it</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/top-sales</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
