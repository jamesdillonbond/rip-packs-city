// app/api/og/insights/route.tsx
//
// OG card for the /insights landing page. 1200x630 PNG via next/og.
// Pulls the live cohort_size + 60d rip count + trophy count to make the
// card data-rich vs a static "marketing" feel — this is the URL anyone
// shares as the entry to the wedge content, so the preview matters.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

export async function GET(req: NextRequest) {
  let rips = 0
  let cohort = 0
  let trophies = 0
  let zeroPct = 0

  try {
    const origin = new URL(req.url).origin
    // Three parallel fetches against the live JSON routes — keeps the card
    // honest with whatever the surfaces are actually showing today.
    const [packR, ccR, fmR] = await Promise.all([
      fetch(`${origin}/api/public/insights/pack-reality?limit=1`, { cache: "no-store" }).catch(() => null),
      fetch(`${origin}/api/public/insights/cross-collection?sort=moments&limit=1`, { cache: "no-store" }).catch(() => null),
      fetch(`${origin}/api/public/insights/first-mint?limit=1`, { cache: "no-store" }).catch(() => null),
    ])
    if (packR?.ok) {
      const j = await packR.json()
      rips = Number(j?.stats?.rips_60d ?? 0)
      zeroPct = Number(j?.stats?.zero_value_pct ?? 0)
    }
    if (ccR?.ok) {
      const j = await ccR.json()
      cohort = Number(j?.stats?.cohort_size ?? 0)
    }
    if (fmR?.ok) {
      const j = await fmR.json()
      trophies = Number(j?.stats?.trophies_90d ?? 0)
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            Free · No signup · Public
          </div>
        </div>

        <div
          style={{
            marginTop: 24,
            fontSize: 96,
            fontWeight: 900,
            letterSpacing: 1.0,
            lineHeight: 1.0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ display: "flex" }}>THINGS TOP SHOT</div>
          <div style={{ display: "flex" }}>WON&apos;T TELL YOU.</div>
        </div>

        <div
          style={{
            marginTop: 18,
            fontSize: 22,
            color: "rgba(255,255,255,0.65)",
            letterSpacing: 0.5,
            lineHeight: 1.3,
            display: "flex",
            maxWidth: 1000,
          }}
        >
          Seven wedges of intelligence the marketplace structurally can&apos;t (or won&apos;t) ship, plus a wallet tool.
        </div>

        <div
          style={{
            marginTop: 36,
            display: "flex",
            gap: 14,
          }}
        >
          {[
            { label: "Pack rips, 60d", value: rips > 0 ? fmtInt(rips) : "—" },
            { label: "% delivering $0", value: zeroPct > 0 ? `${zeroPct.toFixed(0)}%` : "—" },
            { label: "Cross-coll. cohort", value: cohort > 0 ? fmtInt(cohort) : "—" },
            { label: "First-mint trophies", value: trophies > 0 ? fmtInt(trophies) : "—" },
          ].map((k) => (
            <div
              key={k.label}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "18px 22px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderLeft: "4px solid #E03A2F",
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  letterSpacing: 2.5,
                  color: "rgba(255,255,255,0.55)",
                  textTransform: "uppercase",
                  display: "flex",
                }}
              >
                {k.label}
              </div>
              <div
                style={{
                  fontSize: 42,
                  fontWeight: 800,
                  color: "#E03A2F",
                  letterSpacing: 0.5,
                  display: "flex",
                }}
              >
                {k.value}
              </div>
            </div>
          ))}
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
          <div style={{ display: "flex" }}>Squeeze · Pack Reality · Rookies · Trophies · Whales · Sets · Pinnacle</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
