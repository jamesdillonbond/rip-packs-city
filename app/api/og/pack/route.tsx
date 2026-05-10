/**
 * app/api/og/pack/route.tsx
 *
 * Dynamic OG image for pack detail pages. Mirrors app/api/og/deal/route.tsx.
 * 1200×630 PNG; edge-cached after first generation.
 *
 * Usage: GET /api/og/pack?distId=5020[&collection=nba-top-shot]
 *
 * Hits pack_table_rows for cached EV. If the row doesn't exist (newly minted
 * pack the cron hasn't picked up) we fall back to a generic "Pack EV" card
 * with just the title — never 500.
 */

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const runtime = "edge"

const TIER_HEX: Record<string, string> = {
  ultimate: "#FFD700",
  legendary: "#FFD700",
  rare: "#A855F7",
  fandom: "#3B82F6",
  uncommon: "#14B8A6",
  premium: "#3B82F6",
  common: "#9CA3AF",
  standard: "#9CA3AF",
}

function tierColor(tier: string | null | undefined): string {
  if (!tier) return TIER_HEX.common
  const k = tier.toString().toLowerCase().replace("moment_tier_", "")
  return TIER_HEX[k] ?? TIER_HEX.common
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString()}`
  return `$${v.toFixed(2)}`
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(v as string)
  return Number.isFinite(n) ? n : null
}

interface PackRow {
  title: string | null
  tier: string | null
  retail_price_usd: number | string | null
  ev_pack_price: number | string | null
  pack_ev: number | string | null
  gross_ev: number | string | null
  value_ratio: number | string | null
  is_positive_ev: boolean | null
  depletion_pct: number | null
  collection_slug: string | null
}

async function fetchPack(distId: string, collectionSlug: string | null): Promise<PackRow | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, { auth: { persistSession: false } })
  let q = sb
    .from("pack_table_rows")
    .select("title, tier, retail_price_usd, ev_pack_price, pack_ev, gross_ev, value_ratio, is_positive_ev, depletion_pct, collection_slug")
    .eq("dist_id", distId)
    .limit(1)
  if (collectionSlug) q = q.eq("collection_slug", collectionSlug)
  const { data, error } = await q.maybeSingle()
  if (error) return null
  return (data as PackRow | null) ?? null
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const distId = sp.get("distId") ?? ""
  const collection = sp.get("collection")

  let row: PackRow | null = null
  if (distId) {
    row = await fetchPack(distId, collection)
  }

  const title = row?.title ?? "Pack"
  const tier = row?.tier ?? "common"
  const accent = tierColor(tier)
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "Pack"

  const price = num(row?.ev_pack_price ?? row?.retail_price_usd)
  const grossEv = num(row?.gross_ev)
  const valueRatio = num(row?.value_ratio)
  const packEv = num(row?.pack_ev)
  const isPositive = packEv !== null ? packEv > 0 : row?.is_positive_ev === true
  const depletion = row?.depletion_pct ?? null

  const verdictLabel = packEv === null ? "EV PENDING" : isPositive ? "+EV" : "−EV"
  const verdictColor = packEv === null ? "#9CA3AF" : isPositive ? "#10B981" : "#EF4444"
  const verdictBg = packEv === null ? "rgba(156,163,175,0.10)" : isPositive ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)"
  const verdictBorder = packEv === null ? "rgba(156,163,175,0.25)" : isPositive ? "rgba(16,185,129,0.30)" : "rgba(239,68,68,0.30)"

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(145deg, #0a0a1a 0%, #111128 50%, #0d0d20 100%)",
          padding: "48px 56px",
          fontFamily: "sans-serif",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Tier accent bar (left edge) */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 8,
            background: accent,
            display: "flex",
          }}
        />

        {/* Background glow */}
        <div
          style={{
            position: "absolute",
            top: "-100px",
            right: "-100px",
            width: "400px",
            height: "400px",
            borderRadius: "50%",
            background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)`,
            display: "flex",
          }}
        />

        {/* Header row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 26, lineHeight: 1, display: "flex" }}>📦</div>
            <div
              style={{
                color: "#FF6B35",
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: "2px",
                display: "flex",
              }}
            >
              PACK EV
            </div>
          </div>
          <div
            style={{
              color: accent,
              fontSize: 14,
              fontWeight: 700,
              padding: "4px 12px",
              borderRadius: 4,
              background: `${accent}1A`,
              border: `1px solid ${accent}55`,
              letterSpacing: "1px",
              display: "flex",
              textTransform: "uppercase",
            }}
          >
            {tierLabel}
          </div>
        </div>

        {/* Title */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 24, flex: 1 }}>
          <div
            style={{
              color: "#FFFFFF",
              fontSize: 52,
              fontWeight: 800,
              lineHeight: 1.1,
              display: "flex",
              maxWidth: 1080,
              overflow: "hidden",
            }}
          >
            {title}
          </div>
        </div>

        {/* Metric row */}
        <div
          style={{
            display: "flex",
            gap: 40,
            alignItems: "flex-end",
            marginTop: "auto",
          }}
        >
          <Stat label="PACK PRICE" value={fmtUsd(price)} color="#FFFFFF" />
          <Stat label="GROSS EV" value={fmtUsd(grossEv)} color={isPositive ? "#10B981" : "#FFFFFF"} />
          <Stat
            label="VALUE RATIO"
            value={valueRatio === null ? "—" : `${valueRatio.toFixed(2)}x`}
            color={valueRatio === null ? "#FFFFFF" : valueRatio >= 1 ? "#10B981" : "#EF4444"}
          />

          <div
            style={{
              color: verdictColor,
              fontSize: 28,
              fontWeight: 800,
              padding: "10px 20px",
              borderRadius: 8,
              background: verdictBg,
              border: `1px solid ${verdictBorder}`,
              display: "flex",
              alignItems: "center",
              marginLeft: "auto",
            }}
          >
            {verdictLabel}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 24,
            paddingTop: 16,
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div style={{ color: "#6B7280", fontSize: 14, fontWeight: 500, display: "flex" }}>
            {depletion === null ? "Cached snapshot via Rip Packs City" : `${depletion}% sealed packs sold`}
          </div>
          <div
            style={{
              color: "#FF6B35",
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 1,
              display: "flex",
            }}
          >
            RIP PACKS CITY
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          color: "#6B7280",
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "2px",
          marginBottom: 4,
          display: "flex",
        }}
      >
        {label}
      </div>
      <div
        style={{
          color,
          fontSize: 48,
          fontWeight: 800,
          lineHeight: 1,
          display: "flex",
        }}
      >
        {value}
      </div>
    </div>
  )
}
