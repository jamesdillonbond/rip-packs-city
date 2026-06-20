// app/api/og/insights/pack-drops/route.tsx
//
// Open Graph card for /insights/pack-drops. 1200x630 PNG rendered server-side
// via next/og. Surfaces the live re-pack drops scored against RPC FMV so the
// Twitter / iMessage / Slack preview is data-rich rather than a logo + tagline.
// Falls back to a generic card if the API is empty. The hardcoded #E03A2F is the
// documented universal Satori exception all insights OG routes share (Satori
// can't resolve CSS vars).

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Drop = {
  drop_id: number
  name: string | null
  pack_count: number | null
  pack_price_usd: number | null
  rpc_pack_ev_usd: number | null
  verdict_kind: "value" | "premium" | "fair" | "unknown"
}

function fmtMoney(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (!Number.isFinite(v)) return "—"
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

function verdictColor(kind: Drop["verdict_kind"]): string {
  switch (kind) {
    case "value":
      return "#3FB950"
    case "premium":
      return "#E3B341"
    default:
      return "rgba(255,255,255,0.55)"
  }
}

export async function GET(req: NextRequest) {
  let drops: Drop[] = []
  let total = 0
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/pack-drops`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j?.drops)) drops = j.drops as Drop[]
      total = j?.meta?.total_drops ?? 0
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
            {total > 0 ? `${total} drops scored` : "Public · No signup"}
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 78, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          PACK DROPS
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
          Vaultopolis re-packs scored against RPC FMV — pack EV vs the price to buy.
        </div>

        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 12 }}>
          {drops.length === 0 ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>
              Scoring the live drops…
            </div>
          ) : (
            drops.slice(0, 3).map((d, i) => (
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
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 720 }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, display: "flex" }}>
                    {d.name ?? `Drop #${d.drop_id}`}
                  </div>
                  <div style={{ fontSize: 15, color: "rgba(255,255,255,0.55)", letterSpacing: 0.5, display: "flex" }}>
                    {d.pack_count != null ? `${d.pack_count} packs` : "—"}
                    {d.pack_price_usd != null ? ` · ~${fmtMoney(d.pack_price_usd)}/pack` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <div style={{ display: "flex", fontSize: 30, fontWeight: 800, color: verdictColor(d.verdict_kind) }}>
                    {fmtMoney(d.rpc_pack_ev_usd)}
                  </div>
                  <div style={{ display: "flex", fontSize: 13, color: "rgba(255,255,255,0.45)", letterSpacing: 1 }}>
                    RPC PACK EV
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
          <div style={{ display: "flex" }}>Real on-chain FMV · not estimates</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/pack-drops</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
