// Pure display/format helpers for the pack-distribution detail page
// (app/(collections)/[collection]/pack/dist/[distId]/page.tsx). Extracted here
// so the pack-EV / pull-odds display math is unit-tested (the page itself is
// outside the coverage include) — these are the last mile before a collector
// sees a pack's per-edition EV, pull odds, and sale prices, and each carries a
// documented prior regression.

/** Split an "Player — Set" edition name on the em-dash, guarding null / no-dash. */
export function splitEditionName(name: string | null): { player: string; setName: string } {
  if (!name) return { player: "Unknown", setName: "" }
  const idx = name.indexOf("—")
  if (idx === -1) return { player: name.trim(), setName: "" }
  return { player: name.slice(0, idx).trim() || "Unknown", setName: name.slice(idx + 1).trim() }
}

/** Coerce a string|number to a finite number, else null (never NaN). */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** USD, whole dollars at |v|>=100 else 2dp; null/NaN → em dash. */
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString()}`
  return `$${v.toFixed(2)}`
}

// Per-edition EV is FMV × pull-odds × slots, so a low-odds common can be a real
// positive value that rounds to $0.00 (e.g. $2.29 × 0.02% → $0.0005). Showing
// "$0.00" next to a live FMV reads like missing data — surface "<$0.01" instead
// (Pack G). Zero / null / negative fall through to the standard formatter.
export function fmtUsdEv(v: number | null | undefined): string {
  if (v !== null && v !== undefined && Number.isFinite(v) && v > 0 && v < 0.005) return "<$0.01"
  return fmtUsd(v)
}

/**
 * "~1 in N" pull-odds for one edition. Probability of pulling it AT LEAST ONCE
 * across `slots`: 1 − (1−p)^slots, where p = remaining / poolRemaining (the
 * per-slot probability = this edition's share of remaining pool entries, NOT of
 * packs-remaining — dividing by packs-remaining was the Pack 1a bug: Common
 * showed 596% = 328 entries / 55 packs). depleted / no-pool / no-slots guarded.
 */
export function packOddsLabel(remaining: number, poolRemaining: number | null, slots: number | null): string {
  if (remaining <= 0) return "depleted"
  if (!poolRemaining || poolRemaining <= 0 || !slots || slots <= 0) return "—"
  const p = remaining / poolRemaining
  const atLeastOne = 1 - Math.pow(1 - p, slots)
  if (atLeastOne <= 0) return "—"
  if (atLeastOne >= 0.999) return "~every pack"
  const oneIn = Math.round(1 / atLeastOne)
  return `~1 in ${oneIn.toLocaleString()}`
}

/** Short relative time ("just now" / "Nm ago" / "Nh ago" / "Nd ago"); `now` injected for tests. */
export function relTimeShort(iso: string | null, now: number = Date.now()): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const mins = Math.max(0, Math.round((now - t) / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** Day-granularity relative time ("today"/"yesterday"/"Nd/mo/y ago"); `now` injected for tests. */
export function fmtAgo(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const days = Math.max(0, Math.round((now - then) / 86400000))
  if (days < 1) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`
}

/** Sale-price USD: whole dollars at >=$1000, else 2dp; null/NaN → em dash. */
export function fmtSalePrice(v: string | number | null): string {
  const n = v == null ? null : Number(v)
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

/** Percentage with 1dp ("12.3%"); null / non-finite → em dash. */
export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return `${v.toFixed(1)}%`
}

/** Whole-number count with locale separators; null / non-finite → em dash. */
export function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return v.toLocaleString()
}

/**
 * Tile image URL for a pack-contents edition. For Top Shot with a numeric
 * on-chain rep NFT id, build the canonical assets.nbatopshot.com media URL
 * (the denorm thumbnail is often missing/stale on TS); otherwise fall back to
 * the stored thumbnail. Null when neither is available.
 */
export function tsTileImg(
  collectionSlug: string,
  repNftId: string | null | undefined,
  thumbnailUrl: string | null | undefined,
): string | null {
  if (collectionSlug === "nba-top-shot" && repNftId && /^\d+$/.test(repNftId)) {
    return `https://assets.nbatopshot.com/media/${repNftId}/image?width=400`
  }
  return thumbnailUrl ?? null
}
