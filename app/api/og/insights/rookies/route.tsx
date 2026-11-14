// app/api/og/insights/rookies/route.tsx
//
// Open Graph card for /insights/rookies. 1200x630 PNG via next/og.
//
// 2026-11-14: BOTH classes, side by side — the 2026 class (left) and the 2025 class (right), top 3
// each by 30-day GMV. Until then the card was titled "2025 & 2026" but read only the API's default
// class (2025), so a post about the 2026 class linking /insights/rookies?class=2026 previewed Cooper
// Flagg / Dylan Harper / Kon Knueppel under it (Trevor's rookie post, 11-14). The page's metadata
// lives in layout.tsx, which never sees `?class=`, so the card cannot follow the tab — it shows
// both. Each column is its own read with its own failed/empty state (fix per PANEL).

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { boardEmptyCopy } from "@/lib/og/board-empty-copy"
import { brandFonts, brandFamilies, ogCacheHeaders } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"
import { usdSignFirst } from "@/lib/usd-format"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  player_name: string
  gmv_30d: number | null
  sales_30d: number | null
}

type ClassRead = { cls: "2026" | "2025"; fetched: boolean; rows: Row[]; rookieCount: number }

function fmtUsd(n: number | null): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n == null || Number(n) === 0) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return `$${v.toFixed(0)}`
}

async function readClass(origin: string, cls: "2026" | "2025"): Promise<ClassRead> {
  let rows: Row[] = []
  let rookieCount = 0
  // Did THIS class's read succeed? Not 'were there rows' — see lib/og/board-empty-copy.ts.
  let fetched = false
  try {
    const r = await ogFetch(`${origin}/api/public/insights/rookies?class=${cls}&sort=gmv&limit=3`, {
      cache: "no-store",
    })
    if (r.ok) {
      fetched = true
      const j = await r.json()
      rows = Array.isArray(j?.rows) ? j.rows : []
      rookieCount = Number(j?.cohort_stats?.rookie_count) || 0
    }
  } catch {
    /* this column renders its unavailable copy */
  }
  return { cls, fetched, rows, rookieCount }
}

function column(c: ClassRead) {
  const fetched = c.fetched
  return (
  <div key={c.cls} style={{ display: "flex", flexDirection: "column", flex: 1, gap: 10 }}>
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
      <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: 1, display: "flex", textTransform: "uppercase" }}>
        {c.cls} class
      </div>
      <div style={{ fontSize: 15, color: "rgba(255,255,255,0.55)", display: "flex" }}>
        {c.fetched && c.rookieCount > 0 ? `${c.rookieCount} rookies` : ""}
      </div>
    </div>
    {c.rows.length === 0 ? (
      <div style={{ fontSize: 20, color: "rgba(255,255,255,0.45)", display: "flex" }}>
        {boardEmptyCopy(fetched, "cohort")}
      </div>
    ) : (
      c.rows.slice(0, 3).map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderLeft: "4px solid #E03A2F",
            borderRadius: 6,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3, maxWidth: 330 }}>
            <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
              {`${i + 1}. ${r.player_name}`}
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", letterSpacing: 1.5, textTransform: "uppercase", display: "flex" }}>
              {r.sales_30d == null ? "" : `${Number(r.sales_30d).toLocaleString("en-US")} sales · 30d`}
            </div>
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
            {fmtUsd(r.gmv_30d)}
          </div>
        </div>
      ))
    )}
  </div>
  )
}

export async function GET(req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  const origin = new URL(req.url).origin
  const classes = await Promise.all([readClass(origin, "2026"), readClass(origin, "2025")])
  // The card is only as fresh as its worst column: any failed read keeps it off the long cache.
  const fetched = classes.every((c) => c.fetched)

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
          padding: 56,
          fontFamily: fam.display,
        }}
      >
        <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase", display: "flex" }}>
          RIP PACKS CITY · INSIGHTS
        </div>
        <div style={{ marginTop: 14, fontSize: 76, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          ROOKIE INDEX · TOP SHOT
        </div>
        <div style={{ marginTop: 6, fontSize: 22, color: "rgba(255,255,255,0.65)", display: "flex" }}>
          NBA rookie classes ranked by 30-day sales volume (USD), every edition.
        </div>

        <div style={{ marginTop: 26, display: "flex", gap: 28 }}>{classes.map(column)}</div>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 18, color: "rgba(255,255,255,0.55)" }}>
          <div style={{ display: "flex" }}>2026 + 2025 rookie classes · Daily refresh</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/rookies</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: ogCacheHeaders(!fetched) }
  )
}
