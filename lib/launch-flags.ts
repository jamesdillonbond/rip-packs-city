// lib/launch-flags.ts
//
// Single-source-of-truth launch flags for STAGED public surfaces.
//
// WHY THIS FILE EXISTS
// Before this module, taking the gated Candy MLB board public was a 5-touch
// change spread across proxy.ts, lib/sitemap-data.ts, app/insights/page.tsx,
// app/insights/candy-mlb/layout.tsx and app/api/smoke-test/route.ts. Five
// touches in five files is five chances to half-ship a launch (e.g. un-gate the
// route but leave `noindex` on, so the surface is public AND invisible to
// crawlers — the exact failure the /insights wedge cannot afford).
//
// Every consumer below reads ONE boolean, so the go-live is a one-line diff and
// everything that should activate does so atomically in a single deploy.
//
// ⚠ These are COMPILE-TIME constants, not env vars, deliberately:
//   - the flip is reviewable in `git log` / `git diff` forever;
//   - Vercel builds the commit, so there is no "env set but not baked" window
//     (see memory: vercel-docs-only-tip-commit-skips-code-deploy);
//   - no risk of prod/preview env drift silently exposing a staged surface.
//
// ⚠ Flipping a flag here is a PUBLIC EXPOSURE change. It is Trevor's call only.

/**
 * Candy MLB ICONs (chain two, Solana / Candy Digital) public launch.
 *
 * `false` = STAGED: the board, its public JSON and its OG card are gated to
 * signed-in allow-listed users by proxy.ts, carry `robots: noindex`, and are
 * absent from the sitemap, the /insights hub and the public-page smoke list.
 *
 * `true` = PUBLIC: all five of those activate together, atomically.
 *
 * NOTE — this flag governs the /insights/candy-mlb SURFACE only. It is
 * independent of two other switches that are frequently confused with it:
 *   1. `collections.is_active` in Postgres (currently false for `candy_mlb`) —
 *      governs RLS-gated anon PostgREST reads of collections/editions/players/
 *      sets plus ~11 cross-collection rollups and the smoke freshness grader.
 *   2. `published` on the `candy-mlb` entry in lib/collections.ts (currently
 *      false) — governs nav, the collection switcher, footer links and the
 *      per-collection /candy-mlb/* tab routes.
 * See docs/candy-go-live-flip-2026-07-25.md for the full ordered procedure.
 */
export const CANDY_MLB_PUBLIC = true

/**
 * Panini WC Prizm squeeze board public launch. Same contract as
 * CANDY_MLB_PUBLIC. Trevor's decision (2026-07-25) was that Candy ships FIRST;
 * Candy went live and healthy on 2026-07-31, clearing that ordering gate, and
 * Trevor flipped this to `true` on 2026-08-01 (go-live).
 *
 * `false` = STAGED: gated to signed-in allow-listed users by proxy.ts, robots
 * noindex, absent from sitemap / hub / smoke list.
 * `true` = PUBLIC: all five consumers (proxy.ts, lib/sitemap-data.ts,
 * app/insights/page.tsx, app/insights/panini-squeeze/layout.tsx,
 * app/api/smoke-test/route.ts) activate together, atomically. Pinned in BOTH
 * directions by __tests__/panini-launch-flag-contract.test.ts.
 *
 * NOTE — this flag governs the /insights/panini-squeeze SURFACE only. The
 * board's data is listing-GATED (an edition enters the index only once listed;
 * ~47% trustworthy coverage), and the surface discloses that structurally via
 * `panini_coverage_summary` + `meta.coverage` on the public JSON. That
 * disclosure is a launch requirement, not a nicety — do not remove it.
 *
 * Rollback: set back to `false` + push (~3 min, no DB unwind).
 */
export const PANINI_PUBLIC = true
