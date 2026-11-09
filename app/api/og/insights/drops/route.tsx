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

const MAX_CARDS = 6

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
  const shown = live.slice(0, MAX_CARDS)
  const more = live.length - shown.length

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#080808", color: "#F1F1F1", padding: "44px 52px", fontFamily: fam.display, borderLeft: "10px solid #E03A2F" }}>
        <div style={{ display: "flex", fontSize: 18, letterSpacing: 5, color: "#E03A2F" }}>RIP PACKS CITY · INSIGHTS</div>
        <div style={{ display: "flex", fontSize: 72, fontWeight: 900, lineHeight: 1, marginTop: 10 }}>
          PACK DROPS&nbsp;<span style={{ color: "#E03A2F" }}>THIS WEEK</span>
        </div>
        {shown.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", marginTop: 26, gap: 14 }}>
            {shown.map((d, i) => {
              const c = getCollection(d.collection.replace(/_/g, "-"))
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", width: 349, height: 168, padding: "14px 16px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderTop: `4px solid ${c?.accent ?? "#E03A2F"}`, borderRadius: 10 }}>
                  <div style={{ display: "flex", fontSize: 14, letterSpacing: 1.5, color: "rgba(255,255,255,0.6)" }}>{(c?.label ?? d.collection).toUpperCase()}</div>
                  <div style={{ display: "flex", fontSize: 28, fontWeight: 900, lineHeight: 1.02, marginTop: 6 }}>{d.title.toUpperCase()}</div>
                  <div style={{ display: "flex", flex: 1 }} />
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                    {d.retail_usd != null ? <div style={{ display: "flex", fontSize: 26 }}>{usd(d.retail_usd)}</div> : null}
                    <div style={{ display: "flex", fontSize: 16, color: d.status === "upcoming" ? "#FBBF24" : "#FF4D40" }}>{dropStatusLine(d)}</div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 28, color: "rgba(255,255,255,0.7)", marginTop: 30, maxWidth: 1000 }}>
            {read ? "No drop open or scheduled this week on the collections we read." : "Every pack drop open now or starting this week — price and closing times in PT."}
          </div>
        )}
        <div style={{ display: "flex", flex: 1 }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, color: "rgba(255,255,255,0.6)" }}>
          <div style={{ display: "flex" }}>{more > 0 ? `+ ${more} more on the page · ` : ""}rippackscity.com/insights/drops</div>
          <div style={{ display: "flex" }}>Times PT · retail prices</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: ogCacheHeaders(!read) }
  )
}
