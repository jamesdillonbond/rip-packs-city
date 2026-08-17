// __tests__/helpers/client-directive.ts
//
// ONE correct answer to "is this file a client module?", shared by every guard
// that needs to split the client tree from the server tree.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Four guards each answered it differently, and three were wrong in the same
// direction — they read a truncated prefix and an anchored pattern, so a file
// whose `"use client"` sits behind a HEADER COMMENT reads as a server file:
//
//   client-page-gate-ratchet            src.slice(0, 200)  + /^\s*["']use client["']/
//   client-page-fetch-honesty-ratchet   first 3 LINES      + the same anchored pattern
//   client-failure-collapses-to-empty   src.slice(0, 300)  + .includes("use client")
//   insights-gate-include-completeness  src.slice(0, 200)  + the same anchored pattern
//
// Measured 2026-08-16, that hid THREE client pages from the gate ratchet —
// `app/login/page.tsx` (directive at char 780), `app/early-access/page.tsx`
// (245) and `app/auth/confirm/page.tsx` (631) — so its population read 5
// against a true 8. ⚠ The ratchet asserts NO SLACK, which made the undercount
// look EXHAUSTIVE: a reader sees `BUDGET = 5` and concludes five pages remain.
// And the three hidden pages are the entire auth funnel — sign-in, signup and
// magic-link confirmation — i.e. the surfaces least able to afford being
// outside both coverage gates AND the ratchet meant to bound them.
//
// This is the guard-scope class this repo keeps paying for: a mechanism's own
// derivation decides what it can observe. The fix is the same one that worked
// for the driver-message leak spellings — one source of truth, so widening it
// widens every caller at once.
//
// ── WHY NOT JUST WIDEN THE SLICE ───────────────────────────────────────────
// A bigger prefix moves the cliff, it does not remove it, and `.includes` on a
// prefix is worse than an anchor rather than better: it matches a COMMENT that
// merely mentions the directive, which is a false positive in the direction
// that adds phantom work. The directive is defined positionally — it must be
// the first statement in the module — so the only correct test is to skip
// exactly what may legally precede it (whitespace and comments) and look at
// what comes next.

/**
 * True when `src` is a client module, i.e. its first *statement* is the
 * `"use client"` directive.
 *
 * Leading whitespace, `//` line comments and block comments are skipped, so
 * the directive is found however long the file's header is. A mention of
 * `use client` inside a comment or anywhere later in the file is NOT a
 * directive and does not count.
 */
export function isClientSource(src: string): boolean {
  let i = 0
  const n = src.length

  // Skip whatever may legally precede the directive: whitespace and comments.
  for (;;) {
    while (i < n && /\s/.test(src[i])) i++
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i)
      if (nl === -1) return false
      i = nl + 1
      continue
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2)
      if (end === -1) return false // unterminated block comment: no statement follows
      i = end + 2
      continue
    }
    break
  }

  const rest = src.slice(i)
  return /^(["'])use client\1\s*;?/.test(rest)
}
