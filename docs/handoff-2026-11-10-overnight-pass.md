# Overnight pass — 2026-11-10 (~1:05 AM PT)

> ⚠ **Environment scope:** this pass ran in a **cloud session linked to Trevor's laptop**. Push WAS available via the laptop-VM clone + `.rpc-git-cred` route (dry-run exit 0); there was no cloud `add_repo` tool. **Nothing was blocked by the environment** — the only item not actioned is a held DB write + a trust-gate judgment that belong to a human/Claude Code regardless of environment. On Trevor's machine, Claude Code pushes normally via Git Credential Manager; commit these docs as usual if they land mount-only.

**Mode:** genuine overnight (real local time ~1:05 AM PT, clock verified against DB — shell 09:02:35Z vs DB now() 09:02:46Z, no skew). Not frozen. Lock taken (run id `1be819529a3c`), released at end.

**Verdict: GREEN · 0 shipped · idle: blocked (held MCP write + trust-gate decision) · oldest routed: #228 cold-whale SQL levers, 6 nights.**

A quiet, honest night. The 11-09 daytime/evening audit passes shipped heavily (market-pulse cache, Candy orphan cleanup, sentinel scopes, h1 fixes, R118 guard); this pass confirmed all of them healthy, drained the inbox, ran the full health sweep + accuracy gate, and found exactly one new instrument finding — which is a held write and a judgment call, so it is queued, not shipped.

---

## What was reviewed

- **Capability triage:** shell green; push GREEN (VM clone + `.rpc-git-cred`, dry-run exit 0); Supabase + Vercel MCP up; device bridge (`get_device_info` + `device_bash`) alive; no cloud `add_repo` tool. Clock verified vs DB (no skew). Lock RELEASED from 11-09, taken over. No FREEZE.
- **Continuity:** ledger top matter, `metrics-latest.json`, focus.md (11-09 steers), `ops:ready-queue` report, inbox INDEX, newest handoffs.
- **Inbox drained:** the two "apply staged SQL" filings (`2026-11-10T0039Z` two staged migrations, `2026-11-10T0202Z` rip-metadata rotated slice) both carry **✅ RESOLVED** sections — applied 11-09 evening via the dashboard SQL editor (`20261110004700`, `20261110005700`, `20261110021600`). The Candy trophies/orphan filings (`0318Z`, `0359Z`, `0430Z`) were closed by the 11-09 evening ships (`20261110041400` + the name-only cleanup migration). `0552Z` watch-list and `0645Z` revival-sale are informational. No inbox file moved or edited (append-only rule).
- **Post-ship watch on the 11-09 evening ships** — see below, all CLEAN.
- **Full health sweep + FMV accuracy gate** — see Section 2.

## Section 2 — health-drift findings + deltas

**Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations `[]`. R118 `check_when_others_timeout_blind()` = 0. Zero-yield lanes: 386 inspected, 0 offenders (the retired Flowty `*-listing-cache` lanes aged out as predicted). `detect_stalled_pipelines()` `[]`. Sentinel TS-48h 0.

**Trust breaches: 5 — 4 known-shape, 1 new (queued):**
- `edition_integrity_flags` **20,627 → 11,045** — census-driven Candy name-only edition nulls, **FALLING exactly as the #246 steer predicted** (the repair laps repoint cards and the hourly orphan jobs delete the unheld ones). Fail-safe. Do NOT touch.
- `candy_ask_book_drop_pct` 91.2 / `candy_sales_stale_hours` 11.7 / `candy_revival_sales_since_recorded_silence` 1 — the Candy wind-down cluster (Magic Eden asks retired as owners migrated; the one $0.17 revival sale on 11-09). Dispositioned, nothing to change.
- **NEW — `public_board_empty_count` 1** (`public_board_slow_count` 0). The offending board is **`candy_offer_spread_board`: 22 rows vs its `min_rows` floor of 30**, no error, 282 ms. The metric reads `public_board_liveness_state ⋈ public_board_liveness_watchlist` (latest sweep per active view), not stale history. Row-count trend: a **steady 120 through 11-07**, then contraction tracking the Candy ask/offer book — 11-08 avg 94, 11-09 avg 67, 11-10 avg 59 (min 22, max 95). This is a **real market contraction, not a pipeline fault** — the board serves real rows; the floor is stale. **Queued** (see below).

**FMV accuracy gate — IN BAND:**
- Top Shot `published` ALL: median_ratio **1.000**, abs_err 14.0%, within-25% 69.3%. HIGH 1.000 / 11.1%.
- All Day `published` ALL: median_ratio **0.909** (≥0.90 — the focus-steer "act if <0.90" trigger is **not** met); HIGH 0.880, MED 0.917; median_abs_err_usd **$0.04–0.05** (the known sub-$1 quantization — 93% of All Day sales are under $1). All Day LOW 0.75 haircut in place. Consistent with 11-04 → 11-09.

**Deltas vs 11-09 metrics:** db 49,644 → **50,759 MB** (+1,115, census editions). edition_integrity_flags 20,627 → 11,045 (repair falling). FMV HIGH+MED: nba 6,271→6,867, panini 18,466→19,159, nfl 1,598→1,781, pinnacle 982→968, candy 2→1. candy_mlb editions 22,127 → 22,021 (orphan cleanup starting to net against census growth). Trust breaches 3 → 5 (added `public_board_empty_count` [new] + `candy_revival_sales` [the 11-09 sale]).

