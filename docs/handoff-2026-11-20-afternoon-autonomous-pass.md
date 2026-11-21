# Afternoon autonomous pass — 2026-11-20 (Claude Code cloud, ~4:24 → ~7:20 PM PT)

**Trevor:** "Can you work autonomously for the next 3 hours? Look through the project, database, sentinel, known issues, roadmaps, etc. fix any issues you encounter."

**Verdict: GREEN estate · 3 shipped (DB; one with census code) + 1 shipped-then-reverted (code) · 1 held for a human · 1 scheduled self-check (7:50 PM PT).**
Push worked from this session (`git push` straight to `main`); no environment blocker.

## Health (read 4:20–5:10 PM PT)
- Security invariants, `detect_stalled_pipelines()` `[]`, `check_when_others_timeout_blind()` 0, trust board 0 non-ok rows, `get_pipeline_alerts()` info rows only (designed Atlas / Flow-REST base rates). Supabase advisors: the two `function_search_path_mutable` procedures are the documented must-not-pin pair (database.md); own drift checks `[]`.
- Vercel 24 h: 12 small error groups, none new or clustered beyond what the morning sessions already measured (UFC hubs read is 2 ms now; the ~3 AM PT board misses coincide with the hourly :06 cron burst).
- CI green on every push; E2E DOM smoke green all day; Pipeline Sentinel last run clean (gap matches GitHub's delivery rate, R61). Client beacon: 0 in 72 h (16 in 30 d, last 11-15).
- **Post-ship watch of the morning:** `apply-fmv-haircut` 2:35 PM PT `legs_skipped 0` ✓ · `rpc-allday-ev-corrected-refresh` 4:47 PM PT **succeeded** (74 s), the first scheduled run since `20261120191551` ✓.
- **Accuracy gate (`fmv_sales_backtest`, 7 d):** Top Shot published ALL 72.1 % within ±25 % (median ratio 1.000) vs `last3_median_30d` 70.2 %. All Day published 63.3 % (ratio 1.000) vs last-3 66.6 % — not like-for-like (published scores 3,742 sales, last-3 only the 3,434 with history); All Day LOW 44.5 % is the weak cell.

## Shipped
1. **`20261121002539`** — Zero-Yield arm suppresses `candy-orphan-name-only-editions` (the #246 cleanup is drained: whole name-only population 0; 58 new Candy editions in 7 d, none name-only). Arm reads 0 offenders.
2. **`20261121004754`** — `candy_retire_listings_owner_moved()` can finally reach the **legacy-collection phantom asks**. 9,619 of 10,156 active Magic Eden Candy asks were pre-migration phantoms (seller = old custody wallet, holder = the user's new wallet; 325 of 646 sellers traded before the 10-12 lock, 0 holders did; since reopening holders sell, sellers do not). The retirer's evidence gate needed the holder row rewritten after the ask appeared, which the insert-only legacy census never does. New arm: a single-run collection walk completed > 20 min after first-seen. Sized: 9,354 retire, 0 asks by anyone who has sold since reopening. Takes effect at `candy-listings-indexer` 7:35 PM PT. Pin + drift guard; preflight incl. the DB-invariant SQL suite green. **User-visible size (read ~5:20 PM PT):** of 3,673 Candy editions with an active ask, **3,194 show ONLY phantom asks** (listings that cannot fill) and on 131 more a phantom sets the floor (the real floor is a median 2.3× higher). These feed `candy_listing_floor` (FMV ask ceiling), the Market tab / % listed and the Spreads/Deals boards — expect those, and Candy FMV at its next pass, to move after 7:35 PM. Registry sets hold only 15 of the phantoms (10 unreached by their census; small, unaddressed).
3. **`20261121010254` + `lib/candy/collections-census.ts`** — the census stamps when a CLEAN walk began (`last_census_clean_walk_started_at`); the retirer accepts it, covering collections whose walk spans several runs.
4. Inbox: seven closed 11-17..11-20 filings retired in place (markers + RESOLVED sections).

## Shipped, then reverted (my error — read this)
- ~4:40 PM PT I shipped `a0096c4d9` (collections-market refreshes an unresolved ask's row when ME still serves it), reasoning that "served by ME" meant live. It does not — ME serves the pre-migration phantoms. Reverted at ~4:44 PM (`001d0bf42`); prod is on the revert. #257's watch had fired correctly. Lesson recorded in `docs/reference/chain-strategy.md` (new 2026-11-20 Candy section).

## Queued for Trevor / Claude Code
1. **[P2, Claude Code (scheduled), 0 nights] `candy_retire_listings_owner_moved` post-ship read at 7:50 PM PT** — a one-shot self-check is scheduled in this session (`trig_01QDniAmk8vGyKDp2J9rwqFe`): holder≠seller active asks 9,619 → ~265; `candy-listings-indexer` 7:35 PM row `extra.owner_moved_cards` ≈ 9.3k; holder=seller asks (536) unchanged. If it did not run, the next pass reads the same.
2. **[P3, Trevor, 0 nights] `pipeline_zero_yield_suppressions` — retire the `candy-sales-indexer` row.** Its own re-check condition fired this morning (`secondary_status` became `thin_since_2026_11_19`). The DELETE was held by the MCP's operator confirmation. Not urgent (the indexer is writing rows, so it is not an offender either way). Statement:
   `DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'candy-sales-indexer';`
3. ✅ **CLOSED same session (~5:03 PM PT, `20261121010254` + census code)** — `candy_collections.last_census_clean_walk_started_at` records when a clean walk began; the retirer accepts it. Inert until each collection's next walk completes (rotation ~12 h), then the ~265 multi-run-collection phantoms retire too.
4. **[P3, Trevor, 0 nights] `candy_edition_market_daily` legacy floors since 11-14** — recorded off the phantom book (floor_ask_usd / listed_count on legacy editions). Size (read ~5:25 PM PT): **13,765 daily rows on 2,975 editions, 11-14 → 11-20**, carry a floor on an edition that has a phantom ask (an upper bound — some of those floors were set by a real ask). 11-08 nulled its own window with a backup table; doing the same here is a value rewrite (held). Decide whether history matters.
5. **[P3, Claude Code, 0 nights] `candy_offers`** — 4 active offers ($100) from one pre-lock wallet holding no cards; likely phantom bids. No retirer exists for offers; too small to build one today.
6. **[P3, Claude Code, 0 nights] legacy census coverage** — 445,081 of 479,509 legacy cards walked; 117 of 318 collections > 10 % short (e.g. Blackest Night 520 / 568). Unexplained (burns? DAS gaps?). Needs DAS / chain access this sandbox lacks.

## Not acted on (with reason)
- #249 (ISR caches a failed pack-dist render): the throw-on-regeneration fix was tried once and served Next's unbranded 500 to 515 users (08-23 comment in the page); needs a preview-verified design, not an unattended change.
- `refresh_wmc_fmv_changed` ~1 %/day statement timeouts: known, closed as low impact (#248).
- `?token=` arm removal: dated read ~11-26 (focus.md).
