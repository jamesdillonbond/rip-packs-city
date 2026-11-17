// Pure Monte-Carlo math for the pack simulator
// (app/(collections)/[collection]/packs/simulator/[distId]/page.tsx — a ~600-line
// client neither coverage gate measures). This is the pull-odds engine: a bug in
// the CDF build or the weighted sample mis-simulates every rip. Bodies are
// byte-identical to the originals; the page imports these.

// Tier -> accent colour. Moved off hardcoded hex onto the `--tier-*` design
// tokens 2026-08-01 so a brand-palette edit reaches this surface too. All call
// sites are plain inline-style values (border / color), never an alpha-suffix
// concatenation, so a CSS variable is safe here.

import { NEUTRAL_TIER_COLOR } from "@/lib/tier-color"

export function tierColor(tier: string | null | undefined): string {
  const t = (tier || "").toLowerCase()
  if (t.includes("ultimate")) return "var(--tier-ultimate)"
  if (t.includes("legendary")) return "var(--tier-legendary)"
  if (t.includes("rare")) return "var(--tier-rare)"
  if (t.includes("fandom")) return "var(--tier-fandom)"
  if (t.includes("common")) return "var(--tier-common)"
  if (t.includes("premium")) return "var(--col-disney-pinnacle)"
  if (t.includes("standard")) return NEUTRAL_TIER_COLOR
  if (t.includes("challenger")) return "var(--tier-challenger)"
  if (t.includes("contender")) return "var(--tier-contender)"
  return NEUTRAL_TIER_COLOR
}

// Was a byte-identical copy of lib/grail-format.fmtUsd; both now share the
// canonical body. Output unchanged.
export { fmtUsdWhole1000 as fmtUsd } from "@/lib/usd-format"

export function fmtPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(Number(p))) return "—"
  const v = Number(p) * 100
  return v.toFixed(v < 1 ? 2 : 1) + "%"
}

/** Minimal pool-edition shape the sampler reads. */
export interface WeightedEdition {
  drop_weight: number | null
}

/** Build a cumulative-weight array from pool[i].drop_weight (negatives clamped
 * to 0). Used once per rip session; sampleEdition binary-searches it in O(log n). */
export function buildCdf<P extends WeightedEdition>(pool: P[]): { cdf: number[]; total: number } {
  const cdf: number[] = new Array(pool.length)
  let running = 0
  for (let i = 0; i < pool.length; i++) {
    const w = Number(pool[i].drop_weight) || 0
    running += w > 0 ? w : 0
    cdf[i] = running
  }
  return { cdf, total: running }
}

/** Weighted random pick via binary search over the CDF. Degenerate pools
 * (total <= 0 / empty) return the first element. */
export function sampleEdition<P extends WeightedEdition>(pool: P[], cdf: number[], total: number): P {
  if (total <= 0 || pool.length === 0) return pool[0]
  const r = Math.random() * total
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cdf[mid] < r) lo = mid + 1
    else hi = mid
  }
  return pool[lo]
}

/** Population standard deviation; 0 for fewer than 2 values. */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}
