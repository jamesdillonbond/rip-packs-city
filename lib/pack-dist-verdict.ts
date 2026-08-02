// Pack-EV verdict honesty gates — extracted from
// app/(collections)/[collection]/pack/dist/[distId]/page.tsx so the pack-EV
// verdict math is unit-tested (the primary coverage gate measures lib/**) and
// so the SEO generateMetadata() and the page body share ONE implementation of
// the holding-pack / survivor-bias predicates instead of two copies that can
// drift (the page comment literally reads "Mirrors the page's evSurvivorBiased
// gate" — this module removes that hazard).
//
// Every function here is pure. Behaviour is byte-identical to the inline logic
// it replaced; see the page for the domain commentary on WHY each gate exists
// (reward packs, escrow/holding sentinels, depleted-pool survivor bias, the
// live-secondary-ask verdict anchor).

import { num } from "@/lib/pack-dist-format"

// Escrow / holding / placeholder packs carry sentinel prices that produce
// nonsense verdicts ($900K "Gross EV", 3% coverage). Suppress the price + EV
// verdict when one is detected.
export const SENTINEL_PRICES = new Set([9999, 99999, 999999])

export function isSentinelPrice(v: number | null | undefined): boolean {
  return v !== null && v !== undefined && SENTINEL_PRICES.has(v)
}

// "Holding" / "Holder" / "Hold" packs (chiefly NFL All Day) are escrow
// constructs, not consumer packs — detect by name.
export function isHoldingPackName(title: string | null | undefined): boolean {
  return /\bhold(?:ing|er)?\b/i.test(String(title ?? ""))
}

// pack_ev is clamped to the pack_ev_latest view's -10000 floor when pack_price
// dwarfs gross_ev by >$10k — the unambiguous signature of an escrow/whale
// construct even when its sentinel price isn't one of the canonical values.
export function isClampedEvNet(packEvNet: number | null | undefined): boolean {
  return packEvNet !== null && packEvNet !== undefined && packEvNet <= -10000
}

// Unified holding-pack detection. The page passes the clamped canonical net
// (packEvRaw) plus retail + live prices; the SEO path passes only the retail
// price (no clamp signal available there). A price of null is ignored.
export function detectHoldingPack(input: {
  title: string | null | undefined
  packEvNet?: number | null
  prices?: Array<number | null | undefined>
}): boolean {
  return (
    isHoldingPackName(input.title) ||
    isClampedEvNet(input.packEvNet) ||
    (input.prices ?? []).some(isSentinelPrice)
  )
}

// Pack EV compares the value still sealed (grossEv) ONLY to the live secondary
// sealed-pack low ask — what the pack itself actually resells for. When there is
// no live secondary ask the anchor is null and no net/ratio verdict renders.
export function deriveSecondaryAskAnchor(
  secondaryAvailable: boolean | null | undefined,
  secondaryAsk: number | null | undefined,
): number | null {
  return secondaryAvailable === true && secondaryAsk != null && secondaryAsk > 0
    ? secondaryAsk
    : null
}

export interface EvVerdict {
  packEv: number | null
  valueRatio: number | null
  evMargin: number | null
  isPositive: boolean
}

// Net / ratio / margin against the secondary-ask anchor. packEv is rounded to
// cents; valueRatio and evMargin are only defined when both grossEv and the
// anchor are present.
export function deriveEvVerdict(
  grossEv: number | null | undefined,
  secondaryAskAnchor: number | null | undefined,
): EvVerdict {
  const hasBoth = grossEv != null && secondaryAskAnchor != null
  const packEv = hasBoth ? Math.round((grossEv! - secondaryAskAnchor!) * 100) / 100 : null
  const valueRatio = hasBoth ? grossEv! / secondaryAskAnchor! : null
  const evMargin = valueRatio != null ? (valueRatio - 1) * 100 : null
  const isPositive = packEv != null && packEv > 0
  return { packEv, valueRatio, evMargin, isPositive }
}

// A pack freely listed on secondary for $X can't contain 3×$X of pulls — when it
// appears to, the pull-value EV is survivor-biased (cheap commons exhausted, the
// surviving chases inflate the mean).
export function isEvInflatedVsAsk(input: {
  secondaryAvailable: boolean | null | undefined
  secondaryAsk: number | null | undefined
  grossEv: number | null | undefined
}): boolean {
  return (
    input.secondaryAvailable === true &&
    input.secondaryAsk != null &&
    input.secondaryAsk > 0 &&
    input.grossEv != null &&
    input.grossEv > 3 * input.secondaryAsk
  )
}

