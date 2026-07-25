// collection-moment-cells — pure per-row display/math logic lifted out of
// components/collection/CollectionMomentTable.tsx so it lands under the vitest
// coverage `include` (lib/**), which does NOT measure components/**. No
// React/JSX, no browser globals — behavior is byte-identical to the inline code
// it replaced (tier colors, P&L math, best-offer resolution, ask/FMV deltas).

// ── Tier styling ────────────────────────────────────────────────────────────

// Per-tier text color used by the moment thumbnail preview + the mobile tier
// pill. Case-insensitive; unknown/empty tiers fall back to the COMMON gray.
const MOMENT_TIER_COLOR: Record<string, string> = {
  COMMON: "#9ca3af",
  UNCOMMON: "#14b8a6",
  FANDOM: "#60a5fa",
  RARE: "#38bdf8",
  LEGENDARY: "#fbbf24",
  ULTIMATE: "#c084fc",
}

export function momentTierColor(tier: string | null | undefined): string {
  return MOMENT_TIER_COLOR[(tier ?? "").toUpperCase()] ?? "#9ca3af"
}

// Per-tier background utility class for the mobile tier pill.
const MOMENT_TIER_BG: Record<string, string> = {
  COMMON: "bg-[var(--rpc-surface-raised)]",
  UNCOMMON: "bg-teal-950",
  FANDOM: "bg-blue-950",
  RARE: "bg-sky-950",
  LEGENDARY: "bg-yellow-950",
  ULTIMATE: "bg-purple-950",
}

export function momentTierBgClass(tier: string | null | undefined): string {
  return MOMENT_TIER_BG[(tier ?? "").toUpperCase()] ?? "bg-[var(--rpc-surface-raised)]"
}

// Holographic accent class for the desktop thumbnail wrapper — only the three
// rarest tiers get one; everything else is plain (empty string).
export function momentHoloClass(tier: string | null | undefined): string {
  switch ((tier ?? "").toUpperCase()) {
    case "LEGENDARY":
      return "rpc-holo-legendary"
    case "ULTIMATE":
      return "rpc-holo-ultimate"
    case "RARE":
      return "rpc-holo-rare"
    default:
      return ""
  }
}

// ── Cost-basis / P&L ────────────────────────────────────────────────────────

// Profit/loss of the current FMV against a cost basis. Callers guard basis > 0
// and a truthy fmv before invoking, so plPct's basis>0 branch mirrors the
// original inline `basis > 0 ? … : 0`.
export function computeMomentPnl(
  fmv: number,
  basis: number,
): { pl: number; plPct: number; positive: boolean } {
  const pl = fmv - basis
  const plPct = basis > 0 ? (pl / basis) * 100 : 0
  return { pl, plPct, positive: pl >= 0 }
}

export function pnlColorClass(positive: boolean): string {
  return positive ? "text-emerald-400" : "text-red-400"
}

// Derive the P&L basis for the desktop P&L column: a "Bought"/"Loan" cost-basis
// amount wins, otherwise fall back to the last purchase price, otherwise 0.
export function resolveMomentPnlBasis(
  costBasisLabel: string | null | undefined,
  buyPrice: number | null | undefined,
  lastPurchasePrice: number | null | undefined,
): number {
  const cbBasis =
    costBasisLabel === "Bought" || costBasisLabel === "Loan" ? buyPrice ?? 0 : 0
  if (cbBasis > 0) return cbBasis
  if (lastPurchasePrice != null && lastPurchasePrice > 0) return lastPurchasePrice
  return 0
}

// ── Best offer ──────────────────────────────────────────────────────────────

// Resolve which offer to surface in the Best Offer cell: prefer the higher of a
// serial-level offer and an edition-level offer, else whichever single one
// exists, else the denormalized edition best-offer. Only strictly-positive
// numeric values count. Returns null when nothing qualifies.
export function resolveMomentBestOffer(args: {
  bestOffer?: number | null
  editionOffer?: number | null
  editionBestOffer?: number | null
  bestOfferType?: string | null
}): { val: number; label: string } | null {
  const { bestOffer, editionOffer, editionBestOffer, bestOfferType } = args
  const displayOffer = typeof bestOffer === "number" && bestOffer > 0 ? bestOffer : null
  const displayEdOffer =
    typeof editionOffer === "number" && editionOffer > 0 ? editionOffer : null
  const displayEdBestOffer =
    typeof editionBestOffer === "number" && editionBestOffer > 0 ? editionBestOffer : null
  if (displayOffer && displayEdOffer) {
    return displayOffer >= displayEdOffer
      ? { val: displayOffer, label: bestOfferType ?? "serial" }
      : { val: displayEdOffer, label: "edition" }
  }
  if (displayOffer) return { val: displayOffer, label: bestOfferType ?? "offer" }
  if (displayEdOffer) return { val: displayEdOffer, label: "edition" }
  if (displayEdBestOffer) return { val: displayEdBestOffer, label: "edition" }
  return null
}

// ── Ask vs FMV deltas ───────────────────────────────────────────────────────

// The small ↑/↓ low-ask-vs-FMV delta chip beneath the FMV cell. Hidden when the
// market is unpriced, FMV is non-positive, there is no low ask, or the swing is
// under 3%. Returns the delta plus its rendered color class + label.
export function computeAskFmvDelta(
  marketConfidence: string | null | undefined,
  fmv: number | null | undefined,
  lowAsk: number | null | undefined,
): { pct: number; colorClass: string; label: string } | null {
  if (marketConfidence === "none" || !fmv || fmv <= 0 || lowAsk == null) return null
  const delta = ((lowAsk - fmv) / fmv) * 100
  if (Math.abs(delta) < 3) return null
  const colorClass = delta < 0 ? "text-emerald-400" : "text-red-400"
  const label = (delta > 0 ? "↑+" : "↓") + delta.toFixed(0) + "%"
  return { pct: delta, colorClass, label }
}

// Whether to render the secondary "Ask $X" line: only when a best-ask exists,
// FMV is positive, and the two diverge by more than 1%.
export function shouldShowAskBadge(
  ask: number | null | undefined,
  fmv: number | null | undefined,
): boolean {
  if (ask == null || !fmv || fmv <= 0) return false
  const pctDiff = Math.abs((ask - fmv) / fmv) * 100
  return pctDiff > 1
}
