RPC Claude Code handoff — Top Shot sales completeness + multi-factor special-serial FMV (2026-06-19)

CONTEXT

Goal: capture every Top Shot sale across any marketplace with buyer + seller fully mapped, then use the complete base to sharpen FMV, Pack EV, and special-serial premiums/owners — and evolve special-serial FMV into a multi-factor model. Full rationale + verified numbers live in docs/strategy/topshot-sales-completeness-and-serial-fmv-2026-06-19.md (read it first).

Already shipped live by Cowork today: migration audit_20260619_broaden_ts_sales_history_backfill_targets — broadened seed_topshot_sales_history_targets() to queue ALL ~9,091 canonical int-keyed TS editions with a resolvable set UUID (was 784; dropped the ASK_ONLY + zero-sales filters), re-seeded (+8,307 rows), and reset the 168 searchSetPlays-errored rows to pending. The backfill queue is now 9,091 editions (616 done, 8,475 pending). Security re-verified clean (check_secdef_anon_execute_violations = [], grants postgres+service_role only).

This handoff covers the code-side work Cowork cannot push (routes, workers, pricing logic). Items 1–4 are independent and shippable now; Item 5 is data-gated (build later). Skim docs/overnight/ledger.md first — Item 1 interacts with the queued BUYERBF-PERINVOCATION-WORK item (see note in Item 1). Nothing here should collide with files the nightly pass touched in the last 24–48h, but verify before committing.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. Verify every file path and edit location against the live tree before editing; line numbers below are approximate and will drift.

----------------------------------------

ITEM 1 (HIGH) — Wire spork-proxy into the buyer/seller decoder so historical (2020–22) sales get counterparties

Why: 210,159 TS sales (47%) have a NULL buyer; 208,438 NULL seller — overwhelmingly pre-2026. Every one has a transaction_hash, so they are decodable. The decoder fetches the tx result over current-mainnet REST, which cannot return results for transactions below the current spork's min block height (the 2020–22 tail). The spork-proxy worker (workers/spork-proxy/index.ts) reads those historical heights but is NOT wired into the decode path.

Files (verify first):
- lib/chains/flow/dapper-v1-tx-decode.ts — decodeTopShotSaleTx() fetches /v1/transactions/{txId}?expand=result over current REST (around the constant near the top and the fetch ~L228). This is the integration point.
- workers/spork-proxy/index.ts — confirm it can proxy a /v1/transactions/{id}?expand=result REST read (not only event/block-height reads on 8070). If it only proxies events, it needs a transaction-result passthrough added.
- app/api/admin/backfill-topshot-buyers/route.ts — the buyer-backfill that calls the decoder.

Change: add a height-gated fallback in decodeTopShotSaleTx — if the sale's block_height (or the tx's height, resolvable from the row) is below CURRENT_SPORK_MIN_HEIGHT, route the transaction-result fetch through spork-proxy (SPORK_PROXY_SECRET auth, the SPORK proxy URL env); otherwise keep current REST. Parse buyer (TopShot.Deposit.to) and seller (TopShot.Withdraw.from) identically.

Important coordination: routing historical txs through spork-proxy is SLOWER per row, and the existing buyer-backfill already runs near its 800s budget and overlaps (ledger item BUYERBF-PERINVOCATION-WORK). Do NOT just slow the existing forward backfill. Add a SEPARATE historical lane — e.g. a mode flag on backfill-topshot-buyers that selects only rows with buyer_address IS NULL AND block_height below current spork (or sold_at before the current-spork cutover date), routes them through spork-proxy, with its own conservative BATCH and its own cron entry — so the fast recent path is untouched. Most historical rows lack block_height (only 1,721 of 210K have it) — derive height from the tx via a cheap header lookup, or gate on sold_at date as a proxy for spork era.

Revert: git revert the commit. Worker change reverts via wrangler redeploy of the prior spork-proxy.
Verify: npx tsc --noEmit clean; deploy READY; pick a known 2021 TS sale tx hash and confirm the historical lane resolves its buyer + seller; over days, watch buyer_null on 2020–2022 sales fall (SELECT date_trunc('year',sold_at), count(*) FILTER (WHERE buyer_address IS NULL) FROM sales WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND sold_at < '2023-01-01' GROUP BY 1).

----------------------------------------

ITEM 2 (HIGH) — Raise history-backfill throughput to drain the 9,091-edition queue

Why: Cowork broadened the queue 784 → 9,091 editions (8,475 pending). The route self-budgets to ~180s and pages ~8 GQL pages/edition/run, so at current cadence the new queue drains slowly. This is the single biggest FMV-completeness lever — every drained edition recovers its full historical sale history (the mechanism already reaches back to 2020).

Files (verify first):
- app/api/cron/topshot-sales-history-backfill/route.ts — the per-run target count, ELAPSED_BUDGET_MS (~180s; maxDuration is 300, hard cap 800 — see guardrails), TX_PAGE_LIMIT (50), MAX_TX_PAGES (8), and the throttle gate (>15 failed pipeline_runs in 30min).

Change: increase editions processed per run (process N targets per invocation rather than a small batch) and/or raise the budget toward the 300s maxDuration, staying well under the 800s Pro cap. The cadence itself (cron-job.org or GHA schedule) is the other lever — raising frequency is operator-side; note it for Trevor. Keep the failure-throttle gate. Respect the priority column (LT-matched > wmc-held > zero-sales > covered) for ordering.

Revert: restore the prior constants (git revert).
Verify: npx tsc --noEmit clean; deploy READY; the progress table done count climbs materially over 24h (SELECT status, count(*) FROM topshot_sales_history_backfill_progress GROUP BY status); pipeline_runs for topshot-sales-history-backfill stay ok; sales row count for TS rises and per-edition lifetime-sales buckets shift up.

