# Overnight pass — 2026-10-26 (~1:05–1:30 AM PT)

> ⚠ **Oldest routed item (31 nights): #58 OPENSEA_API_KEY — Trevor-only secret, no sandbox lever.** See `## Queued for Trevor / Claude Code`.

> ⚠ **Scope of the push route:** this pass pushed via the **laptop-VM clone + the mount `.rpc-git-cred` store** — the cloud session had no `add_repo` tool and the repo is not attached to the cloud proxy (`git push --dry-run` → 403 "not in this session's authorized repository set"). This is a fact about *this cloud session*, not the artifacts. Trevor's machine and Claude Code push normally via Git Credential Manager — **commit these files as usual.**

**Posture:** GREEN · 0 production shipped · 0 reverted · queue-only. Push GREEN (laptop-VM route). Real time established from the DB (`now()` 08:03Z agreed with shell `date -u` to the second, corroborated by max sale-ingest 08:03Z / max FMV-compute 07:56Z — no clock skew), = ~1:03 AM PT, inside the overnight window.

## TL;DR
A quiet, healthy night. Health is GREEN across security, structure, pipelines and the accuracy gate. The whole app/api + Panini surface is **hot** — a very large Panini↔Top-Shot parity push landed across the 10-25 evening (Cowork + Claude Code; **631 unique files committed in the last 48h**), so almost nothing is non-hot, and nothing clean-safe + non-hot + independently verifiable was open to ship. The post-ship watch on that push is clean: all five new Panini pipelines are running ok, the one carried signal from last night (`get_panini_franchise_panel` 06:32Z timeout) did **not** recur, and the ULTIMATE-FMV retirement did not degrade the accuracy gate. One new, bounded signal surfaced (`panini_deal_board_all` cache-warm timeout, count=1) and one minor robustness nit (`refresh_panini_offer_spread` REFRESH self-collision, self-healed) — both queued, neither shippable on a hot surface.

