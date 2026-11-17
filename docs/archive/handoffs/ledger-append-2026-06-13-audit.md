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

- **`get_edition_special_serials_drop_low_serials`** — dropped the low-serial (#2-10) branch per Trevor's directive that ONLY #1 / jersey match / perfect serial (=last mint #N/N) matter. Function now emits #1 / jersey / last_mint, preserving CC's wmc-holder + last-sale joins. Verified: LeBron 5:133 → #1 + #299; Clingan 1-of-1 → #1. Revert: re-add the `low` UNION branch. **(Display shipped by CC `893da9f`: last_mint → "Perfect Serial", low/last hero pills dropped — verified live.)**
- **`audit_20260613_v_insights_top_sales`** — backing view for the new public **/insights/top-sales (Top Sales / Whale Watch)** surface (biggest Flow sales last 30d, price>=100, security_invoker, granted anon/auth/service_role). 607 rows / 83 in 7d; invariants clean. Exposes moment_id for the reliable `media/<moment_id>/image` tile form. Frontend (route+page+OG+sitemap+hub card) queued for CC: docs/handoff-2026-06-13-top-sales-and-serial-fmv.md Item 1. Revert: `DROP VIEW public.v_insights_top_sales;`.

## QUEUED (CC — handoff-2026-06-13-cc-next-prompt-clear-all.md)

- **A. Special-serials display labeling** (relabel last_mint→"Perfect Serial", drop low/last hero pills) — Trevor-confirmed; small.
- **B. AllDay V1-Dapper price-recovery — SHIPPED (Cowork/Chrome, 2026-06-13).** Wired cron-job.org job **7818270** ("RPC V1-Dapper Recovery", donor-cloned from UFC-drain 7804392 so Bearer INGEST was inherited, never typed), `43 5 * * *` UTC, Enable=on. Test-run verified 200 `{ok:true,queued:true}`, `X-Matched-Path` = the recovery route (not /login). First run patched the price-uncertain backlog `price_usd=0` rows **236 → 34** (priced 10 → 212); the patched rows resolve on the next `promote_unmapped_sales` sweep, leaving the multi-NFT-unsplittable floor (~34). Daily cron maintains it. Revert: delete cron-job.org job 7818270.
- **C. Sentry NEXTJS-15** — fired post-bd8e05c (genuine reason); inspect AllDay V1 listing_resolution_failure reasons (likely same root as B), fix/seed, then resolve-after-quiet.
- **D. Anon overview panels** — fmv/demo confirmed public (200); confirm /<coll>/overview hides /api/sniper-feed (+packs/marketplace-status, still anon-307) rather than rendering empty.
- **E. Entity edition-page hero** — same Series-1 media-404 class as the moment hero; apply media/<momentId> or onError fallback.

## FMV ACCURACY VALIDATION (2026-06-13 evening continuation)

Deep-dive on FMV accuracy (the paid product) — verdict: **strong, no action needed.** Across 6,779 editions with >=5 sales/90d: **83.4% within a 2x band of their 90d median**; only **6 (0.09%)** have FMV > 1.5x their highest recent sale; **0** high-value mis-prices. The 600 "over 3x median" is serial-premium (FMV stays within the observed sale range — only those 6 exceed it), not over-pricing. The 6 above-max are all cheap ($3-75): 3 ASK_ONLY troll-ask cases (RJ Barrett $75 vs $3-8 sales; Stafford $7; Lamar $3 — all <$100) + 3 thin LOW (Cam Reddish $34, Satoranský $21, Wiseman $34). **ASK_ONLY troll-ask inflation affects 0 editions >=$100 and 0 >=$500** — immaterial to the paid product. Dapper cross-check (LeBron MetGold #258, Lillard RunItBack #5/28) confirmed metadata + that never-traded grail ASK_ONLY pricing mirrors Dapper's same thin listing market (no truer comp exists). **Minor pattern noted (no fix — pricing-logic, deferred):** when an edition has BOTH recent sales AND a troll ask, fmv-recalc occasionally picks ASK_ONLY over the sales (the 3 cheap cases). If it ever surfaces on an expensive edition, the fix is "prefer recent sales over a lone high ask" in fmv-recalc — handoff per FMV-patch-restraint, not Cowork. Conclusion: FMV is accurate; the real quality lever remains the tshb sales-history drain (auto) + the deferred per-serial layer.

## WATCH (carried)

- unmapped_sales open creeping 183→215→247 (AllDay resolver class, ~+30/day) — not yet alarming; revisit if it crosses ~400.
- DB size 4,544 MB (+~90/day creep); weekly-db-maintenance prune due ~06-14 04:23Z.
- Sentry NEXTJS-15 (allday-listings churn) — quiet since bd8e05c; resolve after 24h quiet (~15Z 06-14) with regression arming.

## CONFIRMED HEALTHY (audit 06-13, no action)

Security 0/0/0/0; detect_stalled []; get_pipeline_alerts []; trust-health 8/8; pipeline fails 14/12,834 (0.11%); sentinel TS-UUID 0; FMV TS HIGH+MED 3,350 ↑ / AllDay 677 ↑ / Pinnacle render 797; fmv-recalc 93/0; GHA + drain crons all ok (ufc-drain/tshb/buyer-backfill/badge-catalog/pinnacle-owner-discovery); Vercel prod 6b4aca4 READY (CANCELED deploys = docs-skip working as intended); 13 scheduled tasks on Opus firing; 12 active artifacts + 5 tombstones; /insights/trophies QA'd green (TROPHIES-INSIGHTS-QA closeable). Trophy + top-20 moment data: all resolve, Similar=6 everywhere, owner/FMV/recent-activity populated (2 never-traded grails honestly empty). Dapper cross-check (LeBron MetGold #258): all fields match.
