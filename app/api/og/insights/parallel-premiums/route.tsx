// app/api/og/insights/parallel-premiums/route.tsx
//
// Open Graph card for /insights/parallel-premiums. 1200x630 PNG via next/og,
// surfacing the top parallel premiums so the social preview is data-rich. The
// hardcoded #E03A2F is the documented universal Satori exception all insights OG
// routes share (Satori can't resolve CSS vars). Every text node is wrapped in a
// display:flex div and fonts use system-ui, mirroring the proven
// serial-premiums OG route (Satori 500s on bare text divs / unknown fonts).

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  player_name: string | null
  subedition_name: string | null
  parallel_fmv: number | null
  base_fmv: number | null
  premium_mult: number | null
}

function fmtMoney(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}
function fmtMult(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 10) return `${Math.round(v).toLocaleString("en-US")}x`
  return `${v.toFixed(1)}x`
}

export async function GET(req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  let rows: Row[] = []
  try {
    const origin = new URL(req.url).origin
    const r = await ogFetch(
      `${origin}/api/public/insights/parallel-premiums?conf=high&sort=premium&limit=3`,
      { cache: "no-store" }
    )
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.rows)) rows = j.rows as Row[]
    }
  } catch {
    /* generic fallback */
  }

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0D0D0D", color: "#F1F1F1", padding: "56px 64px", fontFamily: fam.display }}>
        <div style={{ display: "flex", alignItems: "center", color: "#E03A2F", fontSize: 24, fontWeight: 700, letterSpacing: 2 }}>
          RIP PACKS CITY · PARALLEL PREMIUMS
        </div>
        <div style={{ display: "flex", fontSize: 52, fontWeight: 800, marginTop: 14, lineHeight: 1.05, maxWidth: 900 }}>
          What each Top Shot parallel is really worth
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 34 }}>
          {rows.length > 0 ? (
            rows.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.04)", borderRadius: 14, padding: "18px 24px", marginBottom: 14 }}>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", fontSize: 30, fontWeight: 700 }}>{r.player_name ?? "—"}</div>
                  <div style={{ display: "flex", fontSize: 20, color: "rgba(255,255,255,0.6)" }}>
                    {(r.subedition_name ?? "Parallel")} · {fmtMoney(r.parallel_fmv)} vs {fmtMoney(r.base_fmv)} base
                  </div>
                </div>
                <div style={{ display: "flex", fontSize: 40, fontWeight: 800, color: "#E03A2F" }}>{fmtMult(r.premium_mult)}</div>
              </div>
            ))
          ) : (
            <div style={{ display: "flex", fontSize: 26, color: "rgba(255,255,255,0.7)" }}>
              Every Top Shot parallel priced against its Standard base — free, no signup.
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", fontSize: 22, color: "rgba(255,255,255,0.5)" }}>
          rippackscity.com/insights/parallel-premiums
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  )
}
