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

import { stripComments } from "../../scripts/lib/strip-comments.mjs"

/**
 * Spellings the leak has actually taken in this repo. All five were found in
 * production code; a grep for any ONE of them finds well under half the class,
 * which is why they are enumerated rather than approximated.
 *
 * Returns `"<line>: <text>"` for each offending line.
 */
export function leakSites(rawSrc: string): string[] {
  // ⚠ COMMENTS STRIPPED FIRST, and this is the repo's own standing rule for any
  // guard that greps source for a string: at least six guards here have fired on
  // the prose explaining the very fix they were checking. This one did too — a
  // comment on `app/api/top-sales/route.ts` describing why an internal envelope
  // field had been RENAMED away from `message:` was reported as a leak, on
  // 2026-08-23, minutes after the rename that satisfied the guard.
  //
  // ⚠ Stripping can only make this guard fire LESS, so it is worth stating why
  // that is safe rather than a loosening: a driver message inside a comment is
  // not published to anybody. The property is about what reaches a RESPONSE.
  //
  // ⚠ The shared stripper BLANKS rather than deletes, so line numbers survive
  // and the reported `<line>: <text>` still points at the real line.
  const src = stripComments(rawSrc)
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

  // (6) The SIBLING KEY. `error:` holds a fixed, safe literal and the driver
  //     text rides out in a neighbouring field:
  //       `{ error: "Failed to fetch listings", detail: message }`
  //     Every one of (1)-(5) is anchored on the `error:` FIELD, so all five miss
  //     this — including (4)'s indirect scan, which DOES collect `message` as a
  //     leaking variable and then looks for it after `error:`. Right file, right
  //     line, right variable, wrong field.
  //
  //     Found 2026-08-15 on /api/panini/listings; a sweep then found 35 sites
  //     across 20 files, 14 of them user-reachable (fast-break, rtr, wallet
  //     capability/preflight, owned-flow-ids). Both guards had run green over
  //     every one of them since they were written.
  //
  //     ⚠ The key list is enumerated, not approximated: `detail` is SINGULAR
  //     here and `details` was already in (1), which is exactly the near-miss
  //     that let this hide. `reason` and `hint` are the same leak wearing a
  //     different field name.
  const SIBLING_KEY = "(?:detail|details|reason|hint|debug|upstream|cause|stderr)"
  const siblingDirect = new RegExp(
    `\\b${SIBLING_KEY}\\s*:\\s*(?!result\\.|item\\.|row\\.|payload\\.)[A-Za-z_$][\\w$]*(?:\\?\\.)?\\.message\\b`
  )
  const siblingStringified = new RegExp(
    `\\b${SIBLING_KEY}\\s*:\\s*String\\(\\s*(?:err|e|error|ex|caught)\\b`
  )
  const siblingTernary = new RegExp(
    `\\b${SIBLING_KEY}\\s*:\\s*[A-Za-z_$][\\w$]*\\s+instanceof\\s+Error\\s*\\?`
  )
  const siblingInterpolated = new RegExp(
    `\\b${SIBLING_KEY}\\s*:\\s*\`[^\`]*\\$\\{\\s*(?:err|e|ex|caught)(?:\\?\\.)?\\.message`
  )

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
  // ...and the same collected variables published under a sibling key, which is
  // the exact shape found on /api/panini/listings:
  //   const message = err instanceof Error ? err.message : "Unknown error"
  //   { error: "Failed to fetch listings", detail: message }
  const siblingIndirectRx = indirect.size
    ? new RegExp(`\\b${SIBLING_KEY}\\s*:\\s*(?:${[...indirect].join("|")})\\b`)
    : null

  lines.forEach((line, i) => {
    if (
      direct.test(line) ||
      stringified.test(line) ||
      interpolated.test(line) ||
      inlineTernary.test(line) ||
      (indirectRx && indirectRx.test(line)) ||
      siblingDirect.test(line) ||
      siblingStringified.test(line) ||
      siblingTernary.test(line) ||
      siblingInterpolated.test(line) ||
      (siblingIndirectRx && siblingIndirectRx.test(line))
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
