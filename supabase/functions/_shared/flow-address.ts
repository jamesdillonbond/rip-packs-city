// Shared pure logic for the special-serial ownership sweeps (special-serial-sweep
// and special-serial-delta). Both carry an identical inline `toFlowAddr` that
// normalizes an arbitrary value into a canonical Flow mainnet address (or null),
// and it GATES ownership writes — a value that slips through becomes an owner key,
// and one that's wrongly rejected drops a special serial's owner. So the exact
// accept/reject boundary is worth pinning.
//
// NOTE this is the PREFIX-ADDING variant (accepts a bare 16-hex string and adds
// "0x"). sales-serial-backfill's `normalizeAddr` is a DIFFERENT, stricter helper
// that requires the "0x" prefix already present — deliberately not unified here.
//
// Ported VERBATIM from special-serial-sweep/index.ts. The drift guard in
// __tests__/edge-flow-address.test.ts holds both inline copies to this source.

/**
 * Normalize an arbitrary value to a canonical Flow mainnet address, or null.
 *   - trims + lowercases
 *   - adds a "0x" prefix when absent (so a bare 16-hex id is accepted)
 *   - accepts ONLY exactly 16 lowercase hex digits after "0x" (Flow addresses
 *     are 8 bytes); anything else → null (never throws)
 */
export function toFlowAddr(raw: unknown): string | null {
  let s = String(raw ?? "").trim().toLowerCase()
  if (!s) return null
  if (!s.startsWith("0x")) s = "0x" + s
  return /^0x[0-9a-f]{16}$/.test(s) ? s : null
}
