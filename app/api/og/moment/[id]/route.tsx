// app/api/og/moment/[id]/route.tsx
//
// Per-moment Open Graph card. 1200×630 PNG rendered via next/og's
// ImageResponse. Pulls thumbnail + tier color band + FMV out of
// get_moment_detail and lays them out as a Twitter/Discord/Slack unfurl.
//
// Routing already covers `/api/og/*` in proxy.ts isPublicPath, so this
// endpoint is reachable unauthenticated for social-share crawlers.
//
// runtime = "nodejs" because supabaseAdmin uses the @supabase/supabase-js
// service-role client (postgres connections aren't reliably edge-safe).
// The deal card uses runtime="edge" because it has no DB dependency.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { ogImageDataUri } from "@/lib/og/img-data"
import { isMarketClosed } from "@/lib/market-closed"
import { urlSlugForCollection } from "@/lib/moment-detail-format"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { boundedRead } from "@/lib/api/bounded-read"
import { trophyMarks, type TrophyMark } from "@/lib/og/trophy-marks"
import { OG_FETCH_TIMEOUT_MS } from "@/lib/og/og-fetch"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Hex literals here (not var(--rpc-*) tokens) because next/og's satori
// renderer doesn't resolve CSS custom properties. Values mirror the
// in-app tier accents from app/moment/[id]/page.tsx tierColorVar().
const TIER_COLORS: Record<string, string> = {
  COMMON: "#9CA3AF",
  FANDOM: "#10B981",
  RARE: "#3B82F6",
  LEGENDARY: "#F59E0B",
  ULTIMATE: "#EF4444",
  CONTENDER: "#9CA3AF",
  CHALLENGER: "#3B82F6",
  UNCOMMON: "#10B981",
}

const FALLBACK_RED = "#E03A2F"

interface MomentEdition {
  /** UUID. `resolved.edition_id` is the same value; this is the fallback. */
  id?: string | null
  player_name?: string | null
  character_name?: string | null
  set_name?: string | null
  franchise?: string | null
  tier?: string | null
  edition_type?: string | null
  thumbnail_url?: string | null
  circulation_count?: number | null
  collection_slug?: string | null
}

interface MomentFmv {
  fmv_usd?: number | null
  floor_price_usd?: number | null
  floor_usd?: number | null
}

interface MomentResolved {
  kind?: "moment" | "edition" | null
  serial_number?: number | null
  /** The edition's UUID — what the badge and jersey reads key on. */
  edition_id?: string | null
}

interface MomentDetail {
  ok?: boolean
  resolved?: MomentResolved | null
  edition?: MomentEdition | null
  fmv?: MomentFmv | null
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ""
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + n.toFixed(2)
}

