/**
 * app/api/og/pack/lifecycle/route.tsx
 *
 * Dynamic OG image for the pack *lifecycle* pages
 * (app/(collections)/[collection]/pack/[id]/page.tsx). Distinct from
 * app/api/og/pack/route.tsx, which cards a distribution's EV — this one
 * cards a single opened/sealed pack keyed by its on-chain NFT id, rendering
 * the gross pull value, cost basis, and the top pulls, from the same
 * get_pack_lifecycle(p_pack_nft_id) payload the page uses.
 *
 * 1200×630 PNG; edge-cached after first generation.
 *
 * Usage: GET /api/og/pack/lifecycle?id=<packNftId>[&collection=nba-top-shot]
 *
 * Hits the get_pack_lifecycle RPC. If the pack is unknown / unresolved (newly
 * seen pack the indexer hasn't caught, or a bad id) we fall back to a generic
 * "PACK RIP" card with just the id — never 500.
 */

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"
import { OgMark } from "@/lib/og/marks"
import { boundedRead } from "@/lib/api/bounded-read"
import { OG_FETCH_TIMEOUT_MS } from "@/lib/og/og-fetch"

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
  // UFC Strike vocab
  challenger: "#FFD700",
  contender: "#A855F7",
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
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v as string)
  return Number.isFinite(n) ? n : null
}

interface Pull {
  player_name: string | null
  tier: string | null
  current_fmv: number | string | null
}

interface Lifecycle {
  status: "sealed" | "ripped" | "unknown"
  pack_name: string | null
  distribution: { title: string; tier: string | null; depletion_pct: number | null; retail_price_usd: number | null } | null
  stats: {
    total_cost_basis: number | string | null
    currency: string | null
    gross_pull_value_usd: number | string | null
  }
  pulls: Pull[]
  error?: string | null
}

async function fetchLifecycle(packNftId: string): Promise<Lifecycle | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, { auth: { persistSession: false } })
  // ⚠ The try/catch is load-bearing, not defensive habit. supabase-js RETURNS a
  // Postgrest error but THROWS on a transport failure (socket hang-up, DNS,
  // aborted fetch), and an uncaught throw here escapes GET and 500s the route —
  // which for an OG card means an EMPTY unfurl, the exact failure the render
  // sweep exists to prevent. This card's own contract is "fall back to a generic
  // card, never 500"; without this it held only for the error-return path.
  try {
    const { data, error } = await boundedRead(sb.rpc("get_pack_lifecycle", { p_pack_nft_id: packNftId }), "og/pack/lifecycle/get_pack_lifecycle", OG_FETCH_TIMEOUT_MS)
    if (error || !data || typeof data !== "object") return null
    return data as Lifecycle
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
  const id = sp.get("id") ?? ""

  let lc: Lifecycle | null = null
  if (id) lc = await fetchLifecycle(id)

  const resolved = lc && lc.status !== "unknown" && !lc.error
  const distTitle = lc?.distribution?.title ?? null
  const title = distTitle ?? lc?.pack_name ?? (id ? `Pack #${id}` : "Pack")
  const tier = lc?.distribution?.tier ?? null
  const accent = tierColor(tier)
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase() : "Pack"

  const isRipped = resolved && lc!.status === "ripped"
  const grossUsd = num(lc?.stats?.gross_pull_value_usd)
  const basis = num(lc?.stats?.total_cost_basis)
  const retail = num(lc?.distribution?.retail_price_usd ?? null)
  const paidAnchor = basis ?? retail

  // Delta vs cost — only when both gross and a cost anchor resolve. DUC is
  // 1:1 USD so total_cost_basis compares directly to gross_pull_value_usd,
  // matching the live page's ROI math.
  const delta = isRipped && grossUsd !== null && basis !== null ? grossUsd - basis : null
  const isPositive = delta !== null && delta > 0
  const hasDelta = delta !== null

  // Top pulls by FMV — up to 3, name + tier chip + FMV.
  const topPulls = (resolved && Array.isArray(lc!.pulls) ? lc!.pulls : [])
    .map((p) => ({ name: p.player_name, tier: p.tier, fmv: num(p.current_fmv) }))
    .filter((p) => p.name)
    .sort((a, b) => (b.fmv ?? -Infinity) - (a.fmv ?? -Infinity))
    .slice(0, 3)

  const eyebrow = isRipped ? "PACK RIP" : resolved && lc!.status === "sealed" ? "SEALED PACK" : "PACK"
  const depletion = lc?.distribution?.depletion_pct ?? null

  const verdictLabel = !isRipped ? (resolved ? "SEALED" : "PACK") : !hasDelta ? "RIPPED" : isPositive ? "+ROI" : "−ROI"
  const verdictColor = !hasDelta ? "#9CA3AF" : isPositive ? "#10B981" : "#EF4444"
  const verdictBg = !hasDelta ? "rgba(156,163,175,0.10)" : isPositive ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)"
  const verdictBorder = !hasDelta ? "rgba(156,163,175,0.25)" : isPositive ? "rgba(16,185,129,0.30)" : "rgba(239,68,68,0.30)"

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
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 8, background: accent, display: "flex" }} />

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <OgMark name={isRipped ? "burst" : "pack"} size={26} color="#FF6B35" weight={2} />
            <div style={{ color: "#FF6B35", fontSize: 22, fontWeight: 800, letterSpacing: "2px", display: "flex" }}>
              {eyebrow}
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
        <div style={{ display: "flex", flexDirection: "column", marginTop: 20 }}>
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

        {/* Top pulls strip (ripped only) */}
        {topPulls.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 24 }}>
            <div
              style={{
                color: "#6B7280",
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "2px",
                display: "flex",
              }}
            >
              Top Pulls
            </div>
            {topPulls.map((p, i) => {
              const c = tierColor(p.tier)
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 6, height: 24, background: c, borderRadius: 2, display: "flex" }} />
                  <div style={{ color: "#E5E7EB", fontSize: 26, fontWeight: 700, display: "flex" }}>{p.name}</div>
                  <div style={{ color: "#10B981", fontSize: 22, fontWeight: 700, display: "flex", marginLeft: "auto" }}>
                    {fmtUsd(p.fmv)}
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}

        {/* Metric row */}
        <div style={{ display: "flex", gap: 40, alignItems: "flex-end", marginTop: "auto" }}>
          {isRipped ? (
            <>
              <Stat label="PULLED" value={fmtUsd(grossUsd)} color={hasDelta && isPositive ? "#10B981" : "#FFFFFF"} />
              <Stat label="PAID" value={fmtUsd(paidAnchor)} color="#FFFFFF" />
            </>
          ) : (
            <Stat label={basis !== null ? "LAST BOUGHT" : "RETAIL"} value={fmtUsd(paidAnchor)} color="#FFFFFF" />
          )}
          {isRipped && hasDelta ? (
            <Stat
              label="VS COST"
              value={`${delta! >= 0 ? "+" : "−"}${fmtUsd(Math.abs(delta!))}`}
              color={isPositive ? "#10B981" : "#EF4444"}
            />
          ) : null}

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
            {depletion === null ? "Pack lifecycle via Rip Packs City" : `${depletion}% sealed packs sold`}
          </div>
          <div style={{ color: "#FF6B35", fontSize: 14, fontWeight: 700, letterSpacing: 1, display: "flex" }}>
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
      <div style={{ color, fontSize: 48, fontWeight: 800, lineHeight: 1, display: "flex" }}>{value}</div>
    </div>
  )
}
