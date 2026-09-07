// __tests__/helpers/market-liveness.ts
//
// ONE definition of "this copy claims the market is trading right now", shared
// by every closed-market honesty guard.
//
// WHY IT IS SHARED
//   Three guards written on 2026-09-06 each declared their own `LIVENESS`
//   regex, and they had already drifted apart — one banned "daily", one banned
//   "trading", none banned all of it. That is the copy-paste spread CLAUDE.md
//   names ("grep for the EXPRESSION, not the file"), reproduced inside the
//   guards meant to catch it.
//
// 🚨 WHY THE STEMS, AND THE BUG THAT FORCED THEM
//   The first version was `/\b(live|…|active|…|trading)\b/i`. A positive control
//   fed it a new tool card reading "Editions whose floor is being ACTIVELY
//   swept" — and it PASSED. `\bactive\b` cannot match "actively": the trailing
//   `\b` needs a non-word character, and "actively" continues with an "l". The
//   guard read as coverage while being silent about every inflected form.
//   ⚠ It was found ONLY because the control asserted a specific FAILURE and got
//   a pass — not by reading the regex, which looked obviously right.
//
//   So every stem below carries its inflections explicitly, and the cases that
//   proved the hole are pinned in market-liveness.test.ts. Add a token by adding
//   a case there FIRST.
//
// ⚠ DELIBERATELY NOT BANNED: "market", "price", "sale", "listing", "floor",
//   "deal". Those name things that still exist after a venue closes — a closed
//   market still HAS a final floor and recorded sales — and banning them would
//   make honest historical copy unwritable, which is how a guard gets loosened
//   later and stops catching anything.
//
// 🚨 AND "trad(e|es|ing)", WHICH I DID BAN FIRST AND THEN REMOVED — the reason
//   is the useful part. Every other token here is unambiguously present-tense:
//   "live", "real-time", "active", "currently", "now", "today", "daily". A
//   GERUND is not — it takes its tense from the clause around it. Banning it
//   fired on SIX sentences that are honest and past-tense:
//     "…what your moments were worth when trading stopped"
//     "…the last observed before trading stopped"
//     "…the packs are no longer trading"
//     "…the leaderboards rank what happened, not what is trading"
//     "FINAL OBSERVED DISCOUNTS, NOTHING IS TRADING"
//   Twice already this session the right call on a token collision was to change
//   the COPY, not the ban (see the sniper subtitle). This is the case where that
//   flips: six good sentences contorted to dodge one word is how a guard earns
//   enough resentment to be deleted wholesale later.
//   ⚠ THE RESIDUAL GAP IS REAL AND NAMED: a bare "Trading below FMV" would not
//   be caught. Nothing in the tree says that today; the compound forms that
//   matter are caught by their OTHER half ("currently trading" → currently,
//   "active trading" → activ). If a bare gerund claim ever ships, the answer is
//   a tense-aware check here, not re-adding the blunt stem.

/**
 * Matches copy asserting that trading is happening now.
 *
 * Stems are spelled out rather than left open-ended (`/activ/`) so the pattern
 * cannot swallow unrelated words: open stems would make "currency" and
 * "traditional" liveness claims.
 */
export const MARKET_LIVENESS_CLAIM =
  /\b(live|lively|real[\s-]?time|realtime|activ(?:e|ely|ity)|current(?:ly)?|now|today|daily|ongoing)\b/i

/** Convenience for `expect(...).not.toMatch()` call sites that want a fresh regex. */
export function claimsLiveMarket(text: string): boolean {
  return MARKET_LIVENESS_CLAIM.test(text)
}
