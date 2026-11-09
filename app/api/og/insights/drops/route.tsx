// app/api/og/insights/drops/route.tsx — OG card for /insights/drops ("Pack drops this week").
// 1200x630 PNG via next/og from the live pack calendar, so a shared link previews the actual
// week's drops. Hardcoded hex colours are the documented Satori CSS-var exception every insights
// OG route shares (Satori cannot resolve CSS vars). Brand art only — no pack art or player photos.
import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { brandFonts, brandFamilies, ogCacheHeaders } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"
import { dropStatusLine } from "@/lib/insights/drops-board"
import type { PackCalendarDrop } from "@/lib/insights/pack-calendar"
import { getCollection } from "@/lib/collections"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Every live drop is NAMED on the card — never cut to "+N more" (Trevor, 11-08: "always name them
// all"). The grid sizes itself to the count; past GRID_MAX it falls back to one line per drop.
const AREA_W = 1086 // 1200 − padding − the red rule
const AREA_H = 372 // between the headline and the footer
const GAP = 12
const GRID_MAX = 16
function layout(n: number) {
  const cols = n <= 3 ? Math.max(n, 1) : n === 4 ? 2 : n <= 6 || n === 9 ? 3 : 4
  const rows = Math.ceil(n / cols)
  const w = Math.floor((AREA_W - (cols - 1) * GAP) / cols)
  const h = Math.min(168, Math.floor((AREA_H - (rows - 1) * GAP) / rows))
  const k = h / 168
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)))
  return {
    w,
    h,
    pad: `${clamp(14 * k, 6, 14)}px ${clamp(16 * k, 10, 16)}px`,
    label: clamp(14 * k, 10, 14),
    title: clamp(28 * k, 15, 28) - (cols >= 4 ? 2 : 0),
    price: clamp(26 * k, 14, 26),
    status: clamp(16 * k, 11, 16),
  }
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: n < 100 && n % 1 ? 2 : 0 })
}

export async function GET(req: NextRequest) {
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)

  let live: PackCalendarDrop[] = []
  let read = false
  try {
    const origin = new URL(req.url).origin
    const r = await ogFetch(`${origin}/api/public/insights/pack-calendar`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.drops)) {
        // "No drop this week" is a claim only when every source was read.
        read = j?.meta?.complete === true
        live = (j.drops as PackCalendarDrop[])
          .filter((d) => d.status !== "ended")
          .sort((a, b) => (b.retail_usd ?? 0) - (a.retail_usd ?? 0) || a.start_time.localeCompare(b.start_time))
      }
    }
  } catch {
    /* generic card below — never a claim of "no drops" */
  }
  const grid = live.length <= GRID_MAX
  const L = layout(live.length)
  // List fallback (more than GRID_MAX drops): two columns of one line each, sized to fit.
  const perCol = Math.ceil(live.length / 2)
  const lineFont = Math.max(10, Math.min(20, Math.floor(AREA_H / Math.max(perCol, 1) / 1.3)))

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#080808", color: "#F1F1F1", padding: "44px 52px", fontFamily: fam.display, borderLeft: "10px solid #E03A2F" }}>
        <div style={{ display: "flex", fontSize: 18, letterSpacing: 5, color: "#E03A2F" }}>RIP PACKS CITY · INSIGHTS</div>
        <div style={{ display: "flex", fontSize: 72, fontWeight: 900, lineHeight: 1, marginTop: 10 }}>
          PACK DROPS&nbsp;<span style={{ color: "#E03A2F" }}>THIS WEEK</span>
        </div>
        {live.length && grid ? (
          <div style={{ display: "flex", flexWrap: "wrap", marginTop: 22, gap: GAP }}>
            {live.map((d, i) => {
              const c = getCollection(d.collection.replace(/_/g, "-"))
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", width: L.w, height: L.h, padding: L.pad, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderTop: `4px solid ${c?.accent ?? "#E03A2F"}`, borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ display: "flex", fontSize: L.label, letterSpacing: 1.5, color: "rgba(255,255,255,0.6)" }}>{(c?.label ?? d.collection).toUpperCase()}</div>
                  <div style={{ display: "flex", fontSize: L.title, fontWeight: 900, lineHeight: 1.02, marginTop: 4 }}>{d.title.toUpperCase()}</div>
                  <div style={{ display: "flex", flex: 1 }} />
                  <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", columnGap: 10 }}>
                    {d.retail_usd != null ? <div style={{ display: "flex", fontSize: L.price }}>{usd(d.retail_usd)}</div> : null}
                    <div style={{ display: "flex", fontSize: L.status, color: d.status === "upcoming" ? "#FBBF24" : "#FF4D40" }}>{dropStatusLine(d)}</div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : live.length ? (
          <div style={{ display: "flex", flexDirection: "column", flexWrap: "wrap", height: AREA_H, marginTop: 22, columnGap: 24 }}>
            {live.map((d, i) => (
              <div key={i} style={{ display: "flex", width: (AREA_W - 24) / 2, fontSize: lineFont, lineHeight: 1.3 }}>
                {`${d.title.toUpperCase()}${d.retail_usd != null ? ` · ${usd(d.retail_usd)}` : ""} · ${dropStatusLine(d)}`}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 28, color: "rgba(255,255,255,0.7)", marginTop: 30, maxWidth: 1000 }}>
            {read ? "No drop open or scheduled this week on the collections we read." : "Every pack drop open now or starting this week — price and closing times in PT."}
          </div>
        )}
        <div style={{ display: "flex", flex: 1 }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, color: "rgba(255,255,255,0.6)" }}>
          <div style={{ display: "flex" }}>rippackscity.com/insights/drops</div>
          <div style={{ display: "flex" }}>Times PT · retail prices</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: ogCacheHeaders(!read) }
  )
}