function collectionLabel(slug: string | null | undefined): string {
  switch (slug) {
    case "nba_top_shot": return "NBA TOP SHOT"
    case "nfl_all_day": return "NFL ALL DAY"
    case "laliga_golazos": return "LALIGA GOLAZOS"
    case "ufc_strike": return "UFC STRIKE"
    case "disney_pinnacle": return "DISNEY PINNACLE"
    default: return "RIP PACKS CITY"
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  const { id } = await params

  let detail: MomentDetail | null = null
  try {
    const { data, error } = await boundedRead(
      (supabaseAdmin as any).rpc("get_moment_detail", { p_id: id }),
      "og/moment/get_moment_detail",
      OG_FETCH_TIMEOUT_MS,
    )
    if (!error && data && data.ok !== false) {
      detail = data as MomentDetail
    }
  } catch {
    // Fall through to default card below.
  }

  if (!detail || !detail.edition) {
    return new ImageResponse(<DefaultCard family={fam.display} />, { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS })
  }

  const e = detail.edition
  const f = detail.fmv ?? {}
  const serial = detail.resolved?.serial_number ?? null

  const name = e.player_name || e.character_name || "Moment"
  const setLabel = e.set_name || e.franchise || ""
  const tierKey = (e.tier || e.edition_type || "COMMON").toUpperCase()
  const accent = TIER_COLORS[tierKey] ?? FALLBACK_RED
  const collectionTag = collectionLabel(e.collection_slug)
  // Suppress the "Current FMV" figure on a closed market (UFC) — the carried-
  // forward value is frozen at the last trading day and reading it as current on
  // a social unfurl is the same overclaim the moment page just dropped.
  const marketClosed = isMarketClosed(urlSlugForCollection(e.collection_slug))
  const fmv = marketClosed ? null : (f.fmv_usd ?? f.floor_price_usd ?? f.floor_usd ?? null)
  const fmvText = fmtUsd(fmv)
  // Pre-fetched to a data URI (failures -> null -> "No media" branch) so a
  // dead/slow upstream can never 500 the card. See lib/og/img-data.ts.
  const image = await ogImageDataUri(e.thumbnail_url)

  // ── Badges: edition-wide, plus the special serials ────────────────────────
  // Trevor, 2026-09-12 — the share image "needs to also include edition-wide
  // badges (debut, rookie, championship, etc) along with special serial badges".
  //
  // ⚠ Unlike the two trophy cards, this one has to ASK. They read
  // `get_trophy_slab_data`, which already returns the unified badge list;
  // `get_moment_detail` does not, so the canonical source is called directly
  // here rather than inferred from anything already on the page.
  //
  // ⚠ AND ITS BUDGET IS A DECORATION BUDGET, deliberately smaller than either
  // number already in this repo. `lib/og/og-fetch.ts` bounds a card's DATA at
  // 10s because a card cannot render without it, and `lib/badges/server-art.ts`
  // bounds badge art at 4s because it blocks a PAGE. This blocks neither: a
  // failed read costs the badge row and nothing else, while the crawler waits
  // either way. Sized off the observed band — pg_stat_statements, 23,868 calls
  // of get_edition_badges_unified: mean 64.9ms, sd 176.4ms, max 3,850ms — so
  // 2.5s is 38× the mean and only truncates a tail where the whole card is
  // already at risk. ⚠ A DATED SAMPLE; re-measure before quoting it.
  const BADGE_BUDGET_MS = 2_500
  const editionUuid = detail.resolved?.edition_id ?? e.id ?? null
  let badgeTitles: string[] = []
  let jerseyNumber: number | null = null
  if (editionUuid) {
    const [badgeRes, jerseyRes] = await Promise.all([
      boundedRead(
        (supabaseAdmin as any).rpc("get_edition_badges_unified", { p_edition_id: editionUuid }),
        "og/moment/get_edition_badges_unified",
        BADGE_BUDGET_MS,
      ).catch(() => ({ data: null, error: true })),
      boundedRead(
        (supabaseAdmin as any).from("editions").select("jersey_number").eq("id", editionUuid).maybeSingle(),
        "og/moment/jersey_number",
        BADGE_BUDGET_MS,
      ).catch(() => ({ data: null, error: true })),
    ])
    if (!badgeRes.error && Array.isArray(badgeRes.data)) {
      badgeTitles = (badgeRes.data as Array<{ title?: string | null }>)
        .map((b) => (typeof b?.title === "string" ? b.title.trim() : ""))
        .filter(Boolean)
    }
    const jn = (jerseyRes as { data?: { jersey_number?: number | null } | null }).data?.jersey_number
    if (!jerseyRes.error && jn != null) jerseyNumber = Number(jn)
  }
  // Gold special serials first, then edition badges — the order the Trophy Case
  // PDF and both trophy cards already draw them in.
  const marks: TrophyMark[] = trophyMarks(
    {
      badges: badgeTitles,
      serial_number: serial,
      circulation_count: e.circulation_count ?? null,
    },
    jerseyNumber,
    5,
  )
  const serialText = serial
    ? `#${serial}${e.circulation_count ? `/${e.circulation_count}` : ""}`
    : (e.circulation_count ? `${e.circulation_count} circulation` : "")

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#000",
          color: "#fff",
          fontFamily: fam.display,
        }}
      >
        <div
          style={{
            width: 630,
            height: 630,
            padding: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 550,
              height: 550,
              border: `4px solid ${accent}`,
              borderRadius: 16,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#0a0a0a",
            }}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image}
                alt={name}
                width={550}
                height={550}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <div
                style={{
                  display: "flex",
                  color: "#666",
                  fontSize: 22,
                  letterSpacing: 6,
                  textTransform: "uppercase",
                }}
              >
                No media
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            padding: "60px 60px 60px 0",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div
              style={{
                fontSize: 18,
                letterSpacing: 4,
                textTransform: "uppercase",
                color: "#9CA3AF",
                display: "flex",
              }}
            >
              {collectionTag} · {tierKey}
            </div>
            <div
              style={{
                fontSize: 60,
                fontWeight: 900,
                lineHeight: 1.05,
                letterSpacing: 1,
                display: "flex",
              }}
            >
              {name}
            </div>
            {serialText ? (
              <div style={{ fontSize: 26, color: "#D1D5DB", display: "flex" }}>
                {serialText}
              </div>
            ) : null}
            {setLabel ? (
              <div style={{ fontSize: 22, color: "#9CA3AF", display: "flex" }}>
                {setLabel}
              </div>
            ) : null}
            {/* Badge row. This card has room the trophy tiles do not, so each
                mark is LABELLED — a glyph alone tells a reader who does not
                already know the vocabulary nothing, and this is the card a
                collector posts to people outside the hobby. */}
            {marks.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4, maxWidth: 500 }}>
                {marks.map((m) => (
                  <div
                    key={m.label}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 10px 5px 7px",
                      borderRadius: 999,
                      border: `1px solid ${m.special ? "rgba(245,158,11,0.45)" : "rgba(255,255,255,0.14)"}`,
                      background: m.special ? "rgba(245,158,11,0.10)" : "rgba(255,255,255,0.04)",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.uri} alt={m.label} width={20} height={20} style={{ width: 20, height: 20 }} />
                    <div
                      style={{
                        display: "flex",
                        fontSize: 14,
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        color: m.special ? "#F5C56B" : "#D1D5DB",
                      }}
                    >
                      {m.label}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {fmvText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  fontSize: 14,
                  letterSpacing: 4,
                  textTransform: "uppercase",
                  color: "#9CA3AF",
                  display: "flex",
                }}
              >
                Current FMV
              </div>
              <div
                style={{
                  fontSize: 72,
                  fontWeight: 900,
                  color: accent,
                  display: "flex",
                }}
              >
                {fmvText}
              </div>
            </div>
          ) : (
            <div
              style={{
                fontSize: 18,
                letterSpacing: 4,
                textTransform: "uppercase",
                color: FALLBACK_RED,
                display: "flex",
              }}
            >
              RIP PACKS CITY
            </div>
          )}
        </div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS }
  )
}

function DefaultCard({ family }: { family: string }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
        color: FALLBACK_RED,
        fontFamily: family,
        fontSize: 96,
        fontWeight: 900,
        letterSpacing: 4,
      }}
    >
      RIP PACKS CITY
    </div>
  )
}
