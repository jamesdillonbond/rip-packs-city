// app/api/og/insights/autographs/route.tsx
//
// Open Graph card for /insights/autographs. 1200x630 PNG via next/og. Replaces
// the text-only default ([slug]) card with the three cheapest LISTED signed Top
// Shot editions and the signed-edition count of both collections, so a share
// previews with real asks. The hardcoded #E03A2F is the documented universal
// Satori exception all insights OG routes share (Satori can't resolve CSS vars).
//
// ⛔ Market facts only — no FMV and no confidence, same as the board
// (lib/insights/autographs-board.ts).
//
// Counts: one request per collection at the route's real clamp ceiling (500,
// app/api/public/insights/autographs/route.ts) with sort=scarcity, the one sort
// that applies no not-null filter, so the count is every signed edition. A
// failed count drops out of the header rather than printing a zero.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { boardEmptyCopy } from "@/lib/og/board-empty-copy"
import { brandFonts, brandFamilies, ogCacheHeaders } from "@/lib/og/brand-fonts"
import { fetchBoardCount, type BoardCount } from "@/lib/og/board-count"
import { boardCountFloor } from "@/lib/insights/board-meta"
import { ogFetch } from "@/lib/og/og-fetch"
import { usdSignFirst } from "@/lib/usd-format"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The API's own `limit` clamp ceiling. */
const MAX_LIMIT = 500

type Row = {
  player_name: string | null
  set_name: string | null
  parallel: string | null
  circulation_count: number | null
  low_ask: number | null
}

function fmtMoney(n: number | null): string {
  const neg = usdSignFirst(n, fmtMoney); if (neg !== null) return neg
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

/** "236 Top Shot · 226 All Day signed editions"; a failed or zero count is left out. */
function autographCountLabel(ts: BoardCount | null, ad: BoardCount | null): string {
  const parts: string[] = []
  if (ts && ts.count > 0) parts.push(`${boardCountFloor(ts.count, ts.truncated)} Top Shot`)
  if (ad && ad.count > 0) parts.push(`${boardCountFloor(ad.count, ad.truncated)} All Day`)
  return parts.length ? `${parts.join(" · ")} signed editions` : "Public · No signup"
}

function printing(r: Row): string {
  const set = r.set_name ?? "—"
  const par = r.parallel && r.parallel !== "Standard" ? ` · ${r.parallel}` : ""
  const mint = r.circulation_count != null ? ` · /${r.circulation_count}` : ""
  return `${set}${par}${mint}`
}

export async function GET(req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)

  let rows: Row[] = []
  let tsCount: BoardCount | null = null
  let adCount: BoardCount | null = null
  // Did the board READ succeed? Not 'were there rows' — see lib/og/board-empty-copy.ts.
  let fetched = false
  try {
    const origin = new URL(req.url).origin
    ;[tsCount, adCount] = await Promise.all([
      fetchBoardCount(origin, "/api/public/insights/autographs?collection=nba_top_shot&sort=scarcity", MAX_LIMIT),
      fetchBoardCount(origin, "/api/public/insights/autographs?collection=nfl_all_day&sort=scarcity", MAX_LIMIT),
    ])
    const r = await ogFetch(
      `${origin}/api/public/insights/autographs?collection=nba_top_shot&sort=listed&limit=3`,
      { cache: "no-store" }
    )
    if (r.ok) {
      fetched = true
      const j = await r.json()
      if (Array.isArray(j?.rows)) rows = j.rows as Row[]
    }
  } catch {
    /* generic card fallback */
  }

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
            {autographCountLabel(tsCount, adCount)}
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 78, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          AUTOGRAPHS
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: 22,
            color: "rgba(255,255,255,0.65)",
            letterSpacing: 0.5,
            lineHeight: 1.35,
            display: "flex",
            maxWidth: 1000,
          }}
        >
          Every signed Top Shot and All Day edition: lowest ask, recent sales, and the premium over the unsigned printing.
        </div>

        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              {boardEmptyCopy(fetched, "board")}
            </div>
          ) : (
            rows.slice(0, 3).map((r, i) => (
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 820 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
                    {r.player_name ?? "—"}
                  </div>
                  <div style={{ fontSize: 15, color: "rgba(255,255,255,0.55)", letterSpacing: 0.5, display: "flex" }}>
                    {printing(r)}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <div style={{ display: "flex", fontSize: 13, color: "rgba(255,255,255,0.5)", letterSpacing: 2 }}>
                    LOWEST ASK
                  </div>
                  <div style={{ display: "flex", fontSize: 34, fontWeight: 800, color: "#E03A2F" }}>
                    {fmtMoney(r.low_ask)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <div style={{ display: "flex" }}>Signed per Atlas · live asks · real sales</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/autographs</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: ogCacheHeaders(!fetched) }
  )
}
