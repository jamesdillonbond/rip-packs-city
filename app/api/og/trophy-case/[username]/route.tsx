/**
 * app/api/og/trophy-case/[username]/route.tsx
 *
 * The TROPHY CASE card (1200×630 PNG) — the artifact for "look at my case".
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PROFILE CARD. Until 2026-08-14 the only
 * trophy-case export was a PDF, and a PDF cannot unfurl: pasting it into X or
 * Discord produces a file, not a picture. The profile card does show the case,
 * but it leads with collection counts — it answers "how big is this
 * collection", where sharing a trophy case asks "look at these six". This card
 * gives the Moments the whole canvas.
 * ⚠ It used to say the profile card "leads with PORTFOLIO FMV". That figure was
 * removed from the profile card on 2026-09-12 (Trevor's call, and a privacy
 * repair); neither card states a portfolio value now.
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
import { ogImageDataUriSlots } from "@/lib/og/img-data"
import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { editionKey, trophyMarks, type TrophyMark } from "@/lib/og/trophy-marks"
import { withOfficialArt } from "@/lib/og/official-mark-art"
import { trophyDetail } from "@/lib/og/trophy-detail"
import { GOLD_HEX } from "@/lib/badges/glyphs"
import { getPublicProfile } from "@/lib/profile/public-profile"
import { borderCosmetic } from "@/lib/cosmetics"
import { tierAccent, hiResThumb } from "@/lib/trophy/slab-style"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS, type OgFont } from "@/lib/og/brand-fonts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const FALLBACK_ACCENT = "#E03A2F"

/**
 * Budget for the jersey-number read — a DECORATION budget, smaller than either
 * number already in this repo. `lib/og/og-fetch.ts` bounds a card's DATA at 10s
 * because the card cannot render without it; `lib/badges/server-art.ts` bounds
 * badge art at 4s because it blocks a PAGE. This blocks neither: a timeout costs
 * the jersey glyph and nothing else. ⚠ A DATED SAMPLE informs it, not a
 * constant — re-measure before quoting it.
 */
