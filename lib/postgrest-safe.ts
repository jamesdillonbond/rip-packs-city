// lib/postgrest-safe.ts
//
// Guards for request values that get interpolated into a PostgREST filter
// STRING — the `.or("col.op.value,...")` / `.filter("col","op","value")` forms.
// A raw value spliced into such a string can break out of the filter grammar
// via the delimiter/group characters `, ( )` (and the wildcard `%`): a comma
// pivots to a different column, parens inject a nested and()/or() logic tree,
// and either can 400 the query. supabase-js's TWO-ARG builder forms
// (`.ilike("col", value)`, `.eq("col", value)`, `.in("col", arrayValue)`) are
// already parameterized and do NOT need this — only the string-built
// `.or()` / `.filter()` forms do.
//
// The `sanitizeOrIlikeValue` sanitizer mirrors the one already inline in
// app/api/admin/feedback/route.ts (`q.replace(/[%,()]/g, " ")`), promoted here
// so every string-built `.or()` ilike site shares one audited implementation.

/**
 * Strip the PostgREST filter-grammar metacharacters (`%`, `,`, `(`, `)`) from a
 * value destined for an `.or()`/`.filter()` ilike term, replacing each with a
 * space. `.` is intentionally left intact — a dot is legal inside a filter VALUE
 * (only the first two dots of `col.op.value` are structural) and stripping it
 * would corrupt legitimate names. Returns the sanitized value (callers usually
 * wrap it as `%${sanitized}%`).
 */
export function sanitizeOrIlikeValue(v: string): string {
  return v.replace(/[%,()]/g, " ")
}

/**
 * True for a canonical Flow address (`0x` + exactly 16 hex chars) — the form
 * `sales.seller_address` / `buyer_address` (and the other on-chain Flow address
 * columns) are constrained to. Use it to (a) filter an address array before
 * interpolating it into an `.in.(...)` filter string, or (b) validate a single
 * address before an `.eq.` term. Filtering to this set before an `.in.(...)`
 * against a Flow column is lossless: a value that is not a Flow address could
 * never match the column anyway.
 */
export function isFlowAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{16}$/.test(v)
}

/**
 * True for an on-chain wallet address on ANY chain RPC indexes sales for —
 * canonical Flow (`0x` + 16 hex) or Solana base58 (32-44 chars).
 *
 * ⚠ ADDED 2026-09-19 because `isFlowAddress` was being used as BOTH an
 * injection guard AND a completeness claim, and only the first half was true.
 * Its doc comment argued the filter was "lossless: a value that is not a Flow
 * address could never match the column anyway" — measured against Candy MLB
 * that is false. Candy sales carry base58 seller/buyer addresses, 142 of 142 in
 * the trailing 7 days on 2026-09-19, 43-44 chars, 100% populated. So every
 * Candy wallet was dropped before the query, and the feed returned `[]` — an
 * empty answer where the honest one was a list.
 *
 * SAFE FOR `.in.(...)` INTERPOLATION BY CONSTRUCTION, which is the only reason
 * this may widen the guard at all: the base58 alphabet is
 * `[1-9A-HJ-NP-Za-km-z]` — it contains no `,` `(` `)` or `%`, so a value
 * matching this regex cannot carry a PostgREST filter-grammar metacharacter.
 * The anchors make that exhaustive, not merely likely.
 *
 * ⛔ Do NOT `.toLowerCase()` a value that passed this test. Base58 is
 * CASE-SENSITIVE; use `normalizeAddress` from lib/address.ts.
 */
export function isOnChainAddress(v: string): boolean {
  return isFlowAddress(v) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)
}
