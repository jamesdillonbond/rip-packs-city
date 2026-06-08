# Handoff 2026-06-08 — full-audit follow-ups (POST-SHIP RECORD)

All 7 items from the Cowork full-platform audit (report: docs/audits/cowork-full-audit-2026-06-08.md) are SHIPPED. Trevor confirmed 7 commits on main + deploy 29715ed READY. This doc is the record + the one remaining ledger chore.

## Shipped by Trevor / Claude Code (7 commits on main)

1. 3364d4e — smoke-test Pinnacle FMV drift guard re-keyed to per-render pinnacle_catalog (trimmed+lowercased (character, set, variant) triple; catalog column is `variant`). Un-masks the canary. Sentry NEXTJS-14 resolved with regression arming.
2. eb39370 — /legal/* AND /blog opened to anon + sitemap (anon GET → 200 live-verified; /dashboard still 307→login).
3. 9912094 — /analytics Flowty surfaces reframed historical (badge, titles, JSON-LD, timeline). Live: "Flowty Wallet Directory (Historical)".
4. ccfce64 — minmax(0,1fr) grids + overflow-x on public surfaces (390px overflow class).
5. de01542 — brand-token sweep phase 1 (6 public surfaces) + scripts/check-brand-tokens.mjs CI guard scoped to those 6. ~70-file phase-2 debt (admin/dashboard/modals/email) documented in the guard header, NOT gated — future session.
6. 29715ed — polish: UFC $0→"—", "0 slots"→"exhausted", /api/cart isPublicPath removed, dead profilePageMetadata deleted, handoff-2026-05-28 archived, git identity → Trevor, ledger+CLAUDE.md logged.

## Shipped live by Cowork (DB migrations — need ledger Shipped-block entries)

- audit_20260608_seed_sets_wnba_skyline_254 — seeded the missing `sets` row for on-chain TS set 254 ("WNBA Skyline", series 8, tier NULL by design, external_id auto_onchain_254) + backfilled the orphan edition's set_id. Fixed the topshot-moments-hydrator catalog_gap that fired ~128x/day since 06-05; verified gone (ensure_topshot_edition_stub(254,8622) now resolves; no 254 gap in ticks since the seed).
  Revert: UPDATE editions SET set_id=NULL WHERE set_id=(SELECT id FROM sets WHERE external_id='auto_onchain_254' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'); DELETE FROM sets WHERE external_id='auto_onchain_254' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';
  Reconcile: when the GQL catalog creates the real UUID-keyed 254 sets row, merge into this seeded row (seeded row wins the set_id_onchain lookup first, so no ambiguity meanwhile).

- audit_20260608_squeeze_board_suppress_unanchored_low_ask (Item 7c, Trevor greenlit) — topshot_squeeze_board now suppresses low_ask (NULL) when fmv_usd IS NULL, so an FMV-less ULTIMATE shows "—" in LOW ASK instead of a $3.33M troll listing. Verified: fmv_usd IS NULL AND low_ask IS NOT NULL = 0 rows; security_invoker=on + anon SELECT preserved; only the squeeze page/API consume the view's low_ask (the edition page reads only squeeze_pct). 
  Revert: CREATE OR REPLACE the view with `be.low_ask` in place of `CASE WHEN fs.fmv_usd IS NULL THEN NULL ELSE be.low_ask END` (prior body in the migration comment + audit_20260530_topshot_squeeze_board_view). If a "shown-but-flagged-unanchored" treatment is preferred later, that's a page-side tweak in app/insights/squeeze/page.tsx.

## Remaining (light)

- Ledger: add the two audit_20260608_* migrations above to docs/overnight/ledger.md Shipped block with the revert paths (Cowork did not edit the ledger — repo-doc mount truncation hazard).
- OPERATOR (not CC): the minute-:00 pipeline spike is the wallet-backfill dispatch storm (seed-wallet-refresh chain), not the staggered crons — 20h histogram :00 = 1,233 runs, ~871 the wallet-backfill family, secondary :45–:52 pile. The 00:50 topshot-fmv-populate fail was a pool timeout inside the 00:48–01:05Z burst. Feed to stagger-histogram-verify-jun8 (8pm) before moving cron slots; likely lever = move seed-wallet-refresh off :00 (and NOT onto :45–:52).
- Phase-2 brand debt (~70 files) — future session, not gated.

GUARDRAILS: direct-to-main, no branches/PRs; PowerShell git on Windows; re-verify push with git rev-list --count origin/main..HEAD = 0; Vercel maxDuration cap 800s.
