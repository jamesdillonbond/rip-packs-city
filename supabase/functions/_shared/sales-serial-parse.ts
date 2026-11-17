// Shared pure logic for sales-serial-backfill — the edge fn that re-resolves a
// historical sale's serial_number from chain and writes it via update_sale_serial
// (which only overwrites a NULL/0 serial with a valid POSITIVE integer). Two
// gates decide what lands, and both feed money: the serial flows into the
// serial-FMV multiplier ladder (#1 → 12x, ≤10 → 4.5x, …), and the holder address
// gates which wallet a borrow is attributed to. A slip in either writes a wrong
// serial (wrong FMV) or attributes ownership to the wrong wallet.
//
// Ported VERBATIM from sales-serial-backfill/index.ts. The source-drift guard in
// __tests__/edge-sales-serial-parse.test.ts holds the inline copies to this
// module. No Deno APIs used — imports cleanly under vitest.
//
// NOTE: `normalizeAddr` here is the STRICTER, prefix-required variant — it does
// NOT add a "0x" (unlike _shared/flow-address.ts::toFlowAddr, which does). The
// two are deliberately separate; see the flow-address.ts header.

/**
 * Normalize an arbitrary value to a canonical Flow mainnet address, or null.
 * Requires the "0x" prefix ALREADY present, then exactly 16 lowercase hex digits
 * (Flow addresses are 8 bytes). Trims + lowercases; never throws.
 */
export function normalizeAddr(a: unknown): string | null {
  const s = String(a ?? "").trim().toLowerCase()
  return /^0x[0-9a-f]{16}$/.test(s) ? s : null
}

/**
 * The serial-validation rule the edge fn applies at every resolve site: a serial
 * is accepted ONLY when it coerces to a finite number strictly greater than 0.
 * Returns the numeric serial, or null (so the caller skips the write rather than
 * stamping a 0/NaN/negative into sales.serial_number). Mirrors the inline
 * `const n = Number(raw); if (!Number.isFinite(n) || n <= 0) return …` shape.
 */
export function parsePositiveSerial(raw: unknown): number | null {
  const n = raw != null ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}
