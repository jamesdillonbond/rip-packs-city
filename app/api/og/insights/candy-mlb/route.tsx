// app/api/og/insights/candy-mlb/route.tsx
//
// Open Graph card for /insights/candy-mlb (Candy MLB ICONs, Solana). 1200x630
// PNG rendered server-side via next/og.
//
// TWO DELIBERATE DEVIATIONS from the sibling /api/og/insights/* routes:
//
//  1. It reads `candy_secondary_board` DIRECTLY via supabaseAdmin instead of
//     self-fetching `/api/public/insights/candy-mlb`. Every other card does the
//     self-fetch, but this surface is launch-gated in proxy.ts — a server-side
//     fetch to its own origin goes back THROUGH the proxy and gets 302'd to
//     /login while CANDY_MLB_PUBLIC is false, so a self-fetching card would
//     silently render the fallback headline for the whole staging period and
//     then quietly start working at go-live. Reading the view directly makes
//     the card identical before and after the flip, which is the only way it
//     can actually be verified pre-launch.
//
//  2. The headline counts PRICED editions, not total editions. 125 editions
//     exist; 91 have a sales-derived FMV. Leading with 125 would imply full
//     coverage on a days-old market. See the honesty framing on the board
//     itself ("an early read, not a census").
//
// Satori can't read CSS vars, so the hex literals here are the allowed
// brand-token exception. Every div carries an explicit `display` — Satori
// throws on multi-child divs without it (see memory: rpc-competitor-recon
// OG Satori gotcha).

import { ImageResponse } from "next/og"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RPC_RED = "#E03A2F"
const CANDY_ORANGE = "#FB923C"

export async function GET() {
  let priced: number | null = null
  let total: number | null = null

  try {
    const sb = supabaseAdmin as any
    const { data } = await sb
      .from("candy_secondary_board")
      .select("fmv_usd")
      .limit(500)
    if (Array.isArray(data) && data.length > 0) {
      total = data.length
      priced = data.filter((r: { fmv_usd: number | null }) => r.fmv_usd != null).length
    }
  } catch {
    /* generic card fallback */
  }

  const headline =
    priced != null && total != null && priced > 0
      ? `${priced} of ${total} ICON editions priced off live Solana sales`
      : "Live secondary FMV for the 2026 MLB Base Series"

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
          <div style={{ fontSize: 18, letterSpacing: 6, color: RPC_RED, textTransform: "uppercase", display: "flex" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            Public · No signup
          </div>
        </div>

        <div
          style={{
            marginTop: 26,
            fontSize: 16,
            letterSpacing: 4,
            color: CANDY_ORANGE,
            textTransform: "uppercase",
            display: "flex",
          }}
        >
          Candy Digital · Solana
        </div>

        <div
          style={{
            marginTop: 10,
            fontSize: 84,
            fontWeight: 900,
            letterSpacing: 1.5,
            lineHeight: 1.0,
            display: "flex",
          }}
        >
          MLB ICONS
        </div>

        <div
          style={{
            marginTop: 18,
            fontSize: 30,
            color: CANDY_ORANGE,
            letterSpacing: 0.5,
            lineHeight: 1.2,
            display: "flex",
            maxWidth: 1040,
          }}
        >
          {headline}
        </div>

        <div
          style={{
            marginTop: 16,
            fontSize: 24,
            color: "rgba(255,255,255,0.62)",
            lineHeight: 1.35,
            display: "flex",
            maxWidth: 1000,
          }}
        >
          Magic Eden shows you a listing. We show you fair market value, the best standing
          offer, pack EV, and who actually holds the supply — an early read on a days-old market.
        </div>

        <div style={{ flex: 1, display: "flex" }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <div style={{ display: "flex" }}>2026 MLB Base Series · ICONs + Rainbows</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/candy-mlb</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
