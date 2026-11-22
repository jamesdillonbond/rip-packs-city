# Afternoon autonomous pass — 2026-11-20 (Claude Code cloud, ~4:24 → ~7:20 PM PT)

**Trevor:** "Can you work autonomously for the next 3 hours? Look through the project, database, sentinel, known issues, roadmaps, etc. fix any issues you encounter."

**Verdict: GREEN estate · 4 shipped (DB; one with census code; one fixing my own plan regression) + 1 shipped-then-reverted (code) · 1 held for a human · 1 scheduled self-check (7:50 PM PT).**
Push worked from this session (`git push` straight to `main`); no environment blocker.

## Health (read 4:20–5:10 PM PT)
- Security invariants, `detect_stalled_pipelines()` `[]`, `check_when_others_timeout_blind()` 0, trust board 0 non-ok rows, `get_pipeline_alerts()` info rows only (designed Atlas / Flow-REST base rates). Supabase advisors: the two `function_search_path_mutable` procedures are the documented must-not-pin pair (database.md); own drift checks `[]`.
- Vercel 24 h: 12 small error groups, none new or clustered beyond what the morning sessions already measured (UFC hubs read is 2 ms now; the ~3 AM PT board misses coincide with the hourly :06 cron burst).
- CI green on every push; E2E DOM smoke green all day; Pipeline Sentinel last run clean (gap matches GitHub's delivery rate, R61). Client beacon: 0 in 72 h (16 in 30 d, last 11-15).
- **Post-ship watch of the morning:** `apply-fmv-haircut` 2:35 PM PT `legs_skipped 0` ✓ · `rpc-allday-ev-corrected-refresh` 4:47 PM PT **succeeded** (74 s), the first scheduled run since `20261120191551` ✓.
- **Accuracy gate (`fmv_sales_backtest`, 7 d):** Top Shot published ALL 72.1 % within ±25 % (median ratio 1.000) vs `last3_median_30d` 70.2 %. All Day published 63.3 % (ratio 1.000) vs last-3 66.6 % — not like-for-like (published scores 3,742 sales, last-3 only the 3,434 with history); All Day LOW 44.5 % is the weak cell.

## Shipped
1. **`20261121002539`** — Zero-Yield arm suppresses `candy-orphan-name-only-editions` (the #246 cleanup is drained: whole name-only population 0; 58 new Candy editions in 7 d, none name-only). Arm reads 0 offenders.
2. **`20261121004754`** — `candy_retire_listings_owner_moved()` can finally reach the **legacy-collection phantom asks**. 9,619 of 10,156 active Magic Eden Candy asks were pre-migration phantoms (seller = old custody wallet, holder = the user's new wallet; 325 of 646 sellers traded before the 10-12 lock, 0 holders did; since reopening holders sell, sellers do not). The retirer's evidence gate needed the holder row rewritten after the ask appeared, which the insert-only legacy census never does. New arm: a single-run collection walk completed > 20 min after first-seen. Sized: 9,354 retire, 0 asks by anyone who has sold since reopening. Takes effect at `candy-listings-indexer` 7:35 PM PT. Pin + drift guard; preflight incl. the DB-invariant SQL suite green. **User-visible size (read ~5:20 PM PT):** of 3,673 Candy editions with an active ask, **3,194 show ONLY phantom asks** (listings that cannot fill) and on 131 more a phantom sets the floor (the real floor is a median 2.3× higher). These feed `candy_listing_floor` (FMV ask ceiling), the Market tab / % listed and the Spreads/Deals boards — expect those, and Candy FMV at its next pass, to move after 7:35 PM. Registry sets hold only 15 of the phantoms (10 unreached by their census; small, unaddressed). **Control (6:15 PM PT):** "sold before the lock" alone is not proof (pre-lock collectors still sell — 15 fills since reopening); the test that holds is who FILLS: the 10 sellers whose asks filled since reopening hold 329 of their 331 active asks themselves, while 1 of the 646 flagged sellers has sold since reopening.
3. **`20261121010254` + `lib/candy/collections-census.ts`** — the census stamps when a CLEAN walk began (`last_census_clean_walk_started_at`); the retirer accepts it, covering collections whose walk spans several runs.
4. **`20261121012809`** — fixes a COST regression I introduced in items 2–3: OR-ing the census evidence into the 11-08 UPDATE turned a per-ask index probe into a hash join over all 1.37M Candy holdings (56k → 370k buffers, 5 → 17 s cold). The census arm is now its own statement (68k / 1.3 s); same rows. Caught by EXPLAIN after shipping, before any production run used it.
5. Inbox: seven closed 11-17..11-20 filings retired in place (markers + RESOLVED sections).

## Shipped, then reverted (my error — read this; see also item 4 above, my second one)
- ~4:40 PM PT I shipped `a0096c4d9` (collections-market refreshes an unresolved ask's row when ME still serves it), reasoning that "served by ME" meant live. It does not — ME serves the pre-migration phantoms. Reverted at ~4:44 PM (`001d0bf42`); prod is on the revert. #257's watch had fired correctly. Lesson recorded in `docs/reference/chain-strategy.md` (new 2026-11-20 Candy section).

## Queued for Trevor / Claude Code
1. ✅ **CLOSED ~7:42 PM PT — the retirement landed:** 7:35 PM indexer run retired **9,426** phantom asks (ok, 0 write errors, 40.3 s — no cost regression); active ME Candy asks 10,161 → 734 (537 holder = seller, untouched; **196** flagged left, retiring as the census stamps their collections' clean walks — 111 stamped; read again in the overnight pass, expect ~0 by ~8 AM PT 11-21).
2. **[P3, Trevor, 0 nights] `pipeline_zero_yield_suppressions` — retire the `candy-sales-indexer` row.** Its own re-check condition fired this morning (`secondary_status` became `thin_since_2026_11_19`). The DELETE was held by the MCP's operator confirmation. Not urgent (the indexer is writing rows, so it is not an offender either way). Statement:
   `DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'candy-sales-indexer';` **Packaged for Cowork** (ready, no decision needed): same inbox filing, item 1.
3. ✅ **CLOSED same session (~5:03 PM PT, `20261121010254` + census code)** — `candy_collections.last_census_clean_walk_started_at` records when a clean walk began; the retirer accepts it. Inert until each collection's next walk completes (rotation ~12 h), then the ~265 multi-run-collection phantoms retire too.
4. ✅ **DONE ~8:32 PM PT (`20261121043220`, Trevor: "Yes, blank it") — 16,471 rows blanked, true zeros kept.** Original item: `candy_edition_market_daily` legacy floors since 11-14 — recorded off the phantom book (floor_ask_usd / listed_count on legacy editions). Size (read ~5:25 PM PT): **13,765 daily rows on 2,975 editions, 11-14 → 11-20**, carry a floor on an edition that has a phantom ask (an upper bound — some of those floors were set by a real ask). 11-08 nulled its own window with a backup table; doing the same here is a value rewrite (held). Decide whether history matters. ⚠ It is user-facing: every Candy edition page's market-history chart reads this table. **Packaged for Cowork** (SQL + backup + revert, gated on your yes): `docs/overnight/inbox/2026-11-21T0315Z-claude-code-for-cowork-held-delete-and-candy-daily-cleanup.md` item 2.
5. **[P3, Claude Code, 0 nights] `candy_offers`** — 4 active offers ($100) from one pre-lock wallet holding no cards; likely phantom bids. No retirer exists for offers; too small to build one today. ↳ ~7:50 PM PT: bidder's last trade 10-10, nothing since, 0 cards — packaged for Cowork as item 3 of the inbox filing (check the wallet's SOL balance, then a one-off UPDATE).
6. ✅ **CLOSED ~8:00 PM PT — legacy census coverage, explained without chain access.** `candy_collection_coverage` (built 11-08) reads 1.37M held of ~1.41M on-chain items; the 11-08 ledger already records that on-chain counts include PACK assets, which the census deliberately does not hold as cards (its tests walk a pack and a burnt item and count neither) — read coverage per kind. The >100 % side (169 excess rows, 32 collections) is 55 cards with two holder rows, all created after the 1:10 AM PT ghost purge — in-flight moves the next purge clears.

## Evening continuation (after "Keep goin", ~6:27–6:55 PM PT)
- **UFC Aptos sales lane** (`ufc-aptos-sales-ingest`): 0 sales on every run since 11-17 with 0 marketplace buys of ANY collection — indistinguishable between a quiet market and a stale entry-function list, and below the zero-yield arm's run floor. Added a positive control to the lane (unknown purchase function → run fails; empty list → indexer sample + purchase-named functions from any address). Three dry-run dispatches settled it: a quiet market (0 purchase-named transfers from any address in ~7 h; the indexer field is populated). Nothing to fix; the control stays.
- **`analytics_sales_leaderboard` (`20261121030008`)**: the 5:13 PM PT statement timeout on the Pinnacle seller board came from `is_returning` probes walking each top address's whole Flow `sales` history for a collection that never appears there (~28k rows). Pinnacle board 3.56 s → 34 ms; outputs byte-identical; pin gained Pinnacle/mixed cases that pass on both old and new bodies.
- Cost triage of pg_cron worker time: the top consumers are gated lanes whose time is a deliberate `pg_sleep` on scheduled minutes — no waste found. All collections' sales/FMV fresh (Pinnacle in its own tables: 183 sales in 24 h).

## Later evening (~7:45–8:30 PM PT) — reads, no change
- **Phantom retirement verified** (see ledger ~7:42 PM PT). Candy deals board: 0 rows on retired asks.
- **DB cost, measured as a 30-min pgss DIFF (7:45 → 8:16 PM PT), not the 101-day pooled view:** most heavy RPCs idle or cheap in the window. Per call: `fmv_recalc_historical_candidates` 43 s, `get_lock_check_batch` 30 s. The lock lane is healthy by its own record (48/48 ok daily, ~54k rows/day, avg ~40 s of a 300 s budget, stable since 11-09; its header's revert trigger is p90 > 180 s on a saturation-free window — not close). ⚠ A direct probe of both `get_lock_check_batch` calls exceeded 60 s cold and was cancelled (`pg_cancel_backend`, my own pid) — don't re-run it ad hoc.
- `backfill_wmc_metadata_from_editions`: checked for the rewrite-identical-values class (Top Shot `league` arm) — 0 rows stuck; clean.
- R152 premiums MV: not a cost win (~16 calls/day × 4.8 s ≈ 80 s/day < 24 hourly refreshes). Register updated.
- Candy daily-history cleanup (Cowork item 2) still needs Trevor's explicit yes — I did not record a general "do what you think is best" as approval for a specific rewrite of user-visible history.

## Not acted on (with reason)
- #249 (ISR caches a failed pack-dist render): the throw-on-regeneration fix was tried once and served Next's unbranded 500 to 515 users (08-23 comment in the page); needs a preview-verified design, not an unattended change.
- `refresh_wmc_fmv_changed` ~1 %/day statement timeouts: known, closed as low impact (#248).
- `?token=` arm removal: dated read ~11-26 (focus.md).

## FINAL STATE at thread archive — 2026-11-21 ~7:05 PM PT

**Closed in this thread (all on `main`, all in the ledger):**
- Candy phantom ASKS: 9,624 retired (`20261121004754` → `20261121010254` → `20261121012809`, incl. a fix to my own 6.6× plan regression); steady state ≤ one census+indexer cycle for newly re-surfaced phantoms; live control: 0 of 88 new real asks retired.
- Candy market-history: 16,471 phantom-era rows blanked (`20261121043220`, Trevor-approved; true zeros kept); caption names both withdrawn windows (`04c50d1a4`, verified in the rendered page).
- Zero-yield arm: drained Candy name-only lane suppressed (`20261121002539`); stale `candy-sales-indexer` suppression retired by Cowork (`20261121044524`).
- Pinnacle sales leaderboard: 3.56 s → 34 ms, output identical (`20261121030008`).
- UFC Aptos sales lane: positive control added; its zeros proven to be a quiet market.
- Register R151/R153 rows closed (fixed 11-15), R152 re-read; Cowork inbox filing `2026-11-21T0315Z` fully resolved.
- Trust board: all arms ok at 6:59 PM PT 11-21 (the self-inflicted `candy_ask_book_drop_pct` breach cleared as predicted).

**Owed after archive (handed to the overnight pass via `docs/overnight/focus.md`, top steer):**
1. The Candy offers FUNDING GATE's first real run, `candy-offers-indexer` 10:50 PM PT 11-21 (`2f6d01414`, escrow shape fixed): expect the 4 `GFGmpV5z…` phantom bids inactive and `funding_unknown` 0. If not, `funding_unknown_reasons` names the leg.

**Needs Trevor (one line):** retire the single remaining stale Candy ask `CFGipvw9…` (Blackest Night #1, $72.76, pre-lock seller; its card has no holder anywhere, so neither retirer arm reaches it, and a rule for it would flap real escrow listings — see #257). One-off `UPDATE candy_listings SET is_active = false WHERE pda_address = 'CFGipvw9iq69QEpdr3yiNjvYsBQXWwugXDdgnyBiq7Q9' AND is_active`; no writer re-activates it (unresolved asks are never upserted).

