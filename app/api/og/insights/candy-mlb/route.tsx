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
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RPC_RED = "#E03A2F"
const CANDY_ORANGE = "#FB923C"

export async function GET() {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  let priced: number | null = null
  let total: number | null = null
  // "Did the read SUCCEED?", not "did it return rows" — the same contract as
  // lib/og/board-empty-copy.ts. See the note below on why that helper is not
  // imported here.
  let fetched = false

  try {
    const sb = supabaseAdmin as any
    // ⚠ `error` is destructured DELIBERATELY. supabase-js RESOLVES with
    // `{ data: null, error }` instead of throwing, so before this the `catch`
    // below was very nearly dead code: a failed read skipped it entirely, left
    // `priced`/`total` at null, and fell through to the same branch as a
    // genuinely empty board. That is this repo's most-repeated defect class —
    // a failed read rendering as a fact — and on this card the fact asserted
    // was liveness ("Live secondary FMV") that had not been measured.
    const { data, error } = await sb
      .from("candy_secondary_board")
      .select("fmv_usd")
      .limit(500)
    if (error) throw error
    if (Array.isArray(data)) {
      fetched = true
      total = data.length
      priced = data.filter((r: { fmv_usd: number | null }) => r.fmv_usd != null).length
    }
  } catch {
    // `fetched` stays false. The card must not claim liveness it could not measure.
  }

  // THREE states, not two. Wording matches lib/og/board-empty-copy.ts so this
  // card speaks the same voice as the other fifteen insights cards.
  //
  // ⚠ That helper is deliberately NOT imported, and this is not an evasion.
  // __tests__/api-og-insights-empty-vs-unavailable.test.ts selects its
  // population with `includes("boardEmptyCopy(")` and drives every member by
  // mocking `globalThis.fetch`. This card reads `supabaseAdmin` DIRECTLY and on
  // purpose — a self-fetch goes back through proxy.ts and is 302'd to /login
  // while the surface is launch-gated (see this card's own test header) — so a
  // fetch mock cannot drive it and importing the helper would enrol it in a
  // guard that is structurally unable to exercise it. The honesty property is
  // pinned instead by __tests__/api-og-insights-candy-mlb-honesty.test.ts,
  // which asserts the rendered TEXT for all three states.
  const headline = !fetched
    ? "Couldn't load the live board — open the page for current data."
    : priced != null && total != null && priced > 0
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
          fontFamily: fam.display,
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
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  )
}
