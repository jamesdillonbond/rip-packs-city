// app/api/og/insights/[slug]/route.tsx
//
// DEFAULT Open Graph card for any /insights board that has no bespoke card of
// its own. 1200×630 PNG, TEXT ONLY: the board's name and description from
// lib/insights/board-registry.ts, the brand eyebrow and the URL.
//
// WHY (platform review 2026-10-11, §3 E5). Three boards unfurled as somebody
// else's picture: account-value and tc-report borrowed the /insights HUB card
// ("THINGS TOP SHOT WON'T TELL YOU"), panini-premiums borrowed Panini's
// COLLECTION card. A share of "what's my account worth?" that previews as the
// hub is a link with the wrong promise on it. A text-only default needs no
// per-board route file and no data fetch, so it cannot publish a stale or
// fabricated number — which is also why it does not use lib/og/board-empty-copy:
// there is no board READ here to be empty or to fail.
//
// Route resolution: Next prefers a STATIC sibling (app/api/og/insights/<slug>/)
// over this dynamic segment, so a board that later gets its own card simply
// shadows this one. Unknown slugs 404 (not a generic card — a 200 PNG for a
// non-existent board would be the "failed read rendered as an answer" class).

import { ImageResponse } from "next/og"
import { NextRequest, NextResponse } from "next/server"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { FALLBACK_RED } from "@/lib/og/entity-card"
import { getInsightsBoard } from "@/lib/insights/board-registry"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Satori does not ellipsise; a registry description can run to 250 chars. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  const board = getInsightsBoard(slug)
  if (!board) {
    return NextResponse.json({ ok: false, error: `no insights board "${slug}"` }, { status: 404 })
  }

  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)
  const kicker = board.kind === "tool" ? "Free wallet tool · No signup" : "Free · No signup · Public data"

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
          <div style={{ fontSize: 18, letterSpacing: 6, color: FALLBACK_RED, textTransform: "uppercase", display: "flex" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex", fontFamily: fam.mono }}>{kicker}</div>
        </div>

        <div
          style={{
            marginTop: 36,
            fontSize: board.name.length > 40 ? 64 : 84,
            fontWeight: 900,
            letterSpacing: 1,
            lineHeight: 1.02,
            display: "flex",
            textTransform: "uppercase",
            maxWidth: 1080,
          }}
        >
          {board.name}
        </div>

        <div
          style={{
            marginTop: 26,
            fontSize: 26,
            color: "rgba(255,255,255,0.72)",
            lineHeight: 1.35,
            display: "flex",
            maxWidth: 1040,
            fontFamily: fam.mono,
          }}
        >
          {clamp(board.description, 210)}
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            color: "rgba(255,255,255,0.55)",
            borderTop: `3px solid ${FALLBACK_RED}`,
            paddingTop: 20,
            fontFamily: fam.mono,
          }}
        >
          <div style={{ display: "flex" }}>{board.kind === "tool" ? "Paste a wallet · see your answer" : "Read by machines and collectors alike"}</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/{board.slug}</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS },
  )
}