**Vercel 24h runtime:** 29 error groups (was 32), **all chronic** read-exceeded / statement-timeout / degrade-to-empty (market-pulse 27, wallet-summary 8, pack-sniper 5, cost-basis 3, set activity 3, franchise-hub bursts, etc.). No new crash group, nothing spiking. One newish low-sev group: `[entity-section] candy player top collectors … degrading to empty` (1 occurrence, 1 user, degrades gracefully — Candy-census-era load, not actionable). Live prod = `f0b03a04e` READY.

## Post-ship watch — the 11-09 evening ships (all CLEAN)

- **Market-pulse cache** (`20261110075950` + code `f0b03a04e`): pg_cron `rpc-market-pulse-cache` (jobid 853, `9-59/10 * * * *`) succeeding every 10 min, last 09:09Z. The `[insights/Market pulse]` Vercel group (27, the largest) had its **last error at 07:21Z**, before the `f0b03a04e` deploy went live (~12:40 AM PT 11-10); **no market-pulse error since** (window still short — confirm it falls to ~0 on tomorrow's pass).
- **Candy orphan cleanup** (`20261110041400` one-of-one + name-only migration): `candy-orphan-name-only-editions` 4/4 ok (last :37), `candy-orphan-one-of-one-editions` 5/5 ok (last :22). `edition_integrity_flags` falling confirms the laps are landing.
- **R118 guard** (`20261110060836`): `check_when_others_timeout_blind()` = 0.
- **Sentinel `candy_legacy_catalog` scope** (`20261110072431`): secdef drift 0 (invariants clean).
- No regression traced to any recent ship.

## Focus reads (11-09 steers)

- **`wmc-metadata-selfheal` (2:31 AM PT) and `topshot-map-atlas-reconcile` (pg_cron jobid 818, `47 12 * * *` = 4:47 AM PT):** both last ran **pre-fix** and timed out (120s). Each is a daily lane; the next run (10:31Z and 12:47Z 11-10) is the **first post-fix run** and fires AFTER this pass. jobid 818 is active; cron `status=succeeded` on the 11-09 run is dispatch-only (the work timed out). **Carried to the next pass** — read each lane's 11-10 row for `ok=true` to close the Sentinel Pipeline-Success-Coverage warn; a repeat timeout → read `pipeline_runs.error` before touching.
- **Trophies liveness probe:** `public_board_slow_count` 0 — no active board breached its `max_ms`; trophies under its 7,000 ms budget (ledger 11-09 measured 3,911 ms). The `v_insights_trophies` FMV-lateral lever stays queued; re-baseline only after Candy settles.
- **Candy census 429:** bursty, NOT sustained — last 8 runs all ok=true, `rl_retries/hydrate_fetches` mostly 0% with isolated 3.4% / 13.6% spikes; the `5afb9e8b6` back-off is handling it and `wmc_repointed` stays 5k–12k/run. The concurrency lever (48→32) is **not** warranted.
- **#245 wallet-backfill-continuation:** no failure rows in 24h — nothing to update.
- **#243 trophy picker:** one `/api/profile/top-moments` read-budget timeout in 24h (chronic class, 1 user) — not a reopening spike. Watch.

## Queued for Trevor / Claude Code

1. **[MED, Trevor or Claude Code, new] `candy_offer_spread_board` liveness floor is stale after the Candy offer-book wind-down.** The board served a steady 120 rows through 11-07, then contracted to 22–95 (avg 59) as Candy asks/offers were retired — tripping its `min_rows=30` floor and raising `public_board_empty_count`. The board is **healthy** (serving real rows, 282 ms); the floor is the problem. This is a **held write** (a watchlist `UPDATE` — this headless session cannot run it; the MCP holds value changes for operator confirmation) **and a trust-gate judgment**, so it is not autonomous. Decision for Trevor: lower the floor, or retire the board, or accept the intermittent breach. If lowering, a floor **below the recent minimums** (17/22/28 on 11-08/09/10) is safe — e.g. 15:
   ```sql
   -- dashboard SQL editor (Trevor's Chrome) or Claude Code
   UPDATE public.public_board_liveness_watchlist
      SET min_rows = 15
    WHERE view_name = 'candy_offer_spread_board';
   -- revert: SET min_rows = 30
   ```
2. **[P3, Claude Code (in progress), 6 nights] #228 cold-whale SQL levers.** Route/SQL work on the cold-whale read path — not an autonomous sandbox lever. This window: `/api/collection-snapshot` was **quiet** (0 Vercel groups in 24h); the extended arm `/api/wallet-summary` still fires **8×/24h** (`RPC_READ_TIMEOUT`, cold whale reads, 25s cold / 1.4s warm). Still carried to Claude Code.
3. **[MED, Claude Code, carried] `candy-collections-census` ⋈ `wallet_moments_cache` contention** (filing `2026-11-09T0708Z`). The census and the self-heal lanes share hot tables; the self-heal lanes' structural timeouts (see focus reads) are the live symptom. Hot-file census work — Claude Code owned.

## Not due yet (carried, no action)

- `net._http_response` weekly growth read — P4 Trevor, due ~11-11 (tomorrow).
- #58 OPENSEA_API_KEY / candy_mlb silence re-verify — P4 Trevor, due ~11-27.

## Shipped / Failed / Auto-reverted

None. No production change this pass. Revert: n/a.
