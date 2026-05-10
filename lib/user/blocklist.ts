// lib/user/blocklist.ts
//
// Profanity guard for the public greeting / display-name resolver. A
// candidate name is rejected if, after lowercasing and stripping non-
// alphanumeric characters, any blocklisted term appears as a substring.
// Substring matching catches l33t-style padding (e.g. "_fuck_" → fuck).
//
// Maintained list lives in blocklist.json so it can be extended by ops
// without code changes.

import blocklist from "./blocklist.json"

const TERMS: readonly string[] = (() => {
  const raw = (blocklist as unknown as { terms?: unknown }).terms
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((t) => t.toLowerCase())
})()

export function normalizeForBlocklistMatch(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function isBlocklisted(candidate: string | null | undefined): boolean {
  if (!candidate) return false
  const norm = normalizeForBlocklistMatch(candidate)
  if (!norm) return false
  for (const term of TERMS) {
    if (term && norm.includes(term)) return true
  }
  return false
}

// Test-only helper so unit tests can assert the list shape without
// re-implementing the filter.
export function _blocklistTermsForTest(): readonly string[] {
  return TERMS
}
