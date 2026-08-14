/**
 * app/api/og/trophy-case/[username]/route.tsx
 *
 * The TROPHY CASE card (1200×630 PNG) — the artifact for "look at my case".
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PROFILE CARD. Until 2026-08-14 the only
 * trophy-case export was a PDF, and a PDF cannot unfurl: pasting it into X or
 * Discord produces a file, not a picture. The profile card does show the case,
 * but it leads with PORTFOLIO FMV and moment counts — it answers "how big is
 * this collection", where sharing a trophy case asks "look at these six". This
 * card gives the Moments the whole canvas and states no portfolio figure at all.
 *
 * ⚠ IT READS THROUGH `getPublicProfile`, NOT `trophy_moments` DIRECTLY, and
 * that is a data-quality decision rather than a convenience. Those rows are
 * PIN-TIME snapshots carrying null tiers and stale prices; the shared module
 * resolves trophies through `get_trophy_slab_data_by_username` so the tier
 * colours and art are the LIVE ones. (The older profile card still reads the
 * raw table — noted in the inbox, not changed here.) That requires the nodejs
 * runtime, which is also what lets this reuse the module instead of
 * reimplementing the username → user_id → trophies lookup a third time.
 */

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { ogImageDataUris } from "@/lib/og/img-data"
import { getPublicProfile } from "@/lib/profile/public-profile"
import { borderCosmetic } from "@/lib/cosmetics"
import { tierAccent, hiResThumb } from "@/lib/trophy/slab-style"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS, type OgFont } from "@/lib/og/brand-fonts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const FALLBACK_ACCENT = "#E03A2F"

/**
 * One row, always — a case reads as a shelf, and a 3×2 grid at this size makes
 * each Moment smaller than the profile card already renders it, which would
 * defeat the point of a dedicated card.
 *
 * Widths are chosen so `n` tiles plus their gaps fill the 1104px content box at
 * every count from 1 to 6.
 */
export function caseTileWidth(count: number): number {
  const n = Math.min(6, Math.max(1, count))
  return [0, 280, 250, 230, 210, 190, 170][n]
}

function renderFallback(fonts?: OgFont[], display = "sans-serif") {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          background: "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
          fontFamily: display,
        }}
      >
        <div style={{ display: "flex", gap: 12, fontSize: 52, fontWeight: 900, letterSpacing: 6 }}>
          <span style={{ color: "#fff" }}>TROPHY</span>
          <span style={{ color: FALLBACK_ACCENT }}>CASE</span>
        </div>
        <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 18, letterSpacing: 2 }}>
          rippackscity.com
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS },
  )
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)

  try {
    const { username: raw } = await params
    const username = decodeURIComponent(raw ?? "").trim()
    if (!username) return renderFallback(fonts, fam.display)

    const result = await getPublicProfile(username, "og-trophy-case")
    if (!result.ok) return renderFallback(fonts, fam.display)

    const { bio, trophies } = result.data
    const accent = (bio.accent_color || FALLBACK_ACCENT).trim() || FALLBACK_ACCENT
    const border = borderCosmetic(bio.equipped_border)
    const displayName = (bio.display_name || username).toUpperCase()

    const rows = (Array.isArray(trophies) ? trophies : [])
      .slice(0, 6)
      .map((t) => t as Record<string, unknown>)
      .filter((t) => !!t.thumbnail_url)

    const uris = await ogImageDataUris(
      rows.map((t) => hiResThumb(t.thumbnail_url as string) ?? "").filter(Boolean),
    )
    const tiles = rows
      .map((t, i) => ({
        art: uris[i],
        tier: (t.tier as string | null) ?? null,
        player: (t.player_name as string | null) ?? null,
      }))
      .filter((t) => !!t.art)

    const w = caseTileWidth(tiles.length)
    const h = Math.round(w * 1.32)

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
            fontFamily: fam.display,
            padding: "34px 48px",
          }}
        >
          {/* Header — identity on the left, what this IS on the right */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 760 }}>
              <div
                style={{
                  display: "flex",
                  color: "#fff",
                  fontSize: 42,
                  fontWeight: 900,
                  letterSpacing: 1,
                  lineHeight: 1.05,
                }}
              >
                {displayName}
              </div>
              <div
                style={{
                  display: "flex",
                  color: "rgba(255,255,255,0.45)",
                  fontSize: 15,
                  fontFamily: fam.mono,
                  letterSpacing: 2,
                }}
              >
                rippackscity.com/profile/{username}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 16px",
                borderRadius: 999,
                border: `2px solid ${border?.ring ?? accent}`,
                color: "#fff",
                fontSize: 17,
                fontWeight: 900,
                letterSpacing: 4,
              }}
            >
              TROPHY CASE
            </div>
          </div>

          <div
            style={{ width: "100%", height: 1, background: accent + "44", display: "flex" }}
          />

          {/* The Moments get the canvas — that is the entire point of this card */}
          <div
            style={{
              display: "flex",
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
            }}
          >
            {tiles.length > 0 ? (
              tiles.map((t, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      width: w,
                      height: h,
                      display: "flex",
                      borderRadius: 10,
                      overflow: "hidden",
                      border: `2px solid ${tierAccent(t.tier)}`,
                      background: "#111",
                      boxShadow: "0 12px 30px rgba(0,0,0,0.55)",
                    }}
                  >
                    <img
                      src={t.art as string}
                      width={w}
                      height={h}
                      style={{ width: w, height: h, objectFit: "cover" }}
                    />
                  </div>
                  {t.player && (
                    <div
                      style={{
                        display: "flex",
                        maxWidth: w,
                        color: "rgba(255,255,255,0.55)",
                        fontSize: 12,
                        fontFamily: fam.mono,
                        letterSpacing: 1,
                        overflow: "hidden",
                      }}
                    >
                      {t.player}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div
                style={{
                  display: "flex",
                  width: "100%",
                  height: "100%",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "rgba(255,255,255,0.2)",
                  fontSize: 22,
                  fontFamily: fam.mono,
                  letterSpacing: 3,
                  border: "1px dashed rgba(255,255,255,0.08)",
                  borderRadius: 12,
                }}
              >
                NO TROPHIES PINNED YET
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 10,
            }}
          >
            <div style={{ display: "flex", gap: 8, fontSize: 15, fontWeight: 900, letterSpacing: 3 }}>
              <span style={{ color: "#fff" }}>RIP PACKS</span>
              <span style={{ color: accent }}>CITY</span>
            </div>
            <div
              style={{
                display: "flex",
                color: "rgba(255,255,255,0.4)",
                fontSize: 12,
                fontFamily: fam.mono,
                letterSpacing: 2,
              }}
            >
              {/* ⚠ Deliberately NOT a portfolio figure. This card is about the
                  six Moments someone chose, and a valuation would both change
                  the subject and re-open the false-$0 class the profile card
                  had to be fixed for. */}
              COLLECTOR INTELLIGENCE
            </div>
          </div>
        </div>
      ),
      { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS },
    )
  } catch {
    return renderFallback(fonts, fam.display)
  }
}
