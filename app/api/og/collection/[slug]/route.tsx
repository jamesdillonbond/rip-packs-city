/**
 * app/api/og/collection/[slug]/route.tsx
 *
 * Dynamic OG card for collection landing pages (1200×630 PNG). Pulls the
 * collection metadata from lib/collections plus a one-line stat (active
 * editions count) from Supabase via REST. Falls back to a branded card
 * if the slug is unknown or the stat lookup fails — never blocks the
 * social-share preview.
 */

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

export const runtime = "edge"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""

const COLLECTION_LABELS: Record<string, { label: string; accent: string; icon: string; pitch: string }> = {
  "nba-top-shot":   { label: "NBA Top Shot",   accent: "#E03A2F", icon: "🏀", pitch: "FMV pricing, deal sniper, pack EV, badge tracker" },
  "nfl-all-day":    { label: "NFL All Day",    accent: "#4F94D4", icon: "🏈", pitch: "Wallet analytics, pack EV, marketplace intelligence" },
  "laliga-golazos": { label: "LaLiga Golazos", accent: "#22C55E", icon: "⚽", pitch: "Relative deal scoring + FMV intelligence" },
  "disney-pinnacle":{ label: "Disney Pinnacle",accent: "#A855F7", icon: "✨", pitch: "Pin analytics + variant tracking" },
  "ufc":            { label: "UFC Strike",     accent: "#EF4444", icon: "🥊", pitch: "Catalog browser + portfolio tracking" },
}

async function fetchEditionCount(uuid: string): Promise<number | null> {
  if (!uuid || !SUPABASE_URL || !SERVICE_KEY) return null
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/editions?collection_id=eq.${uuid}&select=id`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: "Bearer " + SERVICE_KEY,
          Prefer: "count=exact",
          Range: "0-0",
        },
        cache: "no-store",
      }
    )
    const range = r.headers.get("content-range") ?? ""
    const m = range.match(/\/(\d+)$/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

function renderFallback(label: string, accent: string) {
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
          background: "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
          fontFamily: "sans-serif",
          gap: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            fontSize: 64,
            fontWeight: 900,
            letterSpacing: 6,
            textTransform: "uppercase",
          }}
        >
          <span style={{ color: "#fff" }}>{label.toUpperCase()}</span>
        </div>
        <div
          style={{
            color: accent,
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontWeight: 700,
          }}
        >
          RIP PACKS CITY
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    }
  )
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params
    const meta = COLLECTION_LABELS[slug] ?? null
    if (!meta) return renderFallback("Rip Packs City", "#E03A2F")

    const uuid = COLLECTION_UUID_BY_SLUG[slug]
    const editionCount = uuid ? await fetchEditionCount(uuid) : null

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
            fontFamily: "sans-serif",
            position: "relative",
            padding: "56px 64px",
          }}
        >
          {/* Header strip */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span style={{ color: "#fff",      fontSize: 18, fontWeight: 800, letterSpacing: 3, textTransform: "uppercase" }}>RIP PACKS</span>
            <span style={{ color: meta.accent, fontSize: 18, fontWeight: 800, letterSpacing: 3, textTransform: "uppercase" }}>CITY</span>
          </div>
          <div style={{ width: "100%", height: 1, background: "rgba(255,255,255,0.08)", display: "flex", marginBottom: 40 }} />

          {/* Body */}
          <div style={{ display: "flex", alignItems: "center", gap: 28, marginBottom: 28 }}>
            <div
              style={{
                width: 96, height: 96, borderRadius: 18,
                background: meta.accent + "22",
                border: "2px solid " + meta.accent,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 56,
              }}
            >
              {meta.icon}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  color: "#fff",
                  fontSize: 64,
                  fontWeight: 900,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  lineHeight: 1.0,
                  display: "flex",
                }}
              >
                {meta.label}
              </div>
              <div
                style={{
                  color: meta.accent,
                  fontSize: 16,
                  fontWeight: 700,
                  letterSpacing: 4,
                  textTransform: "uppercase",
                  display: "flex",
                }}
              >
                Collector Intelligence
              </div>
            </div>
          </div>

          <div
            style={{
              color: "rgba(255,255,255,0.7)",
              fontSize: 24,
              lineHeight: 1.4,
              display: "flex",
              maxWidth: 1000,
              marginBottom: 40,
            }}
          >
            {meta.pitch}.
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", gap: 18 }}>
            {[
              { label: "EDITIONS", value: editionCount != null ? editionCount.toLocaleString() : "—" },
              { label: "FMV",      value: "LIVE" },
              { label: "DEALS",    value: "REAL-TIME" },
            ].map((s) => (
              <div
                key={s.label}
                style={{
                  display: "flex", flexDirection: "column",
                  padding: "20px 26px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 12,
                  minWidth: 220,
                }}
              >
                <div style={{ color: "#fff", fontSize: 36, fontWeight: 800, lineHeight: 1, display: "flex" }}>{s.value}</div>
                <div
                  style={{
                    color: "rgba(255,255,255,0.4)",
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 2,
                    textTransform: "uppercase",
                    marginTop: 10,
                    display: "flex",
                  }}
                >
                  {s.label}
                </div>
              </div>
            ))}
          </div>

          {/* Bottom bar */}
          <div style={{ width: "100%", height: 1, background: meta.accent + "33", display: "flex", marginTop: "auto" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <div
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 3,
                textTransform: "uppercase",
                display: "flex",
              }}
            >
              FLOW BLOCKCHAIN
            </div>
            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, display: "flex" }}>rippackscity.com</div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
        },
      }
    )
  } catch {
    return renderFallback("Rip Packs City", "#E03A2F")
  }
}
