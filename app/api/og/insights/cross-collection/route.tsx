// app/api/og/insights/cross-collection/route.tsx
//
// Open Graph card for /insights/cross-collection. 1200x630 PNG rendered
// server-side via next/og. Falls back to a generic card if the cohort API
// is empty.
//
// Mirrors the squeeze OG pattern (app/api/og/insights/squeeze/route.tsx):
// data-rich preview so Twitter / iMessage / Slack show the live cohort
// headline rather than a logo + tagline.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Wallet = {
  wallet_address: string
  n_collections: number | null
  total_moments: number | null
  ts_moments: number | null
  allday_moments: number | null
  golazos_moments: number | null
  pinnacle_moments: number | null
  ufc_moments: number | null
  approx_fmv_usd: number | null
}

type Stats = {
  cohort_size: number | null
  three_coll_wallets: number | null
  four_coll_wallets: number | null
  five_plus_coll_wallets: number | null
} | null

function shortAddr(a: string): string {
  if (!a) return "—"
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

export async function GET(req: NextRequest) {
  let wallets: Wallet[] = []
  let stats: Stats = null
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/cross-collection?sort=moments&limit=3`, {
      cache: "no-store",
    })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.wallets)) wallets = j.wallets as Wallet[]
      stats = (j?.stats as Stats) ?? null
    }
  } catch {
    /* generic card fallback */
  }

  const cohortSize = stats?.cohort_size ?? null

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
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            {cohortSize != null ? `${cohortSize} cross-collection wallets` : "Public · No signup"}
          </div>
        </div>

        <div
          style={{
            marginTop: 22,
            fontSize: 78,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.02,
            display: "flex",
          }}
        >
          CROSS-COLLECTION WHALE MAP
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
          {cohortSize != null ? `${cohortSize} wallets` : "The wallets that"} hold 3+ Flow
          collections — Top Shot, AllDay, Golazos, Pinnacle, UFC Strike. The cohort Top Shot
          can&apos;t see.
        </div>

        <div
          style={{
            marginTop: 34,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {wallets.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              Loading the live cohort…
            </div>
          ) : (
            wallets.slice(0, 3).map((w, i) => {
              const dots: Array<[string, boolean]> = [
                ["TS", Number(w.ts_moments ?? 0) > 0],
                ["AD", Number(w.allday_moments ?? 0) > 0],
                ["GZ", Number(w.golazos_moments ?? 0) > 0],
                ["PN", Number(w.pinnacle_moments ?? 0) > 0],
                ["UFC", Number(w.ufc_moments ?? 0) > 0],
              ]
              return (
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
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 760 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        letterSpacing: 0.5,
                        display: "flex",
                        fontFamily: "monospace",
                      }}
                    >
                      {shortAddr(w.wallet_address)}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {dots.map(([label, on]) => (
                        <span
                          key={label}
                          style={{
                            fontSize: 13,
                            letterSpacing: 1,
                            padding: "2px 8px",
                            borderRadius: 4,
                            display: "flex",
                            color: on ? "#fff" : "rgba(255,255,255,0.30)",
                            background: on ? "#E03A2F" : "rgba(255,255,255,0.05)",
                          }}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#E03A2F", display: "flex" }}>
                      {fmtInt(w.total_moments)}
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        color: "rgba(255,255,255,0.55)",
                        letterSpacing: 1.5,
                        textTransform: "uppercase",
                        display: "flex",
                      }}
                    >
                      {w.n_collections ?? 0} collections
                    </div>
                  </div>
                </div>
              )
            })
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
            {stats
              ? `${fmtInt(stats.three_coll_wallets)} hold 3 · ${fmtInt(
                  stats.four_coll_wallets
                )} hold 4 · ${fmtInt(stats.five_plus_coll_wallets)} hold 5`
              : "Multi-collection Flow collectors"}
          </div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/cross-collection</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
