// app/api/og/insights/first-mint/route.tsx
//
// Open Graph card for /insights/first-mint. 1200x630 PNG via next/og.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Trophy = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  mint_one_price_usd: number | null
  avg_other_serial_price_usd: number | null
  multiplier: number | null
}
type Stats = { trophies_90d: number | null; avg_multiplier: number | null; max_multiplier: number | null } | null

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return `$${v.toFixed(0)}`
}

export async function GET(req: NextRequest) {
  let trophies: Trophy[] = []
  let stats: Stats = null
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/first-mint?limit=3`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      trophies = Array.isArray(j?.trophies) ? j.trophies : []
      stats = j?.stats ?? null
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
          fontFamily: "system-ui",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            {stats?.trophies_90d
              ? `${stats.trophies_90d} #1 sales, 90d · avg ${Number(stats.avg_multiplier ?? 0).toFixed(1)}×`
              : "Public · No signup"}
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 90, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          FIRST-MINT TROPHIES
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
          Trophies aren&apos;t a vibe. They&apos;re math. Every TS serial #1 sale, last 90 days.
        </div>

        <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 12 }}>
          {trophies.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              Loading the live tracker…
            </div>
          ) : (
            trophies.slice(0, 3).map((r, i) => (
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 700 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
                    {r.player_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontSize: 15,
                      color: "rgba(255,255,255,0.55)",
                      letterSpacing: 1,
                      display: "flex",
                      gap: 10,
                    }}
                  >
                    <span style={{ textTransform: "uppercase" }}>{r.tier ?? "—"}</span>
                    <span>·</span>
                    <span>{r.set_name ?? "—"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                  <div style={{ fontSize: 30, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                    {Number(r.multiplier ?? 0).toFixed(1)}×
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: "rgba(255,255,255,0.55)",
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      display: "flex",
                    }}
                  >
                    {fmtUsd(r.mint_one_price_usd)} vs {fmtUsd(r.avg_other_serial_price_usd)} avg
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
          <div style={{ display: "flex" }}>vs avg-other-serial price · 90d window</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/first-mint</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
