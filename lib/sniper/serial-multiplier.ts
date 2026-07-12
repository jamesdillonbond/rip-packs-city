// Sniper-feed per-serial weighting + display signal. Extracted from
// app/api/sniper-feed/route.ts so the pure multiplier can be unit-tested and
// its constants pinned. Pure math.
//
// The ORDINARY-serial tail (1.0 + 0.08·max(0, 1 - position)) is deliberately
// identical to lib/fmv/serial-multiplier — both must agree on ordinary serials
// (see the cross-agreement test). The SPECIAL-serial multipliers here are
// display-signal-specific (feeding the sniper's #1 / Jersey / Last badges) and
// intentionally differ from the FMV API's valuation multipliers.

export function sniperSerialMultiplier(
  serial: number,
  circulationCount: number,
  jerseyNumber: number | null
): { mult: number; signal: string | null; isSpecial: boolean } {
  if (serial === 1) return { mult: 8, signal: "#1", isSpecial: true }
  if (jerseyNumber !== null && serial === jerseyNumber)
    return { mult: 2.5, signal: `Jersey #${serial}`, isSpecial: true }
  if (serial === circulationCount)
    return { mult: 1.3, signal: `Last #${serial}`, isSpecial: true }
  // Smooth position-based curve for non-special serials — shared with the FMV
  // API. A serial at the start of an edition gets up to an 8% premium; a serial
  // at the end gets ~1.0. Matches the LiveToken spread observed on dense editions.
  const position = circulationCount > 0 ? serial / circulationCount : 0.5
  const mult = 1.0 + 0.08 * Math.max(0, 1 - position)
  return { mult: Number(mult.toFixed(4)), signal: null, isSpecial: false }
}
