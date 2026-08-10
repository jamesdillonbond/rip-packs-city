// lib/tier-order.ts
//
// The one canonical tier ladder. Four separate TIER_ORDER arrays had drifted
// apart (deep-audit D23) — three different casings, both sort directions, and
// UNCOMMON present in exactly one of the four — so copying a comparator between
// them silently reordered or dropped a tier.
//
// That drift was not merely cosmetic. lib/analytics-fmv-dashboard-compute.ts
// held a TitleCase list ("Common") while analytics_fmv_tier_pulse returns the
// Postgres tier_type enum UPPERCASE ("COMMON"), so its
// `TIER_ORDER.includes(r.tier)` test was false for EVERY row and the whole FMV
// dashboard collapsed into one gray "Other" bucket. Its unit test never caught
// it because the fixtures were written in TitleCase too — a fixture that cannot
// fail, validating a shape production never emits.
//
// RANKS, not an array, is the source of truth: an array forces a total order on
// tiers that are collection-DISJOINT and therefore have no meaningful relative
// rank. FANDOM (Top Shot) and UNCOMMON (All Day / Golazos) never appear in the
// same collection's breakdown, so they deliberately share a rank; likewise the
// three UFC tiers sit above the Flow ladder rather than being interleaved.
//
// Ranks ascend with rarity: COMMON is 0, the rarest is highest.

/** Every value of the Postgres `tier_type` enum, plus the ingest sentinel. */
export const CANONICAL_TIER_RANKS: Record<string, number> = {
  COMMON: 0,
  // Collection-disjoint pair — same rank on purpose. Top Shot has FANDOM and no
  // UNCOMMON; All Day (630 editions) and Golazos (215) have UNCOMMON and no
  // FANDOM. Verified live 2026-08-09.
  FANDOM: 1,
  UNCOMMON: 1,
  RARE: 2,
  LEGENDARY: 3,
  ULTIMATE: 4,
  // UFC Strike's own ladder. Disjoint from the Flow tiers above (UFC uses
  // CONTENDER / CHALLENGER / CHAMPION / FANDOM only), so these ranks are
  // internally ordered and not comparable to RARE/LEGENDARY/ULTIMATE.
  CONTENDER: 5,
  CHALLENGER: 6,
  CHAMPION: 7,
};

/** Canonical tier names, UPPERCASE — exactly as the DB enum stores them. */
export const CANONICAL_TIERS: string[] = Object.keys(CANONICAL_TIER_RANKS);

/**
 * Normalize any tier spelling to the canonical UPPERCASE enum value.
 *
 * Returns null for an unknown or absent tier so callers make an explicit
 * decision (an "Other"/"Unknown" bucket) instead of silently rendering a
 * mis-cased string that matches no lookup. `analytics_fmv_tier_pulse` really
 * does emit an "UNKNOWN" tier for 12 Top Shot editions, so this path is live.
 */
export function normalizeTier(tier: string | null | undefined): string | null {
  if (!tier) return null;
  const t = tier.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CANONICAL_TIER_RANKS, t) ? t : null;
}

/** Rarity rank, or null when the tier is not canonical. */
export function tierRank(tier: string | null | undefined): number | null {
  const t = normalizeTier(tier);
  return t == null ? null : CANONICAL_TIER_RANKS[t];
}

/** "COMMON" -> "Common". Display casing used by the analytics dashboards. */
export function titleCaseTier(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
}

/**
 * The canonical ladder as an ordered array.
 *
 * `direction: "asc"` is common-first (the analytics dashboards' bar order);
 * "desc" is rarest-first (Fast Break run progress, the trophy picker).
 * Within a shared rank the CANONICAL_TIER_RANKS declaration order is kept, so
 * the output is deterministic even for the disjoint pairs.
 */
export function tierLadder(
  direction: "asc" | "desc" = "asc",
  opts: { casing?: "upper" | "title" | "lower"; only?: string[] } = {},
): string[] {
  const { casing = "upper", only } = opts;
  const allow = only ? new Set(only.map((t) => t.toUpperCase())) : null;
  const names = CANONICAL_TIERS.filter((t) => !allow || allow.has(t));
  const sorted = [...names].sort((a, b) => {
    const d = CANONICAL_TIER_RANKS[a] - CANONICAL_TIER_RANKS[b];
    if (d !== 0) return direction === "asc" ? d : -d;
    // Stable within a shared rank, and mirrored on reverse so the two
    // directions are exact inverses of each other.
    const ia = CANONICAL_TIERS.indexOf(a);
    const ib = CANONICAL_TIERS.indexOf(b);
    return direction === "asc" ? ia - ib : ib - ia;
  });
  if (casing === "title") return sorted.map(titleCaseTier);
  if (casing === "lower") return sorted.map((t) => t.toLowerCase());
  return sorted;
}
