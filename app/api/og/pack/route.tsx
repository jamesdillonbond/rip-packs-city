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
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { OgMark } from "@/lib/og/marks"

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
  ev_depletion_pct: number | string | null
  secondary_ask: number | string | null
  secondary_available: boolean | null
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
    .select("title, tier, retail_price_usd, ev_pack_price, pack_ev, gross_ev, value_ratio, is_positive_ev, depletion_pct, ev_depletion_pct, secondary_ask, secondary_available, collection_slug")
    .eq("dist_id", distId)
    .limit(1)
  if (collectionSlug) q = q.eq("collection_slug", collectionSlug)
  // ⚠ supabase-js RETURNS a Postgrest error but THROWS on a transport failure
  // (socket hang-up, DNS, aborted fetch). An uncaught throw escapes GET and 500s
  // the route, which for an OG card is an EMPTY unfurl — the exact failure the
  // render sweep exists to catch. This file's own header promises "never 500";
  // without the catch that held only for the error-return path.
  try {
    const { data, error } = await q.maybeSingle()
    if (error) return null
    return (data as PackRow | null) ?? null
  } catch {
    return null
  }
}

async function fetchAllDayCorrectedOg(
  distId: string,
): Promise<{ corrected_gross_ev: number | null; corrected_net_ev: number | null; corrected_value_ratio: number | null } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, { auth: { persistSession: false } })
  // Lean per-dist view (see migration 20260809170000): same values as
  // v_allday_pack_info without its 1.19M-cost pack_ev_latest join.
  try {
    const { data, error } = await sb
      .from("v_allday_pack_detail_ev")
      .select("corrected_gross_ev, corrected_net_ev, corrected_value_ratio")
      .eq("dist_id", distId)
      .maybeSingle()
    if (error) return null
    return data ?? null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  const sp = req.nextUrl.searchParams
  const distId = sp.get("distId") ?? ""
  const collection = sp.get("collection")

  let row: PackRow | null = null
  if (distId) {
    row = await fetchPack(distId, collection)
  }

  // AllDay: the canonical pack_table_rows EV is the flat trimmed-mean that
  // over-states rare-heavy packs (a $4 pack at $430). Prefer the odds/median
  // corrected EV (v_allday_pack_info) so the social card matches the live pack
  // page (see app/(collections)/[collection]/pack/dist/[distId]/page.tsx).
  let usedCorrectedEv = false
  if (row && (row.collection_slug === "nfl_all_day" || collection === "nfl-all-day") && distId) {
    const corrected = await fetchAllDayCorrectedOg(distId)
    if (corrected && corrected.corrected_gross_ev != null) {
      row = {
        ...row,
        gross_ev: corrected.corrected_gross_ev,
        pack_ev: corrected.corrected_net_ev,
        value_ratio: corrected.corrected_value_ratio,
      }
      usedCorrectedEv = true
    }
  }

  const title = row?.title ?? "Pack"
  const tier = row?.tier ?? "common"
  const accent = tierColor(tier)
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "Pack"

  const retail = num(row?.retail_price_usd)
  const grossEv = num(row?.gross_ev)
  const evDepPct = num(row?.ev_depletion_pct)
  const secAsk = num(row?.secondary_ask)
  // Verdict anchor (2026-07-07 reframe): net / value ratio / +EV compare grossEV
  // ONLY to the live secondary ask — what a sealed pack actually resells for.
  // Retail/primary is irrelevant. No ask → no verdict; the card shows GROSS EV
  // (value still sealed) informationally.
  const secondaryAskAnchor = row?.secondary_available === true && secAsk !== null && secAsk > 0 ? secAsk : null

  // Survivor-biased pull-value EV guard (mirrors the live pack page + SEO). A
  // depleted TS pack's drop pool retains only its rare chases, inflating gross EV
  // 40–86× — never render that as a green "+EV / $801 / 80x" social card. Suppress
  // the EV, value ratio, and verdict when the pool is ≥90% depleted or gross EV >
  // 3× the live secondary ask. AllDay's odds-corrected EV (usedCorrectedEv) is exempt.
  const evSurvivorBiased = !usedCorrectedEv && (
    (evDepPct !== null && evDepPct >= 90) ||
    (secondaryAskAnchor !== null && grossEv !== null && grossEv > 3 * secondaryAskAnchor)
  )

  const packEv = grossEv !== null && secondaryAskAnchor !== null ? grossEv - secondaryAskAnchor : null
  const valueRatio = grossEv !== null && secondaryAskAnchor !== null ? grossEv / secondaryAskAnchor : null
  const isPositive = packEv !== null && packEv > 0
  const hasVerdict = secondaryAskAnchor !== null && !evSurvivorBiased && packEv !== null
  const depletion = row?.depletion_pct ?? null

  const verdictLabel = secondaryAskAnchor === null ? "NO ASK" : evSurvivorBiased ? "EV N/A" : packEv === null ? "EV PENDING" : isPositive ? "+EV" : "−EV"
  const verdictColor = !hasVerdict ? "#9CA3AF" : isPositive ? "#10B981" : "#EF4444"
  const verdictBg = !hasVerdict ? "rgba(156,163,175,0.10)" : isPositive ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)"
  const verdictBorder = !hasVerdict ? "rgba(156,163,175,0.25)" : isPositive ? "rgba(16,185,129,0.30)" : "rgba(239,68,68,0.30)"

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
          fontFamily: fam.display,
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
            <OgMark name="pack" size={26} color="#FF6B35" weight={2} />
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
          <Stat
            label={secondaryAskAnchor !== null ? "SECONDARY ASK" : "RETAIL"}
            value={fmtUsd(secondaryAskAnchor ?? retail)}
            color="#FFFFFF"
          />
          <Stat label="VALUE SEALED" value={evSurvivorBiased ? "—" : fmtUsd(grossEv)} color={hasVerdict && isPositive ? "#10B981" : "#FFFFFF"} />
          <Stat
            label="EV VS ASK"
            value={!hasVerdict || valueRatio === null ? "—" : `${valueRatio.toFixed(2)}x`}
            color={!hasVerdict || valueRatio === null ? "#FFFFFF" : valueRatio >= 1 ? "#10B981" : "#EF4444"}
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
      ...(fonts ? { fonts } : {}),
      headers: OG_CACHE_HEADERS,
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
