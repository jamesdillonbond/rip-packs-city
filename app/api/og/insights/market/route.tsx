// app/api/og/insights/market/route.tsx
//
// Open Graph card for /insights/market (The RPC Index). 1200x630 PNG rendered
// server-side via next/og. Surfaces the live per-tier headline (median price +
// 30d change for Legendary / Rare / Fandom / Common) so the social preview is
// data-rich rather than a logo + tagline. Falls back to a generic card if the
// market API is empty.

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Row = {
  d: string
  tier: string
  median_px: number | string | null
  volume_usd: number | string | null
}

const PLOT_TIERS = ["LEGENDARY", "RARE", "FANDOM", "COMMON"] as const
const TIER_HEX: Record<string, string> = {
  LEGENDARY: "#FFD700",
  ULTIMATE: "#FF6B35",
  RARE: "#818CF8",
  FANDOM: "#34D399",
  COMMON: "#94A3B8",
}

function num(v: number | string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = n
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (v >= 10) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `$${Math.round(n / 1000)}K`
  return `$${Math.round(n)}`
}

export async function GET(req: NextRequest) {
  type Head = { tier: string; median: number | null; change: number | null }
  let heads: Head[] = []
  let vol7d = 0
  try {
    const origin = new URL(req.url).origin
    const r = await fetch(`${origin}/api/public/insights/market?days=120`, { cache: "no-store" })
    if (r.ok) {
      const j = await r.json()
      const rows: Row[] = Array.isArray(j?.rows) ? j.rows : []
      // Per-tier latest median + value ~30d earlier.
      const byTier = new Map<string, { d: string; m: number }[]>()
      let allDates: string[] = []
      for (const row of rows) {
        const t = (row.tier ?? "").toUpperCase()
        const m = num(row.median_px)
        if (m != null) {
          if (!byTier.has(t)) byTier.set(t, [])
          byTier.get(t)!.push({ d: row.d, m })
        }
        if (t === "ALL") allDates.push(row.d)
      }
      allDates = allDates.sort()
      const latestDate = allDates[allDates.length - 1] ?? null
      const target30 = latestDate
        ? new Date(new Date(latestDate).getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
        : null
      heads = PLOT_TIERS.map((t) => {
        const arr = (byTier.get(t) ?? []).sort((a, b) => (a.d < b.d ? -1 : 1))
        const latest = arr.length ? arr[arr.length - 1] : null
        let change: number | null = null
        if (latest && target30) {
          const prior = arr.find((p) => p.d >= target30)
          if (prior && prior.m > 0 && prior.d !== latest.d) {
            change = ((latest.m - prior.m) / prior.m) * 100
          }
        }
        return { tier: t, median: latest ? latest.m : null, change }
      })
      // 7d total volume from ALL rows.
      const allVol = rows
        .filter((row) => (row.tier ?? "").toUpperCase() === "ALL")
        .sort((a, b) => (a.d < b.d ? -1 : 1))
      vol7d = allVol.slice(-7).reduce((acc, row) => acc + (num(row.volume_usd) ?? 0), 0)
    }
  } catch {
    /* generic card fallback */
  }

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
          fontFamily: "system-ui",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ fontSize: 18, letterSpacing: 6, color: "#E03A2F", textTransform: "uppercase" }}>
            RIP PACKS CITY · INSIGHTS
          </div>
          <div style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", display: "flex" }}>
            {vol7d > 0 ? `${fmtVol(vol7d)} volume · 7d` : "Public · No signup"}
          </div>
        </div>

        <div style={{ marginTop: 22, fontSize: 84, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1.02, display: "flex" }}>
          THE RPC INDEX
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: 22,
            color: "rgba(255,255,255,0.65)",
            letterSpacing: 0.5,
            lineHeight: 1.35,
            display: "flex",
            maxWidth: 1040,
          }}
        >
          One blended floor hides everything. We segment Top Shot by tier — here&apos;s what each is actually doing.
        </div>

        <div style={{ marginTop: 34, display: "flex", gap: 14 }}>
          {heads.every((h) => h.median == null) ? (
            <div style={{ fontSize: 22, color: "rgba(255,255,255,0.45)", display: "flex" }}>Loading the live index…</div>
          ) : (
            heads.map((h) => {
              const up = (h.change ?? 0) >= 0
              return (
                <div
                  key={h.tier}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    padding: "18px 20px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderTop: `4px solid ${TIER_HEX[h.tier] ?? "#E03A2F"}`,
                    borderRadius: 6,
                  }}
                >
                  <div style={{ fontSize: 16, letterSpacing: 2, color: TIER_HEX[h.tier] ?? "#fff", textTransform: "uppercase", display: "flex" }}>
                    {h.tier}
                  </div>
                  <div style={{ fontSize: 40, fontWeight: 800, display: "flex" }}>{fmtUsd(h.median)}</div>
                  <div style={{ fontSize: 18, color: up ? "#34D399" : "#E03A2F", display: "flex" }}>
                    {h.change == null ? "—" : `${Math.round(h.change) > 0 ? "+" : ""}${Math.round(h.change)}% 30d`}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 18,
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <div style={{ display: "flex" }}>Median secondary sale · tier-segmented</div>
          <div style={{ display: "flex" }}>rippackscity.com/insights/market</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