## Gates & context
- **Clones:** cloud `$HOME/rpcwork` (reads) + laptop-VM `$HOME/rpcwork` (push). Cloud clone at `48ff97faa` (= origin/main) at clone time.
- **Lock:** prior `.lock` was `RELEASED 2026-10-25T08:17Z` (10-25 overnight normal exit, pushed `6f3f329a2`) → taken over, now `HELD 2026-10-26T08:03Z run=cowork-20261026T080357Z-26056`. Released at end of run.
- **FREEZE:** none.
- **Time / quiet-hours:** DB `now()` 08:03:23Z vs shell `date -u` 08:02:49Z → **no skew**; max sale ingest 08:03Z / max FMV compute 07:56Z corroborate (prod rows cannot be future-stamped). Real local = ~1:03 AM PT → genuine overnight → normal shipping permitted.
- **Push capability:** cloud `git push --dry-run` → **403** (repo not in the session's authorized set; `add_repo` tool absent this run). Push route = **laptop VM** (route 1): fresh `$HOME` clone + `store --file=$HOME/mnt/rip-packs-city/.rpc-git-cred`.
- **Collision gate:** `origin/main` = `48ff97faa`, did not advance between the run-start fetch and the pre-write fetch. 631 unique files committed in the last 48h = the whole surface is hot. Current prod deploy `dpl_E2h7hnDzfZ57ipae5MKFDkwjwyVk` @ `48ff97faa`, READY; last 6 production deploys all READY, no ERROR.

## Reviewed
- CLAUDE.md in full; ledger top matter; `metrics-latest.json`; last overnight handoff (2026-10-25); the newest inbox filing + INDEX.
- **Inbox:** one new filing since the last pass — `2026-10-26T0006Z-daytime-monitor-recent-low-usd-search-path-unpinned.md`. Already in origin + INDEX, and already **RESOLVED by Claude Code** (migration `20261026001535` — a curated `check_function_search_path_drift()` exemption for the inlined SQL helper; the filing's own proposed `ALTER … SET search_path` is explicitly marked "⛔ Do not apply" because a `SET search_path` makes the SQL function non-inlinable, measured ~13× slower). Confirmed live: `rpc_ops_snapshot().function_search_path_drift` = `[]`. **No action.**
- **Stranded-output sweep:** CLEAN. `flow-ecosystem-watch.md` mount hash == origin blob exactly. The mount `ledger.md` differs from origin only because the mount is **behind** origin (mount top heading "WNBA team walk" sits at origin line 23; the mount has 1130 headings vs origin 1134, and no heading the mount has that origin lacks) — Trevor's un-pulled checkout, not stranded output. The new inbox file is already in origin. Nothing to carry over.

## Health-drift triage (Section 2) — GREEN
- **Security:** invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [] (via `rpc_ops_snapshot.security`).
- **Structure:** stalled_pipelines [], backward_cursor_rewinds [], wmc_null_edition_key [], function_search_path_drift [] (recent_low_usd exemption landed), procedure pins [], cross_collection_mat_staleness [], suppression_*_drift []. `check_when_others_timeout_blind()` length = **0** (R118 clean).
- **Trust health:** 1 breach = `candy_sales_stale_hours` **340.7h** (breach 168) = known **#58** (Trevor-only frozen Candy book; 316.7 → 340.7h since the 10-25 08:30Z metrics = +24h, **0 new sales**, monotonic freeze). NOT re-raised. `trust_precompute_max_age_hours` 5.28 (breach 13) → trust reads fresh/reliable. `edition_integrity_flags` 22 (breach 250), `unmapped_resolution_backlog_max` 19 (breach 100, was 18), `panini_coverage_pct_drop` 5.3 (breach 15), `fmv_sweep_stall_pct_24h` 4 (breach 50) — all ok.
- **Zero-yield lanes** (`check_zero_yield_lanes()`): 2 offenders, both known-benign, neither a regression — **candy-sales-indexer** (last_find 10-12, 0 written) = #58 frozen book; **allday-unmapped-atlas-resolver** (last_find 10-18, 2090 runs, 0 written) = the forward-resolver documented 08-13 (it maps NEW unmapped pulls; 0 writes = no new unmapped pulls, and `unmapped_resolution_backlog_max` 19 is tiny and stable). 9 lanes already suppressed. Not suppressing these two tonight (a suppression is a behavioral judgment better made attended; both have legitimate, documented reasons).
- **Pipeline alerts:** 6 info arms, **0 critical** (last night had 1 critical). All are attributed Cloudflare-challenge 403s (Atlas editions 12.9%, market-feed 11.8%, supply, pack-supply, autograph) + the designed flow-rest "moment moved" 400. All fresh (last ok ticks/drains 08:03–08:04Z), none escalated (0 sets overdue; a full Atlas cycle is ~75 min).
- **pipeline_fails_24h:** topshot-pack-supply-atlas 334 (designed 403 re-ask, lane fresh, last 200 08:04Z), atlas-market-feed 13, atlas-editions-refresh 6, member-wallet 2, ingest-topshot-challenges 2, panini-offer-spread 1 (self-collision, below), topshot-offers-indexer 1, compute-allday-pack-ev 1, atlas-edition-supply 1, panini-ingest-enum 1 — all `upstream:0`, none stalled.
- **Sentry:** dark (SDK removed #34) — not used as a health signal.
- **Client-error beacon:** `usage_events` feature_name='client_error' = **0 in 6h, 0 in 24h** (newest 2026-10-23 05:04Z).
- **Vercel 24h:** **6 error groups** (down from 33 last night), **all count=1**, all chronic/bounded and degrading honestly: `panini_deal_board` statement-timeout (cache-warm cron, chronic since 10-04), `panini_deal_board_all` statement-timeout (**NEW, count=1 04:52Z** — the 10-25 Below-FMV Panini arm; cache-warm cron path, degrades to cache; QUEUED to watch), `pack_realized_ev`/`pack_lifecycle` 5000ms (chronic since 08-23), `market-cap tile` panini edition 8000ms (chronic since 10-13), `get_edition_fmv_history` Cloudflare 502 → degrade-to-empty (chronic since 10-16). **No franchise-panel timeout group** in the window (see post-ship watch). Prod serves `dpl_E2h7hnDzfZ57ipae5MKFDkwjwyVk`.
- **Accuracy gate (once-a-pass):**
  - NBA `fmv_sales_backtest('nba_top_shot',7)`: published ALL ratio **0.952**, median_abs_err 16.7%, within_25 64.4%; HIGH ratio **0.966**, err 11.1%, within_25 79.0%. Centered.
  - AllDay `('nfl_all_day',7)`: published ALL ratio 1.111 (median_abs_err_usd $0.05 — 93% of AllDay sales are sub-$1, so the pct is noise); HIGH ratio **1.067**, err 11.1%, within_25 72.0%, USD $0.02. Centered. (The STALE tier ratio 2.857 and ASK_ONLY 2.000 are the by-design non-reliable tiers, not published-HIGH.)
  - Panini (`fmv_sales_backtest` not wired for panini): not re-run this pass; last pass's manual spot-check was HIGH ratio 1.008 vs 30-day sales median, and the HIGH+MED distribution (16,778 + 934) is stable (+145 vs prev).

## Overnight deltas (vs metrics-latest.json, prev 10-25 08:30Z → this 10-26 08:05Z)
- DB size: 41,400 → **41,801 MB (+401)** — the new Panini objects (6 MVs/tables + the 36 MB offer index) from the 10-25 push; not runaway.
- FMV HIGH+MED: panini 17,567 → **17,712 (+145)**; nfl 1,718 → 1,730 (+12); pinnacle 938 → 944 (+6); candy 71 → 74 (+3); nba 6,568 → 6,566 (−2); golazos 1 flat; ufc 0 flat.
- Editions: panini 39,170 → **39,524 (+354)**; nba/nfl/golazos/ufc/candy flat.
- Trust breaches 1 → 1 (candy_sales_stale 316.7 → 340.7h).

## Post-ship watch — the 10-25 evening Panini parity push (all GREEN)
1. **Five new Panini pipelines** (all shipped 10-25 evening): `panini-product-rollup` 9/9 ok (hourly :06, last 07:06Z), `panini-edition-team-keys` 4/4 ok (hourly :32, 26,544 rows, last 07:32Z), `panini-public-deals` 3/3 ok (hourly :44, 10 rows, last 07:44Z), `panini-edition-ask-daily` 1/1 ok (daily; seed run 04:01Z, 1,482 rows — next scheduled 5:01 AM PT run is later today), `panini-offer-spread` **4/5 ok** (hourly :38, 6,021 rows, last 07:38Z). The one fail (05:10Z) was `cannot REFRESH MATERIALIZED VIEW … because it is being used by active queries in this session` — a transient self-collision; the 05:12Z run recovered and every run since is ok. Minor robustness nit queued (below).
2. **`get_panini_franchise_panel` (last night's carried item): did NOT recur.** No franchise-panel timeout group in the 24h Vercel window; `pg_stat_statements` mean **993ms** (down from 1,736ms), max still 13,805ms (cumulative since the 09-20 restart, not a new event), 1,413 calls. The 06:32Z burst was a one-off crawler/ISR sweep. Kept queued (the 13.8s tail remains a latent risk), downgraded to lower urgency.
3. **ULTIMATE FMV retirement** (`20261026025000`, 19 rows retired): did not degrade the accuracy gate — NBA HIGH ratio 0.966 (was 0.974), still centered. The 4 Knueppel /1s are NO_DATA as intended.
4. **`recent_low_usd` search_path** (today's inbox filing): resolved by Claude Code (`20261026001535`); `function_search_path_drift` = []. No action.

## Shipped
None. The whole surface is hot (631 files in 48h), health is GREEN, and nothing was clean-safe + non-hot + independently verifiable. A quiet night.

## Queued for Trevor / Claude Code
1. **[P2, Trevor, 31 nights] #58 OPENSEA_API_KEY** — the Candy secondary-venue key. Drives `candy_sales_stale_hours` (340.7h) and the Candy marketplace-status row. Trevor-only (secret); the three candy-opensea indexers are UNSCHEDULED (they do not run, so they cannot fail — the only open part is Trevor setting the key if he wants the Candy book to resume). No sandbox lever exists.
2. **[P2, Claude Code, 2 nights] `get_panini_franchise_panel` perf — bounded-timeout tail.** Did **not** recur this pass (no franchise-panel timeout in 24h; mean 993ms), but the max tail is 13,805ms and the page's bound is 10s, so a concurrent crawler sweep across all NBA franchise hubs can still tip it. Why not auto-shipped: route/RPC perf on a Panini franchise-hub surface shipped <48h (hot); the right fix needs a measured `EXPLAIN (ANALYZE, BUFFERS)` of the panel query for a slow franchise, then a targeted index on the hot predicate (likely on the new `panini_edition_team_keys`) or a panel precompute — not a blind additive index.
3. **[P3, Claude Code, 1 night] `refresh_panini_offer_spread()` REFRESH self-collision.** The hourly refresh failed once (05:10Z) with "cannot REFRESH MATERIALIZED VIEW … because it is being used by active queries in this session" — the function appears to hold an open read against `mv_panini_offer_spread` in the same session as the `REFRESH … CONCURRENTLY`. Self-heals (next run ok; 4/5 ok over 24h), so LOW. Not auto-shipped: the function body is hot (shipped <48h) and the fix is a route-logic judgment (separate the read from the refresh, or guard with an advisory lock). Ready-to-hand for an interactive session.
4. **[watch, Claude Code] `panini_deal_board_all` cache-warm timeout.** New count=1 statement-timeout at 04:52Z on `/api/cron/refresh-insights-cache` (the ALL variant of the Below-FMV board the 10-25 push added a Panini arm to). Cache-warm path, degrades to cache; not user-facing. Watch for recurrence; if it persists, the combined `cross_collection_deals_board` ALL query needs a look.

## Failed / blocked / reverted
None. No production shipping was attempted, so no first-failure hard-stop was triggered.

## Continuity written this pass
- This handoff (pushed to `main` via the laptop-VM route; mirrored to the claude.ai Project).
- Ledger: one green-night `### 2026-10-26` entry spliced above the first `^### ` heading.
- `docs/overnight/metrics-latest.json` overwritten with tonight's values.
- Session-log entry prepended to `docs/sessions/2026-10.md`.
- Inbox left untouched (append-only); the 10-26T0006Z filing is already resolved (Claude Code) — disposition recorded here.
- Lock released.
