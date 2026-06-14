# Ledger append — 2026-06-13 evening Cowork full audit

Merge into docs/overnight/ledger.md (kept separate; editing the 192KB ledger from Cowork truncates it).

## SHIPPED (Cowork, live)

- **`audit_20260613_trophy_slab_live_fmv_resolve`** — `get_trophy_slab_data(uuid)` now resolves LIVE fmv/tier/circ from the canonical edition (wmc moment_id → edition_key → editions → latest fmv_snapshot), live-first with frozen fallback, + additive `fmv_confidence`. Fixes the trophy case showing frozen pin-time FMV (up to 2.6x stale) and null tier rendering as "COMMON". Root cause: the old join keyed on `e.external_id = tm.edition_id`, but tm.edition_id is the inert UUID-pair for TS slabs → join failed → frozen fallback. `get_trophy_slab_data_by_username` delegates here, so dashboard + public profile both fixed. Verified live on /dashboard: Deni Avdija ULTIMATE (was COMMON) #1/1; Lillard Cosmic $425 (was $1,100); Amon-Ra $450 (was $1,045); Clingan $2,100; LeBron Anthology $1,800. Security 0/0; grants service_role+authenticated+postgres preserved; check_secdef_anon_execute_violations []; check_public_security_invariants 0.
  - **Revert:** `CREATE OR REPLACE FUNCTION public.get_trophy_slab_data(uuid)` with the prior body — editions join `LEFT JOIN editions e ON e.external_id::text = tm.edition_id AND e.collection_id = tm.collection_id`, COALESCE(tm.x, e.x) frozen-first columns, no fmv_snapshots join, no fmv_confidence. (Full prior def captured in docs/audits/full-platform-audit-2026-06-13.md / handoff-2026-06-13-audit-trophy-moment-media.md Item 0.)

## SHIPPED (CC, commit `45f52bb`, deploy READY — 2026-06-13)

All five handoff items landed (tsc clean, brand-guard clean, /api/health 200). Independently re-verified by Cowork: `/moment/25510` (Lillard Cosmic, edition 8:145, previously blank) now serves `media/25510/image` @1080 + renders the Special serials section; `/moment/134293` serves `media/134293/image` (CC-verified).

- **MOMENT-HERO-MEDIA (HIGH) — SHIPPED.** New `components/MomentHeroMedia.tsx` prefers `assets.nbatopshot.com/media/<momentId>/image`, walks an ordered image-candidate list on error, and hides a 404ing video to reveal the image — never a blank box. Fixes the 6/21 Series-1 blanks (LeBron Base 2:133, LeBron MetGold 5:133, Harden/Zion/Oladipo Holo MMXX 4:82/4:127/4:142, Lillard Cosmic 8:145). Revert: `git revert 45f52bb`.
- **SPECIAL-SERIALS-PARITY (MED) — SHIPPED** (migration `get_edition_special_serials_add_wmc_holder`): extended `get_edition_special_serials` to attach current holder + nft_id from wmc; fills the previously-empty owner column on the edition-page board + adds a moment-page "Special serials" section (gated on real content). **Ceiling:** owners only where wmc indexes them (~30% of TS #1 serials; e.g. flagship LeBron 5:133 #1/#299 owners not indexed → shown with last-sale + "—"). Full per-special-serial owner parity needs a per-edition on-chain holder index we don't have — flagged. Revert: re-CREATE the prior 4-column body.
- **RECENT-ACTIVITY-COPY (LOW) — SHIPPED:** "No sales in the last 30 days." → "No recorded sales yet."
- **TROPHY-SLAB-CONFIDENCE-CHIP (LOW) — SHIPPED:** TrophySlab shows the `fmv_confidence` dot + STALE/ASK/EST label beside slab FMV.
- **TROPHY-EDITION-ID-CANONICALIZE (LOW, DB) — SHIPPED** (migration `trophy_moments_canonicalize_edition_id`): 6 TS rows UUID-pair → int-pair via wmc; 0 remaining. Cosmetic (get_trophy_slab_data resolves via wmc regardless); no functional revert needed.

## SHIPPED (Cowork, follow-up — 2026-06-13 evening)

- **`get_edition_special_serials_drop_low_serials`** — dropped the low-serial (#2-10) branch per Trevor's directive that ONLY #1 / jersey match / perfect serial (=last mint #N/N) matter. Function now emits #1 / jersey / last_mint, preserving CC's wmc-holder + last-sale joins. Verified: LeBron 5:133 → #1 + #299; Clingan 1-of-1 → #1. Revert: re-add the `low` UNION branch. **Display follow-up queued for CC** (Item A): relabel `last_mint` → "Perfect Serial" + drop the moment-page hero "Low Serial"/"Last Mint" pills.

## QUEUED (CC — handoff-2026-06-13-cc-next-prompt-clear-all.md)

- **A. Special-serials display labeling** (relabel last_mint→"Perfect Serial", drop low/last hero pills) — Trevor-confirmed; small.
- **B. AllDay V1-Dapper price-recovery drain** — 247 unmapped (all V1-Dapper price-uncertain: 199 mapped+price-parked, 47 retry-retired). Wire `/api/admin/recover-v1-budget-exhausted` on a cron. LOW.
- **C. Sentry NEXTJS-15** — fired post-bd8e05c (genuine reason); inspect AllDay V1 listing_resolution_failure reasons (likely same root as B), fix/seed, then resolve-after-quiet.
- **D. Anon overview panels** — fmv/demo confirmed public (200); confirm /<coll>/overview hides /api/sniper-feed (+packs/marketplace-status, still anon-307) rather than rendering empty.
- **E. Entity edition-page hero** — same Series-1 media-404 class as the moment hero; apply media/<momentId> or onError fallback.

## WATCH (carried)

- unmapped_sales open creeping 183→215→247 (AllDay resolver class, ~+30/day) — not yet alarming; revisit if it crosses ~400.
- DB size 4,544 MB (+~90/day creep); weekly-db-maintenance prune due ~06-14 04:23Z.
- Sentry NEXTJS-15 (allday-listings churn) — quiet since bd8e05c; resolve after 24h quiet (~15Z 06-14) with regression arming.

## CONFIRMED HEALTHY (audit 06-13, no action)

Security 0/0/0/0; detect_stalled []; get_pipeline_alerts []; trust-health 8/8; pipeline fails 14/12,834 (0.11%); sentinel TS-UUID 0; FMV TS HIGH+MED 3,350 ↑ / AllDay 677 ↑ / Pinnacle render 797; fmv-recalc 93/0; GHA + drain crons all ok (ufc-drain/tshb/buyer-backfill/badge-catalog/pinnacle-owner-discovery); Vercel prod 6b4aca4 READY (CANCELED deploys = docs-skip working as intended); 13 scheduled tasks on Opus firing; 12 active artifacts + 5 tombstones; /insights/trophies QA'd green (TROPHIES-INSIGHTS-QA closeable). Trophy + top-20 moment data: all resolve, Similar=6 everywhere, owner/FMV/recent-activity populated (2 never-traded grails honestly empty). Dapper cross-check (LeBron MetGold #258): all fields match.
