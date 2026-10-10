// ⚠ 2026-10-10 (known-issues #18): NO LONGER THE /api/fmv MODEL. The public FMV API (and its
// /api/fmv/demo spec) now price the serial premium with the fitted serial_fmv_estimate through
// serial_fmv_multiplier_batch — a 4,477-sale backtest put these flat bands at roughly twice its
// error (serials 2-10: 4.5x here vs a market median of 1.38x). This module is kept only because
// lib/sniper/serial-multiplier mirrors its ordinary-serial tail and its test pins that; do not
// wire it back into a pricing surface without re-running that backtest.
//
// FMV API per-serial weighting. Extracted from app/api/fmv/route.ts so the
// pure multiplier can be unit-tested and its constants pinned. Pure math.
//
// The ORDINARY-serial tail (1.0 + 0.08·max(0, 1 - position)) is deliberately
// identical to lib/sniper/serial-multiplier — both must agree on ordinary
// serials (see the cross-agreement test). The SPECIAL-serial multipliers below
// are FMV-valuation-specific and intentionally differ from the sniper feed's
// display signals — do NOT "reconcile" them by copying one onto the other.

export function fmvSerialMultiplier(serial: number, circ: number): number {
  if (serial === 1) return 12.0
  if (serial <= 10) return 4.5
  if (serial <= 23) return 2.8
  if (serial === circ) return 3.0
  // Smooth position-based curve — shared with the sniper feed.
  const position = circ > 0 ? serial / circ : 0.5
  return 1.0 + 0.08 * Math.max(0, 1 - position)
}
