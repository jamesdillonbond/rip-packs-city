/**
 * app/api/og/share/route.tsx
 *
 * OG card for /share/<wallet>, served as an edge route handler.
 *
 * The previous app/share/[wallet]/opengraph-image.tsx (the Next metadata
 * file convention) rendered a 0-byte PNG on the edge runtime and threw a 500 on
 * the node runtime in this Next 16 setup — the failure is in the metadata-image
 * convention's lazy ImageResponse streaming, not the JSX (a try/catch around the
 * construction never fired). The identical ImageResponse renders reliably from a
 * route handler — exactly how every other OG image on the site is served
 * (/api/og/default and the lib/og entity cards). So /share now points its
 * openGraph.images at this route instead of the file convention.
 */
import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "edge"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet") || ""

  let totalFmv = 0
  let totalMoments = 0
  let topPlayers: string[] = []

  try {
    const res = await fetch(`${BASE_URL}/api/collection-snapshot?wallet=${encodeURIComponent(wallet)}`, {
      next: { revalidate: 300 },
    })
    if (res.ok) {
      const data = await res.json()
      totalFmv = data.totalFmv ?? 0
      totalMoments = data.totalMoments ?? 0
      topPlayers = (data.topMoments ?? []).slice(0, 3).map((m: { playerName: string }) => m.playerName)
    }
  } catch {
    /* fall back to zeros — the card still renders a branded shell */
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(180deg, #0A0A0A 0%, #111111 100%)",
          padding: "48px 56px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Top row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ fontSize: 36, fontWeight: 900, color: "#E03A2F", letterSpacing: "0.08em", display: "flex" }}>
            RIP PACKS CITY
          </div>
          <div style={{ fontSize: 18, color: "#666", fontFamily: "monospace", display: "flex" }}>
            {wallet.length > 18 ? wallet.slice(0, 8) + "..." + wallet.slice(-6) : wallet}
          </div>
        </div>

        {/* Center */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 20, color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", display: "flex" }}>
            COLLECTION FMV
          </div>
          <div style={{ fontSize: 80, fontWeight: 900, color: "#E03A2F", display: "flex" }}>
            ${totalFmv.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: 22, color: "#888", display: "flex" }}>
            {totalMoments} moments
          </div>
        </div>

        {/* Bottom */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {topPlayers.map((name, i) => (
              <div key={i} style={{ fontSize: 18, color: "#555", fontFamily: "monospace", display: "flex" }}>
                {i + 1}. {name}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 16, color: "#444", fontFamily: "monospace", letterSpacing: "0.1em", display: "flex" }}>
            rippackscity.com
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
