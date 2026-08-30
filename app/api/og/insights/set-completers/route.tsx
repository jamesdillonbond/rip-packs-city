// app/api/og/insights/set-completers/route.tsx
//
// Open Graph card for /insights/set-completers. 1200x630 PNG via next/og.
// Shows the top-3 rookie sets by completer count for a data-rich preview.
// (next/og can't read CSS vars, so raw brand hex is used here by necessity.)

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { boardEmptyCopy } from "@/lib/og/board-empty-copy"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  set_name: string
  total_plays: number
  completers: number
  holders_with_any: number
}

function fmtInt(n: number | null): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return "0"
  return Math.round(v).toLocaleString()
}

export async function GET(req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  let rows: Row[] = []
  let totalCompleters = 0
  // Did the board READ succeed? Not 'were there rows' — see lib/og/board-empty-copy.ts.
  let fetched = false
  try {
    const origin = new URL(req.url).origin
    const r = await ogFetch(`${origin}/api/public/insights/set-completers`, { cache: "no-store" })
    if (r.ok) {
      fetched = true
      const j = await r.json()
      rows = Array.isArray(j?.rows) ? j.rows : []
      totalCompleters = rows.reduce((s, x) => s + (Number(x.completers) || 0), 0)
    }
  } catch {
    /* generic card fallback */
  }
  const top = [...rows].sort((a, b) => (Number(b.completers) || 0) - (Number(a.completers) || 0)).slice(0, 3)

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
            {totalCompleters > 0 ? `${fmtInt(totalCompleters)} set completions` : "Public · No signup"}
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 84, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          SET COMPLETERS
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: "rgba(255,255,255,0.65)", letterSpacing: 0.5, lineHeight: 1.35, display: "flex", maxWidth: 1000 }}>
          Who has actually completed each 2025 Top Shot rookie set — base-play completion, from the indexed on-chain ownership graph.
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
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>{r.set_name}</div>
                  <div style={{ fontSize: 14, color: "rgba(255,255,255,0.55)", letterSpacing: 1.5, textTransform: "uppercase", display: "flex", gap: 14 }}>
                    <span>{fmtInt(r.total_plays)} plays</span>
                    <span>·</span>
                    <span>{fmtInt(r.holders_with_any)} holders</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                    {fmtInt(r.completers)}
                  </div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", letterSpacing: 1.5, textTransform: "uppercase", display: "flex" }}>
                    completers
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 18, color: "rgba(255,255,255,0.55)" }}>
          <div style={{ display: "flex" }}>2025 rookie sets · Daily refresh</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/set-completers</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  )
}
