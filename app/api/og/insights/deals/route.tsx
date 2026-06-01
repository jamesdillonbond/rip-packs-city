// app/api/og/insights/deals/route.tsx
//
// Open Graph card for /insights/deals (Below FMV). 1200x630 PNG rendered
// server-side via next/og. Pulls the live count of editions listed below a
// trustworthy FMV (>=10% off board) so the social preview is data-rich rather
// than a logo + tagline. Falls back to a generic card if the public API is
// empty. Satori can't read CSS vars, so the hex literals here are the allowed
// brand-token exception.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RPC_RED = "#E03A2F"

export async function GET(req: NextRequest) {
  let deals: number | null = null
  let capped = false
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(
      `${origin}/api/public/insights/deals?min_discount=10&limit=200`,
      { cache: "no-store" }
    )
    if (r.ok) {
      const j = await r.json()
      const n = Array.isArray(j?.rows) ? j.rows.length : 0
      deals = n
      capped = n >= 200
    }
  } catch {
    /* generic card fallback */
  }

  const headline =
    deals != null && deals > 0
      ? `${deals}${capped ? "+" : ""} Top Shot editions listed below FMV`
      : "Top Shot editions listed below fair value"

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
          <div style={{ fontSize: 18, letterSpacing: 6, color: RPC_RED, textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            Public · No signup
          </div>
        </div>

        <div style={{ marginTop: 30, fontSize: 92, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.0, display: "flex" }}>
          BELOW FMV
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 30,
            color: RPC_RED,
            letterSpacing: 0.5,
            lineHeight: 1.2,
            display: "flex",
            maxWidth: 1040,
          }}
        >
          {headline}
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 24,
            color: "rgba(255,255,255,0.62)",
            lineHeight: 1.35,
            display: "flex",
            maxWidth: 1000,
          }}
        >
          Top Shot shows you a listing. We rank listings against a confidence-rated FMV — what&apos;s actually underpriced right now.
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
          <div style={{ display: "flex" }}>Below FMV · RPC Insights</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/deals</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
