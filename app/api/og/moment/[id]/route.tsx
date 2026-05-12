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
  const { id } = await params

  let detail: MomentDetail | null = null
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_moment_detail", {
      p_id: id,
    })
    if (!error && data && data.ok !== false) {
      detail = data as MomentDetail
    }
  } catch {
    // Fall through to default card below.
  }

  if (!detail || !detail.edition) {
    return new ImageResponse(<DefaultCard />, { width: 1200, height: 630 })
  }

  const e = detail.edition
  const f = detail.fmv ?? {}
  const serial = detail.resolved?.serial_number ?? null

  const name = e.player_name || e.character_name || "Moment"
  const setLabel = e.set_name || e.franchise || ""
  const tierKey = (e.tier || e.edition_type || "COMMON").toUpperCase()
  const accent = TIER_COLORS[tierKey] ?? FALLBACK_RED
  const collectionTag = collectionLabel(e.collection_slug)
  const fmv = f.fmv_usd ?? f.floor_price_usd ?? f.floor_usd ?? null
  const fmvText = fmtUsd(fmv)
  const image = e.thumbnail_url || null
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
          fontFamily: "sans-serif",
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
    { width: 1200, height: 630 }
  )
}

function DefaultCard() {
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
        fontFamily: "sans-serif",
        fontSize: 96,
        fontWeight: 900,
        letterSpacing: 4,
      }}
    >
      RIP PACKS CITY
    </div>
  )
}
