import type { Metadata } from "next"
import ShareButton from "./ShareButton"

interface SnapshotData {
  wallet: string
  totalMoments: number
  totalFmv: number
  topMoments: Array<{
    playerName: string
    setName: string
    tier: string
    serial: number
    fmv: number
    thumbnailUrl: string | null
  }>
  badgeCount: number
  seriesBreakdown: Record<string, number>
  generatedAt: string
}

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://rip-packs-city.vercel.app")
  )
}

async function fetchSnapshot(wallet: string): Promise<SnapshotData | null> {
  try {
    const res = await fetch(`${siteUrl()}/api/collection-snapshot?wallet=${encodeURIComponent(wallet)}`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function generateMetadata(
  props: { params: Promise<{ wallet: string }> }
): Promise<Metadata> {
  const params = await props.params
  return {
    title: `Collection Card — ${params.wallet} — Rip Packs City`,
    description: `View the NBA Top Shot collection for wallet ${params.wallet} on Rip Packs City.`,
    openGraph: {
      title: `Collection Card — ${params.wallet}`,
      description: `NBA Top Shot collection snapshot for ${params.wallet}`,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: `Collection Card — ${params.wallet}`,
    },
  }
}

const TIER_COLORS: Record<string, string> = {
  legendary: "#FFD700",
  rare: "#A855F7",
  uncommon: "#14B8A6",
  fandom: "#3B82F6",
  common: "#9CA3AF",
  ultimate: "#EF4444",
}

export default async function SharePage(props: { params: Promise<{ wallet: string }> }) {
  const params = await props.params
  const wallet = params.wallet
  const data = await fetchSnapshot(wallet)

  if (!data) {
    return (
      <div style={{ minHeight: "100vh", background: "#0A0A0A", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "'Barlow Condensed', sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>RPC</div>
          <div style={{ fontSize: 18, color: "#666" }}>Collection not found for {wallet}</div>
          <div style={{ marginTop: 16, fontSize: 14, color: "#555" }}>This wallet may not have been analyzed yet.</div>
        </div>
      </div>
    )
  }

  const seriesEntries = Object.entries(data.seriesBreakdown).sort(([a], [b]) => a.localeCompare(b))
  const maxSeries = Math.max(...seriesEntries.map(([, v]) => v), 1)

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", color: "#fff", fontFamily: "'Barlow Condensed', sans-serif", padding: "40px 24px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
          <div style={{ fontWeight: 900, fontSize: 28, letterSpacing: "0.08em", color: "#E03A2F" }}>RIP PACKS CITY</div>
          <div style={{ fontSize: 12, fontFamily: "monospace", color: "#666", letterSpacing: "0.05em" }}>{wallet}</div>
        </div>

        {/* Total FMV hero */}
        <div style={{ textAlign: "center", marginBottom: 40, padding: "40px 0", border: "1px solid #222", borderRadius: 12, background: "linear-gradient(180deg, #111 0%, #0A0A0A 100%)" }}>
          <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 8, textTransform: "uppercase" }}>Total Collection FMV</div>
          <div style={{ fontSize: 56, fontWeight: 900, color: "#E03A2F", letterSpacing: "0.02em" }}>
            ${data.totalFmv.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: 16, color: "#666", marginTop: 8 }}>
            {data.totalMoments} moments &middot; {data.badgeCount} badges
          </div>
        </div>

        {/* Top 5 moments */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 16, textTransform: "uppercase" }}>Top Moments by FMV</div>
          <div style={{ display: "flex", gap: 12, overflowX: "auto" }}>
            {data.topMoments.map((m, i) => (
              <div key={i} style={{ flex: "0 0 160px", border: "1px solid #222", borderRadius: 8, background: "#111", overflow: "hidden" }}>
                {m.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.thumbnailUrl} alt={m.playerName} style={{ width: "100%", height: 120, objectFit: "cover" }} />
                ) : (
                  <div style={{ width: "100%", height: 120, background: "#1A1A1A", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 32 }}>?</div>
                )}
                <div style={{ padding: "10px 12px" }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#fff", marginBottom: 2 }}>{m.playerName}</div>
                  <div style={{ fontSize: 11, color: TIER_COLORS[m.tier?.toLowerCase()] ?? "#9CA3AF", fontFamily: "monospace" }}>{m.tier}</div>
                  <div style={{ fontSize: 11, color: "#666", fontFamily: "monospace", marginTop: 2 }}>{m.setName}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#E03A2F", marginTop: 6 }}>${m.fmv.toFixed(2)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Series breakdown bar */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 12, textTransform: "uppercase" }}>Series Breakdown</div>
          <div style={{ display: "flex", gap: 8, alignItems: "end", height: 80 }}>
            {seriesEntries.map(([label, count]) => (
              <div key={label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontSize: 11, fontFamily: "monospace", color: "#888" }}>{count}</div>
                <div style={{ width: "100%", height: Math.max(8, (count / maxSeries) * 60), background: "#E03A2F", borderRadius: 3, opacity: 0.8 }} />
                <div style={{ fontSize: 10, fontFamily: "monospace", color: "#555" }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 32 }}>
          <ShareButton />
          <a
            href={`/nba-top-shot/collection?wallet=${encodeURIComponent(wallet)}`}
            style={{ padding: "12px 24px", border: "1px solid #E03A2F", borderRadius: 8, color: "#E03A2F", fontWeight: 700, fontSize: 14, textDecoration: "none", letterSpacing: "0.04em" }}
          >
            View Full Collection
          </a>
        </div>

        {/* Footer */}
        <div style={{ textAlign: "center", borderTop: "1px solid #222", paddingTop: 24 }}>
          <div style={{ fontSize: 12, fontFamily: "monospace", color: "#444", letterSpacing: "0.1em" }}>rippackscity.com</div>
        </div>
      </div>
    </div>
  )
}

