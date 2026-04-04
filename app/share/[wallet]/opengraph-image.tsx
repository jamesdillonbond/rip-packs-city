import { ImageResponse } from "next/og"

export const runtime = "edge"
export const alt = "Collection Card — Rip Packs City"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://rip-packs-city.vercel.app")
  )
}

export default async function Image(props: { params: Promise<{ wallet: string }> }) {
  const params = await props.params
  const wallet = params.wallet

  let totalFmv = 0
  let totalMoments = 0
  let topPlayers: string[] = []

  try {
    const res = await fetch(`${siteUrl()}/api/collection-snapshot?wallet=${encodeURIComponent(wallet)}`, {
      next: { revalidate: 300 },
    })
    if (res.ok) {
      const data = await res.json()
      totalFmv = data.totalFmv ?? 0
      totalMoments = data.totalMoments ?? 0
      topPlayers = (data.topMoments ?? []).slice(0, 3).map((m: { playerName: string }) => m.playerName)
    }
  } catch { /* fallback to zeros */ }

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
          <div style={{ fontSize: 36, fontWeight: 900, color: "#E03A2F", letterSpacing: "0.08em" }}>
            RIP PACKS CITY
          </div>
          <div style={{ fontSize: 18, color: "#666", fontFamily: "monospace" }}>
            {wallet.length > 18 ? wallet.slice(0, 8) + "..." + wallet.slice(-6) : wallet}
          </div>
        </div>

        {/* Center */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 20, color: "#666", letterSpacing: "0.15em", textTransform: "uppercase" }}>
            COLLECTION FMV
          </div>
          <div style={{ fontSize: 80, fontWeight: 900, color: "#E03A2F" }}>
            ${totalFmv.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: 22, color: "#888" }}>
            {totalMoments} moments
          </div>
        </div>

        {/* Bottom */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {topPlayers.map((name, i) => (
              <div key={i} style={{ fontSize: 18, color: "#555", fontFamily: "monospace" }}>
                {i + 1}. {name}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 16, color: "#444", fontFamily: "monospace", letterSpacing: "0.1em" }}>
            rippackscity.com
          </div>
        </div>
      </div>
    ),
    { ...size }
  )
}
