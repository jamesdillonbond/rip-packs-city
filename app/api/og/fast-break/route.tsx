// app/api/og/fast-break/route.tsx
//
// Open Graph card for /nba/fast-break. 1200x630 PNG rendered server-side via
// next/og. Falls back to a generic Fast Break card if the optimizer payload
// is empty (no active run, no games on the queried date, etc.).
//
// The Fast Break daily slate is Eastern, so when ?date= is omitted we use
// the today-ET date the page itself defaults to.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function todayEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

type LineupRow = {
  full_name: string
  team_abbr: string | null
  opponent_abbr: string | null
  proj_fp_dk: number | null
  projected_with_captain: number | null
  is_captain: boolean
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const date = url.searchParams.get("date") || todayEastern()

  let lineup: LineupRow[] = []
  let score = 0
  let runName = "FAST BREAK"
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(
      `${origin}/api/nba/fast-break/optimize?game_date=${encodeURIComponent(date)}`,
      { cache: "no-store" }
    )
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.lineup)) lineup = j.lineup as LineupRow[]
      if (typeof j?.recommended_score === "number") score = j.recommended_score
      if (typeof j?.meta?.run_name === "string") runName = String(j.meta.run_name).toUpperCase()
    }
  } catch {
    // Generic card on fetch failure.
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
          fontFamily: "system-ui",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 18,
              letterSpacing: 6,
              color: "#E03A2F",
              textTransform: "uppercase",
            }}
          >
            RIP PACKS CITY · FAST BREAK
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)" }}>{date}</div>
        </div>

        <div
          style={{
            marginTop: 24,
            fontSize: 72,
            fontWeight: 900,
            letterSpacing: 2,
            lineHeight: 1.05,
            display: "flex",
          }}
        >
          FAST BREAK OPTIMIZER
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 22,
            color: "rgba(255,255,255,0.65)",
            letterSpacing: 1,
            display: "flex",
          }}
        >
          {runName} · Daily optimal NBA Top Shot Fast Break lineups
        </div>

        <div
          style={{
            marginTop: 38,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {lineup.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              Tonight&rsquo;s slate is still loading.
            </div>
          ) : (
            lineup.slice(0, 3).map((p, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 22px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderLeft: p.is_captain ? "4px solid #E03A2F" : "4px solid rgba(255,255,255,0.18)",
                  borderRadius: 8,
                  fontSize: 26,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 1, display: "flex" }}>
                    {p.full_name}
                    {p.is_captain ? "  CAPTAIN" : ""}
                  </div>
                  <div style={{ fontSize: 16, color: "rgba(255,255,255,0.55)", display: "flex" }}>
                    {(p.team_abbr ?? "—") + " vs " + (p.opponent_abbr ?? "—")}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 32,
                    fontWeight: 800,
                    color: p.is_captain ? "#E03A2F" : "#F1F1F1",
                    display: "flex",
                  }}
                >
                  {(p.projected_with_captain != null ? p.projected_with_captain.toFixed(1) : "—") + " FP"}
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
          <div style={{ display: "flex" }}>
            <span>Total projected:&nbsp;</span>
            <span style={{ color: "#E03A2F", fontWeight: 800 }}>{score.toFixed(1) + " FP"}</span>
          </div>
          <div style={{ display: "flex" }}>rippackscity.com/nba/fast-break</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
