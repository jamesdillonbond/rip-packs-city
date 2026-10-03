// app/api/og/insights/market-cap/route.tsx
//
// Open Graph card for /insights/market-cap. 1200x630 PNG via next/og.
// Shows the top-3 collections by KNOWN market cap. A collection whose cap is
// unknown (no burn source) is not shown as a number here — the card has no room
// for the "unknown, upper bound $X" disclosure the page carries.
// (next/og can't read CSS vars, so raw brand hex is used here by necessity.)

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { boardEmptyCopy } from "@/lib/og/board-empty-copy"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"
import { collectionDisplayName, fmtCount, fmtUsdCompact } from "@/lib/insights/market-cap-board"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  collection_slug: string
  collector_held: number | null
  burned: number | null
  mcap_usd: number | null
}

export async function GET(req: NextRequest) {
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)

  let rows: Row[] = []
  // Did the board READ succeed? Not 'were there rows' — see lib/og/board-empty-copy.ts.
  let fetched = false
  try {
    const origin = new URL(req.url).origin
    const r = await ogFetch(`${origin}/api/public/insights/market-cap?group=collection`, { cache: "no-store" })
    if (r.ok) {
      fetched = true
      const j = await r.json()
      rows = Array.isArray(j?.rows) ? j.rows : []
    }
  } catch {
    /* generic card fallback */
  }
  const known = rows.filter((r) => r.mcap_usd != null && Number.isFinite(Number(r.mcap_usd)))
  const top = [...known].sort((a, b) => Number(b.mcap_usd) - Number(a.mcap_usd)).slice(0, 3)
  const knownTotal = known.reduce((s, r) => s + Number(r.mcap_usd), 0)

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
          fontFamily: fam.display,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            {known.length > 0 ? `${fmtUsdCompact(knownTotal)} tracked` : "Public · No signup"}
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 84, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          MARKET CAP
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: "rgba(255,255,255,0.65)", letterSpacing: 0.5, lineHeight: 1.35, display: "flex", maxWidth: 1000 }}>
          Fair market value x the supply collectors actually hold — burned Moments and unopened packs taken out.
        </div>

        <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 12 }}>
          {top.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              {boardEmptyCopy(fetched, "board")}
            </div>
          ) : (
            top.map((r, i) => (
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 640 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>{collectionDisplayName(r.collection_slug)}</div>
                  <div style={{ fontSize: 14, color: "rgba(255,255,255,0.55)", letterSpacing: 1.5, textTransform: "uppercase", display: "flex", gap: 14 }}>
                    <span>{fmtCount(r.collector_held)} collector-held</span>
                    <span>·</span>
                    <span>{fmtCount(r.burned)} burned</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                    {fmtUsdCompact(Number(r.mcap_usd))}
                  </div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", letterSpacing: 1.5, textTransform: "uppercase", display: "flex" }}>
                    market cap
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 18, color: "rgba(255,255,255,0.55)" }}>
          <div style={{ display: "flex" }}>Collections · players · teams · sets · badges</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/market-cap</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  )
}
