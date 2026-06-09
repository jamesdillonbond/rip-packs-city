import type { Metadata } from "next"
import ShareButton from "./ShareButton"
import ShareEmptyState from "./ShareEmptyState"
import FunnelTracker from "@/components/FunnelTracker"

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
  perCollection: Array<{
    slug: string
    name: string
    moments: number
    fmv: number
  }>
  rarest: {
    playerName: string
    setName: string
    tier: string | null
    serial: number | null
    mintCount: number | null
    fmv: number
    thumbnailUrl: string | null
  } | null
  generatedAt: string
}

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com")
  )
}

async function fetchSnapshot(wallet: string): Promise<SnapshotData | null> {
  try {
    // no-store (not ISR): collection-snapshot returns 200 with totalMoments=0
    // for an un-indexed wallet, and the empty-state queues + polls for indexing
    // to finish. If we cached that 0-snapshot for 300s, the post-index reload
    // would keep showing the empty card for up to 5 minutes. The API itself is
    // still CDN-cached (s-maxage=300) for direct browser hits.
    const res = await fetch(`${siteUrl()}/api/collection-snapshot?wallet=${encodeURIComponent(wallet)}`, {
      cache: "no-store",
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// RPC's Top Shot intelligence lens for the wallet — the differentiator Top
// Shot's own profile doesn't show. TS-scoped (do not imply it covers all 5
// collections). Backed by the service-role /api/public/wallet-intel route.
interface WalletIntelHighlight {
  external_id: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  circulation: number | null
  squeeze_pct: number | null
  is_rookie: boolean
  is_trophy: boolean
  fmv_usd: number | null
  confidence: string | null
  thumbnail_url: string | null
}

interface WalletIntel {
  wallet: string
  ts_moments: number
  ts_fmv: number
  squeezed_count: number
  rookie_count: number
  trophy_count: number
  highlights: WalletIntelHighlight[]
}

async function fetchWalletIntel(wallet: string): Promise<WalletIntel | null> {
  try {
    const res = await fetch(`${siteUrl()}/api/public/wallet-intel?wallet=${encodeURIComponent(wallet)}`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data || typeof data !== "object" || data.error) return null
    return {
      wallet: data.wallet ?? wallet,
      ts_moments: Number(data.ts_moments ?? 0),
      ts_fmv: Number(data.ts_fmv ?? 0),
      squeezed_count: Number(data.squeezed_count ?? 0),
      rookie_count: Number(data.rookie_count ?? 0),
      trophy_count: Number(data.trophy_count ?? 0),
      highlights: Array.isArray(data.highlights) ? data.highlights : [],
    }
  } catch {
    return null
  }
}

export async function generateMetadata(
  props: { params: Promise<{ wallet: string }> }
): Promise<Metadata> {
  const params = await props.params
  // OG image is served by the /api/og/share route handler — NOT the
  // opengraph-image.tsx file convention, which renders 0 bytes on edge / 500 on
  // node in this Next 16 setup (see app/api/og/share/route.tsx header).
  const ogImage = `${siteUrl()}/api/og/share?wallet=${encodeURIComponent(params.wallet)}`
  return {
    title: `Collection Card — ${params.wallet} — Rip Packs City`,
    description: `View the NBA Top Shot collection for wallet ${params.wallet} on Rip Packs City.`,
    openGraph: {
      title: `Collection Card — ${params.wallet}`,
      description: `NBA Top Shot collection snapshot for ${params.wallet}`,
      type: "website",
      images: [{ url: ogImage, width: 1200, height: 630, alt: "Collection Card — Rip Packs City" }],
    },
    twitter: {
      card: "summary_large_image",
      title: `Collection Card — ${params.wallet}`,
      images: [ogImage],
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
  const [data, intel] = await Promise.all([
    fetchSnapshot(wallet),
    fetchWalletIntel(wallet),
  ])

  // Treat "no snapshot" AND "indexed but zero moments" the same: the wallet
  // isn't ready yet (or holds nothing). ShareEmptyState queues it for indexing
  // and polls — far better than rendering a misleading $0.00 / 0-moment card.
  if (!data || (Number(data.totalMoments) || 0) === 0) {
    return <ShareEmptyState wallet={wallet} />
  }

  const seriesEntries = Object.entries(data.seriesBreakdown).sort(([a], [b]) => a.localeCompare(b))
  const maxSeries = Math.max(...seriesEntries.map(([, v]) => v), 1)

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", color: "#fff", fontFamily: "var(--font-display)", padding: "40px 24px" }}>
      <FunnelTracker eventType="share_view" walletAddress={wallet} surface="share" />
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
          <div style={{ fontWeight: 900, fontSize: 28, letterSpacing: "0.08em", color: "var(--rpc-red)" }}>RIP PACKS CITY</div>
          <div style={{ fontSize: 12, fontFamily: "monospace", color: "#666", letterSpacing: "0.05em" }}>{wallet}</div>
        </div>

        {/* Total FMV hero */}
        <div style={{ textAlign: "center", marginBottom: 40, padding: "40px 0", border: "1px solid #222", borderRadius: 12, background: "linear-gradient(180deg, #111 0%, #0A0A0A 100%)" }}>
          <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 8, textTransform: "uppercase" }}>Total Collection FMV</div>
          <div style={{ fontSize: 56, fontWeight: 900, color: "var(--rpc-red)", letterSpacing: "0.02em" }}>
            ${data.totalFmv.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: 16, color: "#666", marginTop: 8 }}>
            {data.totalMoments} moments &middot; {data.badgeCount} badges
          </div>
        </div>

        {/* Wallet-intel overlay — RPC's Top Shot intelligence lens (rookies /
            squeezed / trophies + ranked highlights) that Top Shot's own profile
            doesn't surface. TS-scoped, so framed explicitly as Top Shot (the
            rest of this card is cross-collection). Hidden entirely when the
            wallet holds no TS moments — never render "0 rookies". */}
        {intel && intel.ts_moments > 0 ? (
          <div style={{ marginBottom: 32 }}>
            <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 12, textTransform: "uppercase" }}>
              Your Top Shot Intelligence
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                marginBottom: 16,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 14,
              }}
            >
              <span style={{ padding: "8px 14px", border: "1px solid #222", borderRadius: 999, background: "#111", color: "#ccc" }}>
                <strong style={{ color: "var(--rpc-red, #E03A2F)" }}>{intel.rookie_count}</strong> rookies
              </span>
              <span style={{ padding: "8px 14px", border: "1px solid #222", borderRadius: 999, background: "#111", color: "#ccc" }}>
                <strong style={{ color: "var(--rpc-red, #E03A2F)" }}>{intel.squeezed_count}</strong> squeezed
              </span>
              <span style={{ padding: "8px 14px", border: "1px solid #222", borderRadius: 999, background: "#111", color: "#ccc" }}>
                <strong style={{ color: "var(--rpc-red, #E03A2F)" }}>{intel.trophy_count}</strong> trophies
              </span>
              <span style={{ padding: "8px 14px", borderRadius: 999, color: "#555", alignSelf: "center" }}>
                across {intel.ts_moments.toLocaleString("en-US")} Top Shot moments
              </span>
            </div>

            {intel.highlights.length > 0 ? (
              <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
                {intel.highlights.map((h) => {
                  const tierColor = TIER_COLORS[(h.tier ?? "").toLowerCase()] ?? "#9CA3AF"
                  const squeeze = h.squeeze_pct == null ? null : Math.max(0, Math.min(100, h.squeeze_pct))
                  return (
                    <a
                      key={h.external_id}
                      href={`/nba-top-shot/edition/${encodeURIComponent(h.external_id)}`}
                      style={{
                        flex: "0 0 168px",
                        border: "1px solid #222",
                        borderRadius: 8,
                        background: "#111",
                        overflow: "hidden",
                        textDecoration: "none",
                        color: "inherit",
                        display: "block",
                      }}
                    >
                      {h.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={h.thumbnail_url} alt={h.player_name ?? "moment"} style={{ width: "100%", height: 126, objectFit: "cover" }} />
                      ) : (
                        <div style={{ width: "100%", height: 126, background: "#1A1A1A", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 32 }}>?</div>
                      )}
                      <div style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
                          {h.is_rookie ? (
                            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", color: "#0A0A0A", background: "#FFD700", padding: "2px 6px", borderRadius: 4 }}>ROOKIE</span>
                          ) : null}
                          {h.is_trophy ? (
                            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", color: "#fff", background: "var(--rpc-red, #E03A2F)", padding: "2px 6px", borderRadius: 4 }}>TROPHY</span>
                          ) : null}
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: "#fff", marginBottom: 2, fontFamily: "var(--font-display)" }}>
                          {h.player_name ?? "Unknown"}
                        </div>
                        <div style={{ fontSize: 11, color: tierColor, fontFamily: "var(--font-mono, monospace)" }}>
                          {h.tier ?? ""}
                          {h.serial_number != null && h.circulation != null ? `  ·  #${h.serial_number} / ${h.circulation.toLocaleString("en-US")}` : ""}
                        </div>
                        <div style={{ fontSize: 11, color: "#666", fontFamily: "var(--font-mono, monospace)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {h.set_name ?? ""}
                        </div>
                        {squeeze != null ? (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#777", fontFamily: "var(--font-mono, monospace)", marginBottom: 2 }}>
                              <span>SQUEEZE</span>
                              <span>{squeeze.toFixed(0)}%</span>
                            </div>
                            <div style={{ width: "100%", height: 4, background: "#1F1F1F", borderRadius: 2, overflow: "hidden" }}>
                              <div style={{ width: `${squeeze}%`, height: "100%", background: "var(--rpc-red, #E03A2F)" }} />
                            </div>
                          </div>
                        ) : null}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 8 }}>
                          <span style={{ fontSize: 16, fontWeight: 800, color: "var(--rpc-red, #E03A2F)", fontFamily: "var(--font-mono, monospace)" }}>
                            {h.fmv_usd != null ? `$${Number(h.fmv_usd).toFixed(2)}` : "—"}
                          </span>
                          {h.confidence ? (
                            <span style={{ fontSize: 9, color: "#555", fontFamily: "var(--font-mono, monospace)", letterSpacing: "0.04em" }}>{h.confidence}</span>
                          ) : null}
                        </div>
                      </div>
                    </a>
                  )
                })}
              </div>
            ) : null}

            {/* Conversion hook tied to the intel surface */}
            <a
              href="/login"
              style={{
                display: "inline-block",
                marginTop: 16,
                padding: "10px 22px",
                border: "1px solid var(--rpc-red, #E03A2F)",
                borderRadius: 8,
                color: "var(--rpc-red, #E03A2F)",
                fontWeight: 700,
                fontSize: 13,
                textDecoration: "none",
                letterSpacing: "0.05em",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              Track this wallet — get squeeze + deal alerts →
            </a>
          </div>
        ) : null}

        {/* Per-collection rollup — RPC's cross-collection differentiator. Only
            shown when the wallet spans more than one Flow collection. */}
        {(data.perCollection ?? []).length > 1 ? (
          <div style={{ marginBottom: 32 }}>
            <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 16, textTransform: "uppercase" }}>Across Flow Collections</div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(data.perCollection.length, 5)}, minmax(0, 1fr))`, gap: 12 }}>
              {data.perCollection.map((c) => (
                <div key={c.slug} style={{ border: "1px solid #222", borderRadius: 8, background: "#111", padding: "14px 12px", textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "#999", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8, minHeight: 30 }}>{c.name}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>{c.moments.toLocaleString("en-US")}</div>
                  <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>moments</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--rpc-red)", fontFamily: "monospace" }}>
                    ${c.fmv.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

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
                  <div style={{ fontSize: 16, fontWeight: 800, color: "var(--rpc-red)", marginTop: 6 }}>${m.fmv.toFixed(2)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Rarest moment highlight — lowest mint count in the bag. */}
        {data.rarest ? (
          <div style={{ marginBottom: 32 }}>
            <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 16, textTransform: "uppercase" }}>Rarest Moment</div>
            <div style={{ display: "flex", gap: 16, alignItems: "center", border: "1px solid #2a2118", borderRadius: 10, background: "linear-gradient(180deg, rgba(255,215,0,0.06) 0%, #0A0A0A 100%)", padding: 16 }}>
              {data.rarest.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={data.rarest.thumbnailUrl} alt={data.rarest.playerName} style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, flex: "0 0 96px" }} />
              ) : (
                <div style={{ width: 96, height: 96, background: "#1A1A1A", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 28, flex: "0 0 96px" }}>?</div>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 20, color: "#fff" }}>{data.rarest.playerName}</div>
                <div style={{ fontSize: 13, color: "#888", fontFamily: "monospace", marginTop: 2 }}>{data.rarest.setName}</div>
                <div style={{ fontSize: 13, color: TIER_COLORS[data.rarest.tier?.toLowerCase() ?? ""] ?? "#9CA3AF", fontFamily: "monospace", marginTop: 4 }}>
                  {data.rarest.tier ?? ""}
                  {data.rarest.serial != null && data.rarest.mintCount != null
                    ? `  ·  #${data.rarest.serial} / ${data.rarest.mintCount}`
                    : data.rarest.mintCount != null
                      ? `  ·  /${data.rarest.mintCount}`
                      : ""}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--rpc-red)", fontFamily: "monospace" }}>${data.rarest.fmv.toFixed(2)}</div>
                <div style={{ fontSize: 11, color: "#666" }}>FMV</div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Series breakdown bar */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 14, letterSpacing: "0.15em", color: "#666", marginBottom: 12, textTransform: "uppercase" }}>Series Breakdown</div>
          <div style={{ display: "flex", gap: 8, alignItems: "end", height: 80 }}>
            {seriesEntries.map(([label, count]) => (
              <div key={label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontSize: 11, fontFamily: "monospace", color: "#888" }}>{count}</div>
                <div style={{ width: "100%", height: Math.max(8, (count / maxSeries) * 60), background: "var(--rpc-red)", borderRadius: 3, opacity: 0.8 }} />
                <div style={{ fontSize: 10, fontFamily: "monospace", color: "#555" }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Conversion CTA — honest free-preview framing (no paywall language) */}
        <div
          style={{
            marginBottom: 28,
            padding: "24px 20px",
            border: "1px solid var(--rpc-red)",
            borderRadius: 12,
            background: "linear-gradient(180deg, rgba(224,58,47,0.08) 0%, rgba(224,58,47,0.02) 100%)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13, letterSpacing: "0.12em", color: "var(--rpc-red)", textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
            Free preview
          </div>
          <div style={{ fontSize: 16, color: "#ccc", lineHeight: 1.5, maxWidth: 540, margin: "0 auto 16px" }}>
            This is a free snapshot. Sign up to track FMV over time, badges, set completion, and deal alerts for this wallet — free during beta.
          </div>
          <a
            href="/login"
            style={{ display: "inline-block", padding: "12px 28px", background: "var(--rpc-red)", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none", letterSpacing: "0.06em" }}
          >
            Create a free account →
          </a>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 32 }}>
          <ShareButton />
          <a
            href={`/insights/tc-report?wallet=${encodeURIComponent(wallet)}`}
            style={{ padding: "12px 24px", border: "1px solid var(--rpc-red)", borderRadius: 8, color: "var(--rpc-red)", fontWeight: 700, fontSize: 14, textDecoration: "none", letterSpacing: "0.04em" }}
          >
            Run the full report →
          </a>
          <a
            href={`/nba-top-shot/collection?wallet=${encodeURIComponent(wallet)}`}
            style={{ padding: "12px 24px", border: "1px solid #2a2a2a", borderRadius: 8, color: "#ccc", fontWeight: 700, fontSize: 14, textDecoration: "none", letterSpacing: "0.04em" }}
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

