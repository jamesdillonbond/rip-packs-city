HANDOFF — Q4: pinnacle-listings NEXTJS-15 warning (`listing_resolution_failures_inserted`) fires every tick
Date 2026-05-31. Topic: app/api/pinnacle-listings-indexer/route.ts. MED priority (Sentry noise + a real wrong-table resolver bug underneath). Diagnosed from live Sentry + DB; code refs from my repo mount (which is slightly behind your latest commits — verify line numbers against current code; your inspection wins).

CONTEXT / DIAGNOSIS (grounded in live data + the Sentry issue)
- Sentry JAVASCRIPT-NEXTJS-15 = captureMessage "listing_resolution_failures_inserted", culprit GET /api/pinnacle-listings-indexer, 1004 events, last seen minutes ago. bd4d8c4 scoped it to "genuinely-new inserts" but it still fires every tick — because there ARE genuinely-new failures each tick.
- listing_resolution_failures (live): 949 unresolved, 99.4% Disney Pinnacle, top reason `edition_key_not_in_editions_table` = 762 (80%), 941/949 already retry-capped (retry_count >= 10), ~13 genuinely-new/2h.
- ROOT CAUSE (confirmed in code, not hypothesis): the Pinnacle resolver derives an edition_key via pinnacle_nft_map (route ~line 478), then looks it up in the WRONG table — `.from("editions")` (~line 540) — and sets reason `edition_key_not_in_editions_table` (~line 573) when absent. But Pinnacle editions live in `pinnacle_editions`, not `editions`. Verified: of the distinct mapped edition_keys behind these failures, 62/93 exist in `pinnacle_editions` (only 23 in `editions`). So the resolver is checking the wrong table for the majority.

GUARDRAILS: direct to main, no branches/PRs; PowerShell git + verify push (git rev-list --count origin/main..HEAD = 0); curl fails silently in Git Bash; no CRLF string-replace patches; tsc clean before push. This is ingest-route logic — verify against the live contract; don't regress the AllDay/sport resolvers (this route is Pinnacle-only, so the change is scoped to it).

=====================================================================
ITEM 1 — P1 — Resolve Pinnacle edition_keys against pinnacle_editions
=====================================================================
FILE: app/api/pinnacle-listings-indexer/route.ts (~line 540, the `.from("editions")` lookup inside the per-listing resolution loop).
CHANGE: for this Pinnacle route, look the pinnacle_nft_map-derived edition_key up in `pinnacle_editions` (by `edition_key`) instead of (or in addition to) `editions`. pinnacle_editions.edition_key is the natural key (format royalty_code:variant_type:printing). On a hit, proceed to write the resolved listing/ASK exactly as today; only fall through to the failure-insert when it's in NEITHER table. Rename the reason to something accurate (e.g. `edition_key_unmapped`) since "editions_table" is misleading for Pinnacle.
VERIFIED IMPACT: 62/93 distinct mapped failing keys are in pinnacle_editions → this clears the majority of the mappable `edition_key_not_in_editions_table` failures and stops them re-failing every tick. (Secondary: ~23 mapped keys are already in `editions` yet still failing — sanity-check that path; likely stale failure rows that will self-resolve on the next retry once the lookup is fixed, or a key-format mismatch on the editions lookup. Not blocking.)
REVERT: git revert.
VERIFY: after deploy, watch listing_resolution_failures — new inserts with reason `edition_key_not_in_editions_table` should drop sharply; `SELECT count(*) FROM listing_resolution_failures WHERE first_seen_at > now()-interval '2 hours'` trends toward the genuinely-unmappable residual only.

=====================================================================
ITEM 2 — P1 — Make the Sentry capture rate-based, not per-insert (kills the noise)
=====================================================================
FILE: app/api/pinnacle-listings-indexer/route.ts (~line 727 `Sentry.captureMessage("listing_resolution_failures_inserted", …)`; there's already a "Sentry alert threshold" const ~line 46 — wire to it).
WHY: even after Item 1, Pinnacle has a permanent unresolvable tail (listings for editions not yet in pinnacle_editions / not in pinnacle_nft_map; ~8 keys in neither table; new listings each tick). Firing a captureMessage on EVERY tick that inserts ≥1 new failure is structural noise (1004 events / 19 days). 
CHANGE: only captureMessage when the count of genuinely-new, NON-capped failures in this run exceeds the existing threshold (the ~line 46 const) — i.e. an abnormal spike — OR when a failure has an UNEXPECTED reason (anything other than the known Pinnacle-unresolvable reasons `edition_key_not_in_editions_table`/`edition_key_unmapped`/`cadence_capped`). Expected-tail failures should log to pipeline_runs (for trend visibility) but NOT page Sentry every tick. Confirm the count feeding the capture EXCLUDES retry_count>=cap rows (the ~941 permanently-capped backlog) — the digest's "exclude the capped backlog"; the re-attempt loop already skips them (~line 643), so just make sure the capture's counter does too.
REVERT: git revert.
VERIFY: NEXTJS-15 stops firing every tick; it now only fires on a genuine spike or a new failure reason. Mark the Sentry issue resolved after 24h quiet.

EXPECTED END STATE
Item 1 → the wrong-table bug is fixed; the majority of Pinnacle listing-resolution failures resolve against pinnacle_editions and stop recurring. Item 2 → the residual expected-unresolvable tail no longer spams Sentry every tick (rate/reason-gated). NEXTJS-15 goes quiet; a real resolution regression would still surface. Both are scoped to the Pinnacle-only indexer route.