const JERSEY_BUDGET_MS = 2_500

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

    // ⚠ SLOTS, NOT THE COMPACTING VARIANT. `ogImageDataUris` drops failures and
    // closes the gap, so `uris[i]` stopped lining up with `rows[i]` the moment
    // ANY art failed — and until 2026-09-12 two whole collections always failed
    // (Pinnacle's relative URL, All Day's WebP; see lib/og/img-data.ts). The
    // observable result on this card was Kevin Durant's Moment captioned
    // "Amon-Ra St. Brown". A card built for sharing put one collector's art
    // under another player's name, and nothing in CI could see it because the
    // tile count still looked plausible.
    const uris = await ogImageDataUriSlots(
      rows.map((t) => hiResThumb(t.thumbnail_url as string) ?? null),
    )
    // ⚠ A ROW WHOSE ART FAILED KEEPS ITS TILE. Dropping it made the case draw
    // fewer Moments than the collector pinned, with no signal anywhere that a
    // Moment was missing — the trophy is real, only its picture is unavailable,
    // and a named placeholder says that where a silently shorter shelf does not.
    // ── Jersey numbers, the ONE thing the trophy RPC does not already give us ──
    // It reads `editions.jersey_number` (to feed serial_fmv_estimate) but does
    // not return it, so the jersey-match glyph needs this lookup. Everything
    // else a badge row needs — the unified edition badges, the serial and the
    // circulation — is already on the row.
    //
    // ⚠ Keyed on (collection_id, external_id), never external_id alone: that
    // column is unique per COLLECTION. And a failure here costs exactly the
    // jersey glyph — `first` and `perfect` are computed from the row.
    const jerseyByKey = new Map<string, number>()
    const extIds = Array.from(
      new Set(rows.map((t) => (t.edition_id as string | null) ?? "").filter(Boolean)),
    )
    if (extIds.length > 0) {
      try {
        // ⚠ BOUNDED, like every other DB read a card makes — an OG card renders
        // while a social crawler holds the connection, and unbounded this could
        // burn the whole lambda for a row of decoration.
        //
        // ⚠ And bounded TIGHTER than the card's data reads, deliberately.
        // `OG_FETCH_TIMEOUT_MS` is 10s because a card cannot render without its
        // data; this read only decides whether a jersey glyph appears, so it
        // gets the same 2.5s decoration budget as the moment card's badge read
        // rather than ten seconds of a crawler's patience.
        const { data: eds, error: edErr } = await boundedRead(
          (supabaseAdmin as any)
            .from("editions")
            .select("external_id, collection_id, jersey_number")
            .in("external_id", extIds)
            .limit(200),
          "og/trophy-case/jersey_number",
          JERSEY_BUDGET_MS,
        )
        if (edErr) {
          console.warn("[og/trophy-case] jersey lookup failed; jersey glyphs suppressed:", edErr.message)
        } else {
          for (const e of (eds ?? []) as Array<{ external_id: string; collection_id: string; jersey_number: number | null }>) {
            if (e.jersey_number != null) {
              jerseyByKey.set(editionKey(e.collection_id, e.external_id), Number(e.jersey_number))
            }
          }
        }
      } catch (err) {
        console.warn("[og/trophy-case] jersey lookup threw; jersey glyphs suppressed:", err)
      }
    }

    const w = caseTileWidth(rows.length)
    // Characters that fit one line at 10px in a `w`-wide tile. Derived from the
    // width rather than fixed, because this card draws six 170px tiles or one
    // 280px tile from the same code and a budget that suits one clips the other.
    const lineBudget = Math.max(12, Math.floor(w / 5.6))

    const jerseyFor = (t: Record<string, unknown>) =>
      jerseyByKey.get(
        editionKey(t.collection_id as string | null, t.edition_id as string | null),
      ) ?? null

    // Gold special serials first, then edition badges — the Trophy Case PDF's
    // order, so the two artefacts of the same six Moments read the same way.
    //
    // ⚠ `collection_slug` IS LOAD-BEARING HERE, not decorative: it picks the
    // ART TIER. Top Shot resolves to official art inline with no fetch, All Day
    // to official badgesV3 art, and everything else to RPC's own glyphs. Without
    // it every mark silently falls back — and worse, All Day and Top Shot share
    // badge TITLES with different art, so a title resolved without a collection
    // would draw the wrong league's badge.
    const rawMarks = rows.map((t) =>
      trophyMarks(
        {
          badges: t.badges,
          serial_number: (t.serial_number as number | null) ?? null,
          circulation_count: (t.circulation_count as number | null) ?? null,
          collection_slug: (t.collection_slug as string | null) ?? null,
          collection_id: (t.collection_id as string | null) ?? null,
        },
        jerseyFor(t),
        4,
      ),
    )
    // ⭐ ONE deduped pass for the whole card — official platform art where it
    // exists, the zero-network glyph where it does not. See
    // lib/og/official-mark-art.ts for why this is a handful of same-origin
    // fetches rather than the 24 the old comment feared.
    const markRows = await withOfficialArt(rawMarks)

    const tiles = rows.map((t, i) => ({
      art: uris[i] ?? null,
      tier: (t.tier as string | null) ?? null,
      player: (t.player_name as string | null) ?? null,
      // Everything the RPC already returned and this card used to throw away.
      detail: trophyDetail(
        {
          serial_number: (t.serial_number as number | null) ?? null,
          circulation_count: (t.circulation_count as number | null) ?? null,
          tier: (t.tier as string | null) ?? null,
          set_name: (t.set_name as string | null) ?? null,
          series: (t.series as number | string | null) ?? null,
          play_description: (t.play_description as string | null) ?? null,
        },
        jerseyFor(t),
        lineBudget,
      ),
      marks: markRows[i],
    }))
    const artless = tiles.filter((t) => !t.art)
    if (artless.length > 0) {
      console.warn(
        `[og/trophy-case] art unavailable for ${artless.length}/${tiles.length} trophies (${username}):`,
        rows
          .filter((_, i) => !uris[i])
          .map((t) => `${t.player_name ?? "?"} <- ${t.thumbnail_url}`)
          .join(" | "),
      )
    }

    // `w` is derived above, where the line budget needs it.
    const h = Math.round(w * 1.32)
    // Scales with the tile so six Moments do not get bigger badges than one.
    // Floored at 16: below that the monoline geometry stops resolving into a
    // recognisable mark and the row reads as three grey specks.
    const markSize = Math.max(16, Math.min(24, Math.round(w / 9)))

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
                    {t.art ? (
                      <img
                        src={t.art}
                        width={w}
                        height={h}
                        style={{ width: w, height: h, objectFit: "cover" }}
                      />
                    ) : (
                      <div
                        style={{
                          width: w,
                          height: h,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 10,
                          textAlign: "center",
                          color: "rgba(255,255,255,0.3)",
                          fontSize: 11,
                          fontFamily: fam.mono,
                          letterSpacing: 2,
                        }}
                      >
                        ART UNAVAILABLE
                      </div>
                    )}
                  </div>
                  {/* ── THE DETAIL STACK ──────────────────────────────────
                      ⚠ EVERY LINE IS HEIGHT-RESERVED AND ALWAYS RENDERED,
                      for the same reason the badge row below is. The tiles are
                      centred in the shelf, so a Moment missing a line is a
                      SHORTER column that satori centres LOWER — Simba sat 10px
                      below his five neighbours before the badge row was pinned,
                      and three new lines are three new ways to reproduce it.
                      A row with nothing to say draws an empty box of the right
                      height, never no box. */}
                  <div
                    style={{
                      display: "flex",
                      maxWidth: w,
                      height: 16,
                      alignItems: "center",
                      color: "#fff",
                      fontSize: 13,
                      fontWeight: 700,
                      letterSpacing: 0.3,
                      overflow: "hidden",
                    }}
                  >
                    {t.player ?? ""}
                  </div>
                  {/* Serial + tier. ⭐ A special serial is GOLD and it is loud
                      on purpose — a 1-of-1 is the most impressive object in a
                      case and a 16px mark in the row below is not where you put
                      the headline. Tier keeps its own tier colour beside it. */}
                  <div
                    style={{
                      display: "flex",
                      maxWidth: w,
                      height: 14,
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      fontFamily: fam.mono,
                      letterSpacing: 0.5,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        color: t.detail.special ? GOLD_HEX : "rgba(255,255,255,0.72)",
                        fontWeight: t.detail.special ? 900 : 400,
                      }}
                    >
                      {t.detail.serial}
                    </span>
                    {t.detail.tier !== "" && t.detail.serial !== "" && (
                      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
                    )}
                    <span style={{ color: tierAccent(t.tier) }}>{t.detail.tier}</span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      maxWidth: w,
                      height: 13,
                      alignItems: "center",
                      color: "rgba(255,255,255,0.5)",
                      fontSize: 10,
                      fontFamily: fam.mono,
                      letterSpacing: 0.3,
                      overflow: "hidden",
                    }}
                  >
                    {t.detail.set}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      maxWidth: w,
                      height: 13,
                      alignItems: "center",
                      color: "rgba(255,255,255,0.35)",
                      fontSize: 10,
                      fontFamily: fam.mono,
                      letterSpacing: 0.3,
                      overflow: "hidden",
                    }}
                  >
                    {t.detail.context}
                  </div>
                  {/* Badge row — OFFICIAL platform art wherever it exists.
                      Top Shot's marks are inline in the repo (no fetch at all),
                      All Day's are prefetched once per card, and Golazos / UFC /
                      Pinnacle keep RPC's own glyphs because those platforms
                      publish no badge art. Every entry is a data: URI by the
                      time it gets here, so satori fetches nothing.
                      See lib/badges/official-art.ts for the tiering. */}
                  <div
                    style={{
                      // ⚠ ALWAYS RENDERED, even with no badges. The tiles are
                      // centred in the shelf, so a Moment with no badge row is
                      // a SHORTER column and satori centres it lower — Simba
                      // sat 10px below his five neighbours in the first render.
                      // Reserving the height keeps every Moment's art on one
                      // baseline whatever it has earned.
                      display: "flex",
                      gap: 5,
                      height: markSize,
                      alignItems: "center",
                      maxWidth: w,
                    }}
                  >
                    {t.marks.map((m: TrophyMark) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={m.label}
                        src={m.uri}
                        alt={m.label}
                        width={markSize}
                        height={markSize}
                        style={{ width: markSize, height: markSize }}
                      />
                    ))}
                  </div>
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