// Egregious survivor bias — the pull-value EV is structurally impossible to
// headline. Triggers: pool ≥90% depleted, or gross EV > 3× a live secondary ask.
// Scoped to the raw pull-value path (AllDay's odds-corrected EV carries its own
// caveat, so useCorrectedEv suppresses it). hasDropPool defaults to true so the
// SEO path — which has no pool signal and never gated on it — is byte-identical.
export function isSurvivorBiased(input: {
  useCorrectedEv: boolean
  depletionPct: number | null | undefined
  secondaryAvailable: boolean | null | undefined
  secondaryAsk: number | null | undefined
  grossEv: number | null | undefined
  hasDropPool?: boolean
}): boolean {
  const hasDropPool = input.hasDropPool ?? true
  return (
    !input.useCorrectedEv &&
    hasDropPool &&
    ((input.depletionPct != null && input.depletionPct >= 90) ||
      isEvInflatedVsAsk({
        secondaryAvailable: input.secondaryAvailable,
        secondaryAsk: input.secondaryAsk,
        grossEv: input.grossEv,
      }))
  )
}

// ── Realized-vs-modeled panel verdicts (lifted from the pack/dist page) ──────
// These drive the coloured verdict lines under the realized-pull-distribution
// panel. Kept here alongside deriveEvVerdict so the pack-dist verdict logic
// lives in one tested place. The RGB accents are copied verbatim from the page.

// realized_to_modeled_ratio → coloured verdict. Bands: model over-values (<0.6),
// under-values (>1.4), or tracks actual pulls (between). Null ratio → no verdict.
export function deriveRealizedVsModeledVerdict(
  ratio: number | null,
): { label: string; accent: string } | null {
  return ratio === null
    ? null
    : ratio < 0.6
    ? { label: "Model over-values vs actual pulls", accent: "rgb(248,113,113)" }
    : ratio > 1.4
    ? { label: "Model under-values vs actual pulls", accent: "rgb(110,231,183)" }
    : { label: "Model tracks actual pulls", accent: "rgba(255,255,255,0.85)" }
}

// secondary_vs_retail_ratio → sealed-pack resale verdict. Bands: secondary
// premium (>=1.15), discount (<=0.85), or ~fair (between). The ratio is printed
// to two decimals in the label. Null ratio → no verdict.
export function deriveSealedResaleVerdict(
  ratio: number | null,
): { label: string; accent: string } | null {
  return ratio === null
    ? null
    : ratio >= 1.15
    ? { label: `trades ${ratio.toFixed(2)}× retail — secondary premium`, accent: "rgb(110,231,183)" }
    : ratio <= 0.85
    ? { label: `trades ${ratio.toFixed(2)}× retail — secondary discount`, accent: "rgb(252,211,77)" }
    : { label: `trades ~${ratio.toFixed(2)}× retail`, accent: "rgba(255,255,255,0.85)" }
}

// Whether to surface the calibrated-EV line: only when there's a modeled EV and
// the calibrated value diverges from it by >= 10%. The modeledEv != null guard is
// redundant with hasModeled (which implies a positive modeled EV) but keeps this
// pure and null-safe on its own.
export function showCalibrated(
  hasModeled: boolean,
  calibratedEv: number | null,
  modeledEv: number | null,
): boolean {
  return (
    hasModeled &&
    calibratedEv !== null &&
    modeledEv !== null &&
    Math.abs(calibratedEv - modeledEv) / modeledEv >= 0.1
  )
}

// Share of a pack's EV that comes from LOW-confidence contributors — drives the
// ">= 25% soft EV" warning on the Top Shot pack-EV panel. Sums pct_of_ev across
// contributors whose confidence is soft (LOW / ASK_ONLY / STALE / NO_DATA).
export function evContributorsLowConfShare(
  contributors: { confidence?: unknown; pct_of_ev?: string | number | null | undefined }[],
): number {
  return contributors
    .filter((c) => ["LOW", "ASK_ONLY", "STALE", "NO_DATA"].includes(String(c.confidence)))
    .reduce((s, c) => s + (num(c.pct_of_ev) ?? 0), 0)
}
