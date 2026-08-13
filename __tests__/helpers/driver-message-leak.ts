// __tests__/helpers/driver-message-leak.ts
//
// ONE source of truth for "what does a published driver message look like".
//
// WHY THIS FILE EXISTS. The leak-detection patterns used to be duplicated
// inline in each guard, and that duplication has already cost us once: when the
// anon guard replaced the older public-insights guard, it shipped with FOUR
// spellings where its predecessor had FIVE, and the missing one — the inline
// ternary — was still live on 12 sites across 11 anon-reachable routes. The
// lesson recorded at the time was "diff the new guard's PATTERN SET against the
// old one's, not just its coverage". A shared module makes that diff impossible
// to get wrong: adding a spelling here widens every guard at once.
//
// Callers differ only in WHICH route files they scan, never in what counts as a
// leak.

/**
 * Spellings the leak has actually taken in this repo. All five were found in
 * production code; a grep for any ONE of them finds well under half the class,
 * which is why they are enumerated rather than approximated.
 *
 * Returns `"<line>: <text>"` for each offending line.
 */
export function leakSites(src: string): string[] {
  const hits: string[] = []
  const lines = src.split("\n")

  // (1) `error: err.message` — and the `message:` / `details:` variants.
  //     `result.message` and friends are DOMAIN values from our own helpers
  //     (the concierge's tool payloads), not driver text.
  const direct =
    /\b(?:error|details|message)\s*:\s*(?!result\.|item\.|row\.|payload\.)[A-Za-z_$][\w$]*(?:\?\.)?\.message\b/
  // (2) `error: String(err)` — stringifying the caught value.
  const stringified = /\berror\s*:\s*String\(\s*(?:err|e|error|ex|caught)\b/
  // (3) template interpolation of a caught value into the body.
  const interpolated = /\berror\s*:\s*`[^`]*\$\{\s*(?:err|e|ex|caught)(?:\?\.)?\.message/

  // (4b) The INLINE ternary, written straight into the response body:
  //       `{ error: err instanceof Error ? err.message : "Unknown error" }`
  //   Distinct from (4): there is no intermediate variable, so the indirect
  //   scan below never sees it, and `direct` does not match because `error:` is
  //   followed by an identifier + `instanceof`, not by `<id>.message`. The
  //   sibling public-insights guard has always carried this shape; it was the
  //   one spelling the anon guard did not inherit, and 7 anon-reachable routes
  //   were still publishing through it.
  const inlineTernary = /\berror\s*:\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error\s*\?\s*[A-Za-z_$][\w$]*(?:\?\.)?\.message/

  // (4) The indirect form: `const msg = e instanceof Error ? e.message : ...`
  //     then `{ error: msg }` further down. Collect the variable names first.
  const indirect = new Set<string>()
  for (const m of src.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error\s*\?\s*[A-Za-z_$][\w$]*\.message/g
  )) {
    indirect.add(m[1])
  }
  const indirectRx = indirect.size
    ? new RegExp(`\\berror\\s*:\\s*(?:${[...indirect].join("|")})\\b`)
    : null

  lines.forEach((line, i) => {
    if (
      direct.test(line) ||
      stringified.test(line) ||
      interpolated.test(line) ||
      inlineTernary.test(line) ||
      (indirectRx && indirectRx.test(line))
    ) {
      hits.push(`${i + 1}: ${line.trim()}`)
    }
  })
  return hits
}

/**
 * Route files that gate THEMSELVES on a shared operator secret rather than on a
 * user session. A driver message on these reaches an operator holding the
 * token, not a visitor — the same reasoning that excludes /api/admin/** and
 * /api/cron/** from the anon guard.
 *
 * `BREAKS_ADMIN_TOKEN` is in this list because app/api/breaks/** is an
 * operator-run live-break console, not a collector surface.
 */
export const OPERATOR_SECRET_RE =
  /INGEST_SECRET_TOKEN|CRON_SECRET|RPC_ADMIN_TOKEN|ADMIN_API_KEY|BREAKS_ADMIN_TOKEN|verifyAdminRequest|runStudioHistoryDrain/

/** Markers that a route resolves a signed-in user, i.e. a real person reads it. */
export const SESSION_GATE_RE =
  /requireUser|getCurrentUser|auth\.getUser|getSessionUser|requireSession|createRouteHandlerClient|getUserFromRequest|requireOwnedKey/