----------------------------------------

ITEM 3 (MED) — Fix the searchSetPlays "setmap" error (168 editions)

Why: 168 editions errored with "setmap: error with searchSetPlays" (the step that maps a set UUID to its play UUIDs via GQL). Cowork reset them to pending; if the root cause persists they will re-error after the retry cap. They share set UUIDs (e.g. 72eafe8b…, e93fee09…, 602dba53…), suggesting specific sets the searchSetPlays call chokes on (likely pagination on large sets, or a set whose plays the GQL returns differently).

Files (verify first):
- app/api/cron/topshot-sales-history-backfill/route.ts — the searchSetPlays GQL call and its error handling / pagination in the set→play mapping step.

Change: inspect one failing set's searchSetPlays response via the topshot-proxy; harden the mapping (paginate fully, tolerate the shape that's failing, or fall back to deriving play UUIDs from existing editions rows for that set). If a set genuinely can't be mapped via GQL, derive set_uuid→play_uuid from the editions table (we already hold both the int pair and the set UUID) rather than re-calling GQL.

Revert: git revert. (Data was already reset to pending by Cowork; no data revert needed.)
Verify: those 168 editions move from re-erroring to done/empty (SELECT status, count(*) FROM topshot_sales_history_backfill_progress WHERE edition_key IN (...) ...); no new "setmap" errors accumulate.

----------------------------------------

ITEM 4 (MED) — Confirm dapper.market sales settle through an indexed contract

Why: the live indexer (app/api/sales-indexer/route.ts) watches A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased and A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted. dapper.market (the post-Flowty secondary) settles on-chain — we need to confirm it settles via that NFTStorefrontV2 (already indexed) and not a different contract/event we're missing. Atlas listings go to topshot_active_listings, NOT sales (correct — listings ≠ sales).

What to do: decode one known recent dapper.market TS Moment sale (Flowscan or the Atlas tx) and confirm the settlement event is the NFTStorefrontV2 ListingCompleted we already index. If it's a new contract/event path, add a leg to sales-indexer mirroring the existing ones. Also confirm the V2→V3 native-market transition left no gap (older TopShotMarketV2 events).

Revert: git revert if an indexer leg is added.
Verify: a known dapper.market sale appears in sales within a cycle; no duplicate rows (dedup is on transaction_hash).

Do NOT attempt a blind chain-genesis event sweep of all Flow blocks — bounding completeness by edition (Items 1–2) gets the same FMV/EV/serial value far cheaper. Reserve spork access for targeted tx decode (Item 1).

----------------------------------------

ITEM 5 (LARGER, DATA-GATED — build after Items 1–2 have drained for a few weeks) — Multi-factor pooled special-serial FMV model

Why: the current serial_fmv_power_model fits price = k·fmv^β on only (tier × serial_bucket) — ~5 cells, FANDOM already unreliable, no player/badge/set/series/parallel/team factors. Trevor wants those factors weighed in. The blocker is sample size: only 1,086 #1 sales + 627 perfect-serial sales exist today — far too few to slice many ways. Items 1–2 grow that base; do not build the model until the special-serial sample has meaningfully increased.

Approach (full spec in the strategy doc §6): model log(premium ratio) = log(base_fmv) + serial_bucket + tier + badge + player[pooled] + set/series[pooled] + parallel[pooled] + log(circulation) + log(player_total_circulation) + log(player_special_serial_supply). Use partial pooling / ridge / mixed-effects so thin factor levels shrink to their group mean (a bigger lookup grid does NOT work — tier×badge×series×circ_band is already ~900 cells vs ~1,000 sales). Fit offline in Python, write coefficients/shrunken effects to a model table (same pattern as serial_fmv_power_model), apply in SQL at read time, recompute weekly via pg_cron, gate each prediction's confidence on its factor support, and keep the current power-law as the fallback when support is thin.

This is FMV pricing logic — ship with review per the pricing-change discipline (one-time data fixes are fine to ship; central pricing logic gets reviewed, never a blind in-place edit). Validate against held-out recent special-serial sales and compare to the current power-law before cutover. Factors map to existing columns (editions.player_name/set_name/series/team_name/tier/circulation_count/play_id_onchain, badge_taxonomy/get_edition_badges_unified, players.jersey_number) — jersey-match modeling needs a players.jersey_number backfill (~18% populated today).

Revert: additive model table + read-time switch behind a flag; revert = flip back to the power-law fallback.

----------------------------------------

GUARDRAILS (repeat every time)

- Work directly on main. NO branches, NO PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first, then commit + push there.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest for deploys/env writes.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly. Keep history-backfill / buyer-backfill maxDuration <= 800.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- Don't broad-read cron-job.org job-edit pages / admin/secret consoles (the Advanced-tab Authorization header is in the DOM even when hidden — a prior session leaked INGEST_SECRET_TOKEN that way). Scope reads to the specific control.
- After any DB function change: re-run check_secdef_anon_execute_violations() (expect []) and check_public_security_invariants() (expect 0).

EXPECTED END STATE

Items 1–4 committed to main, deploys READY, tsc clean. Over the following days/weeks: TS buyer_null falls sharply on 2020–2022 sales (Item 1); the history-backfill queue drains from 8,475 pending toward 0 and TS lifetime-sales buckets shift upward, lifting HIGH+MED FMV coverage (Item 2); 168 setmap errors clear (Item 3); dapper.market venue confirmed indexed (Item 4). Item 5 builds once the special-serial sample is large enough to fit the pooled model. Net: a near-complete, buyer/seller-mapped TS sales base that makes FMV, Pack EV, and a genuine multi-factor special-serial model all materially more accurate.
