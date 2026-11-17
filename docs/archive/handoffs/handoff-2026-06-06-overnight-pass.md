# Overnight autonomous pass — 2026-06-06 (handoff)

Run: `rpc-nightly-autonomous-pass`, **GENUINE OVERNIGHT** (fired 08:02 UTC = 01:02 PDT, inside 00:00–06:00) + **NO-PUSH MODE** (scheduled sandbox has no GitHub creds — `git push --dry-run` → "could not read Username"; `rip-packs-city-bot` clone still not mounted). DB migrations + artifact repairs applied live via connectors; all repo doc outputs (this handoff, ledger, metrics, CLAUDE.md entry, inbox archive) written to disk **uncommitted/unpushed**. Lock: prior `.lock` was a RELEASED marker from the 06-05 run (~19h old, stale) → taken over by runid=2468115993; re-released at end. No `FREEZE.md`, no `focus.md`. Declined list: empty.

Ship budget used: **1 of 4** production-affecting changes (1 DB migration) + 1 artifact repair (doesn't count against budget). First-verification-failure hard-stop: not triggered (the one shipped item passed).

---

## 1. What was reviewed

- `CLAUDE.md` in full; `docs/overnight/ledger.md` in full (Declined empty); `docs/handoff-2026-06-05-overnight-pass.md`; `docs/overnight/metrics-latest.json` (06-05 08:15Z baseline).
- **Inbox drained (3 files → `inbox/archive/`):** `2026-06-05T18-25-00Z.md` (P1 rpc-insights-health squeeze-count timeout — ACTIONED this run), `2026-06-05T21-06-00Z.md` (P1 refresh-cross-collection cron unwired — QUEUED CROSS1), `2026-06-06T03-16-00Z.md` (P1 pinnacle Cadence regression — DIAGNOSED + QUEUED P1-CAD; P2 AF1 view re-timeout — SHIPPED fix; P3 resolve-buyers dropout — QUEUED note; P4 smoke mass-fail — QUEUED fold with Q5/A6).
- Live state: `git log -30`, `pipeline_runs` 24h, `detect_stalled_pipelines()`, sentinel counters, security catalog SQL ×2, Sentry unresolved, Vercel last-20 deploys, FMV distributions, DB size.
- Collision gate: `origin/main` = `b6005cb` at run start and before the ship — no concurrent pushes all run. Local tree is 1 commit ahead (the monitor's `69a2cdf` inbox commit, itself unpushed — Q7 symptom).
- Artifacts: 16 enumerated. 2 known-broken from the inbox handled (`rpc-insights-health` repaired; `rpc-tracked-fmv-confidence` fixed underneath via the view migration — its embedded query was already correct). Others left alone (fresh-on-open; no schema drift affecting them tonight).

## 2. Post-ship regression watch (before any new shipping)

| Ship (last 24–48h) | Target metric | Result |
|---|---|---|
| **`b6005cb` Pinnacle serial backfill (CC, 01:23Z)** | next :22 tick ok=true + serials_filled>0 | **REGRESSED — 5/5 post-deploy ticks failed** (02:22→07:22Z, `cadence: Invalid character`, cat_ups=0, serials=0). Root-caused this run (§5 P1-CAD). **NOT auto-reverted: a code revert only takes effect via a deploy, and Vercel builds from GitHub `main` — impossible in NO-PUSH mode.** Escalated as the morning's #1 item. |
| **AF1 `v_tracked_wallet_fmv_confidence` (06-05 night)** | view query < statement_timeout | **REGRESSED again** (57014 ×3: monitor 03:06/03:15Z + my probe 08:09Z) under DUPE1 growth + wmc churn → **re-fixed this run** (§3, v3 EXISTS semi-join). |
| `a2cae0d` wmc image denorm | wmc.image_url fills | **GREEN — effectively complete: 1,545,416/1,585,383 (97.5%) imaged**; 03:00Z TS tick rows_imaged=49,655, image_error null. |
| `b072ce7` FMV-drift refresh | wmc.fmv_usd tracks snapshot moves | GREEN — wired into cron, AllDay tick rows_updated=4,997; no fails. |
| `d547c30` catalog front-load | new-set art lands next run | GREEN — no errors; WNBA sets draining. |
| MON-WATCH (offers-sweep + allday-fmv-populate @120m) + MON1 (fmv-recalc @120m) | no false positives; real stalls surface | GREEN — offers-sweep 69/24h 0 fails, allday-fmv-populate 67/0, fmv-recalc 85/0; none falsely in `detect_stalled_pipelines()`. |
| IDX-DROP (16 flowty indexes) | nothing breaks | GREEN — no errors referencing flowty tables. |
| PIN-CAT `373967d` | catalog_upserted > 0 | GREEN until 01:22Z (cat_ups 55/46/11/4/43 across the evening) — then the NEWER `b6005cb` broke the shared script (P1-CAD), halting PIN-CAT + Q5 serial queues together. |
| Rewards/SEO daytime cluster | no Sentry/regression | GREEN — only the 00:17Z transient smoke cluster (infra contention, §4). |

## 3. SHIPPED this run (with verification evidence)

### 3.1 Migration `audit_20260606_v_tracked_wallet_fmv_confidence_exists_semijoin` (DB, additive/reversible)

The 06-05 AF1 LATERAL rewrite was outgrown in <19h: the view's `held` CTE (DISTINCT over the full `wmc ⋈ editions` join) re-crossed the default statement timeout as DUPE1 added ~3.5k TS editions and the new image-denorm/FMV-drift crons churned wmc. EXPLAIN showed the planner walking ALL editions and fetching ~549k wmc rows before the tracked-wallet filter; the `held` CTE **alone** timed out.

**Fix:** held-set computed via `EXISTS` semi-join from `editions` into `wmc ⋈ seeded_wallets` — stops at the FIRST tracked holder per edition (tracked/seeded wallets are most of wmc, so probes terminate after ~1 row). Measured 1.65s for the semi-join; full view query now returns well under the timeout. LATERAL latest-snapshot probe unchanged. `security_invoker=on` restated in the CREATE; grants verified still exactly `postgres,service_role`. Internal view; 0 production-route readers; the `rpc-tracked-fmv-confidence` artifact's embedded query is unchanged and works again (no `update_artifact` needed).

**Independent subagent verification: PASS (4/4)** — (1) previously-timing-out `GROUP BY confidence` query completes, stable across 2 runs; (2) semantic exact-match: independent wmc-side computation of TS held editions = **8989** == view's `sum(held_editions)` for `nba_top_shot` = **8989**; (3) `security_invoker=on` + grants `postgres,service_role` only; (4) 0 RLS-off public tables.

**Revert** (restore the 06-05 AF1 body):
```sql
CREATE OR REPLACE VIEW public.v_tracked_wallet_fmv_confidence WITH (security_invoker = on) AS
WITH tracked AS (
  SELECT DISTINCT wallet_address FROM seeded_wallets WHERE is_active
), held AS (
  SELECT DISTINCT e.id AS edition_id, e.collection_id
  FROM wallet_moments_cache wmc
  JOIN tracked t ON t.wallet_address = wmc.wallet_address
  JOIN editions e ON e.external_id::text = wmc.edition_key AND e.collection_id = wmc.collection_id
)
SELECT c.slug AS collection, COALESCE(l.confidence::text, 'NO_SNAPSHOT') AS confidence, count(*)::integer AS held_editions
FROM held h
JOIN collections c ON c.id = h.collection_id
LEFT JOIN LATERAL (SELECT fs.confidence FROM fmv_snapshots fs WHERE fs.edition_id = h.edition_id ORDER BY fs.computed_at DESC LIMIT 1) l ON true
GROUP BY c.slug, COALESCE(l.confidence::text, 'NO_SNAPSHOT');
```

**Target metric (re-check tomorrow):** `SELECT confidence, count(*) FROM v_tracked_wallet_fmv_confidence GROUP BY 1;` completes without 57014; the artifact opens clean. If this view crosses the timeout a THIRD time, stop optimizing and treat it as DUPE1 fallout only fixable at the writer (Item B2) / via DUPE1-MIT.

### 3.2 Artifact repair: `rpc-insights-health` (update_artifact; no budget consumed)

Q_COUNTS ran an unbounded `count(*)` UNION-ALL across all 10 insights views in one statement; the `topshot_squeeze_board` leg (full per-row FMV LATERAL) crossed the timeout (57014) → the whole counts panel errored ("Some checks could not run"). Replaced every leg with a bounded probe `count(*) FROM (SELECT 1 FROM <view> LIMIT 501)`; rendering shows **"500+"** when capped; ok/empty liveness semantics unchanged (n>0). Verified pre-ship by running the exact new Q_COUNTS live: all 10 legs returned (squeeze=501→"500+", set_squeeze=129, pack_reality=2, rookies=61, market=500+, first_mint=500+, cross_collection=1, pinnacle_scarcity=254, offer_spread=500+, deals=342). None of these views has a top-level ORDER BY, so LIMIT genuinely stops early — the panel is now immune to further DUPE1/table growth. Foot-note + meta description updated to say counts are capped liveness probes.

**Revert:** `update_artifact` restoring the prior Q_COUNTS (unbounded `count(*)` legs) + `n.toLocaleString()` rendering (prior HTML is in git-tracked history of this handoff's description and the 06-05 inbox; or simply re-bound it again).

**Target metric:** artifact opens with the counts table rendered (no error string), squeeze row shows "500+ / ok".

### 3.3 NOT shipped on purpose

- `topshot_squeeze_board` view body NOT touched: the public `/insights/squeeze` page's bounded query is fast (39ms, monitor-verified); only unbounded counts were slow, and the lone unbounded reader (the artifact) is now bounded. Changing a public anon-readable view to fix a non-broken surface = unnecessary risk.
- No code commits/deploys (NO-PUSH).

## 4. Health-drift triage

- **Security: 0 / 0** — no RLS-off public base tables; no anon/authenticated write grants on RLS-off base tables (`relkind IN ('r','p')`).
- **`detect_stalled_pipelines()` = 1**: `snapshot-institutional-wallets` (N1) **re-stalled** — silent 1,846m vs 1,800m, last run 06-05 01:21Z. Same external-cron dropout class as before (it self-recovered twice prior). Operator: re-fire the cron-job.org entry; consider moving its 06:00Z slot off the rush (third occurrence — the slot move is now clearly warranted).
- **Sentinel TS-UUID-48h: 5,840 — CRITICAL (true positive, do NOT raise threshold).** DUPE1 trend: 2,611 (06-05 08:15Z) → 5,310 (03:16Z) → 5,840 (08:0xZ); new TS editions last hour = **27** (sharply decelerating vs ~450/hr at peak). TS editions 14,999. All inert (`set_id_onchain` NULL, trigger-held); TS HIGH+MED still improving → no pricing regression. **New attribution this run:** the NO_DATA snapshot stamps on inert editions come from `drain_fmv_cold_tail` (`algo_version='cold-tail-1.0'` — 5,351 rows/48h), plus 798 `1.7.0_haircut` LOW rows; this is the direct driver of fmv_snapshots bloat + the TS NO_DATA metric inflation + the view-timeout treadmill. Mitigation queued as **DUPE1-MIT** (§5).
- **Pipelines 24h:** `pinnacle-metadata-backfill` 5 fails = P1-CAD (ongoing, every :22 tick). Everything else 1–5 fails of known transient classes (pinnacle-nft-resolver 5/292 pool timeouts, wmc-fmv-populate 3/343 lock timeouts, hydrator 3/136 = N2 cron-rush class, topshot-fmv-populate 1 = the documented ~30% pool-timeout class). `fmv-recalc` 85/24h **0 fails**; `pinnacle-resolve-buyers` recovered (21/24h, 0 fails since 15:20Z Jun 5).
- **Sentry: 7 unresolved**, ALL = the 00:17:08Z smoke mass-fail cluster (NEXTJS-1E/14/12/W/E/A/4; 1 event each, release `46ec1fb`) — infra contention (statement-timeout + pool-timeout on the smoke's own RPC calls) during the 00:00Z cron rush + 6-deploy churn; live checks of the same assertions green this run. No recurrence in ~7h. Markable resolved after a quiet 24h (~00:17Z 06-07). Queued SMOKE-RETRY (§5) folds the monitor's P4 into Q5/A6.
- **Deploys: 19/20 READY, 1 ERROR** = `949e10f` (docs commit, 00:14Z) — superseded in 5min by `94ba491` READY; known Q7-class mount-corruption build blip. Current prod `b6005cb` READY (carrying P1-CAD).
- **Overnight deltas vs 06-05 08:15Z baseline:** TS HIGH+MED 2,944 → **3,041** (HIGH 571 + MED 2,470; improving); TS NO_DATA 2,010 → **5,444** (DUPE1 inert tail, documented); AllDay HIGH+MED 495 → **490** (flat); editions AllDay 6,191 / Golazos 581 / UFC 446 (flat); TS editions 11,498 → **14,999** (DUPE1); DB 5,978 → **6,257 MB** (+279); unmapped_sales open (resolved_at IS NULL) **162** (improved from 209-239); FMV writes fresh (08:28Z, minutes old); wmc imaged 97.5%.
- **View-timeout pattern sweep (the 18-25Z inbox's watch item):** besides squeeze-full-count and the now-fixed AF1 view, nothing else is near the edge — `topshot_offer_ask_spread` count 19ms, `topshot_first_mint_trophies` 288ms, others tiny. Treadmill currently contained at 2 surfaces, both handled tonight.
- Minor: `topshot_pack_reality_top_ev` rows 3 → 2 (honesty filter doing its job as pack data moves; not a break — view non-empty).

## 5. QUEUED (new this run)

### P1-CAD [HIGH — morning #1] `b6005cb` broke `pinnacle-metadata-backfill`: em-dash in the Cadence script × `btoa()` Latin1 limit — one-character fix

- **Symptom:** every tick on the new code fails `cadence: Invalid character` (5/5: 02:22→07:22Z; 06:22 was the known cron skip), `catalog_upserted=0`, `serials_filled=0`. Halts ALL queues sharing the script (PIN-CAT catalog create/repair, mint_count, disagreement, the new Q5 serials). No outage; Pinnacle FMV unaffected (separate tables/pipelines).
- **Root cause (confirmed by inspection):** `b6005cb` added a comment INSIDE `PINNACLE_METADATA_SCRIPT`: `// Per-NFT serial number. nil for open (non-limited) editions — those have …` — the `—` is the script's ONLY non-ASCII character (prior version: zero non-ASCII). The route encodes the script with `btoa(PINNACLE_METADATA_SCRIPT)` (route.ts ~L243); `btoa()` throws `InvalidCharacterError: Invalid character` on non-Latin1 input → surfaces as the pipeline error. This is the exact CLAUDE.md footgun ("use `Buffer.from(str,'utf8').toString('base64')`, NOT `btoa()` — breaks on Unicode"). The failure is at ENCODING time, before the chain is ever reached — which is why ticks fail in 2–10s with zero work done.
- **Fix (operator/CC, in `app/api/cron/pinnacle-metadata-backfill/route.ts`):** EITHER (a) replace the `—` with `-` in that one comment line (minimal), AND/OR (b) durable: change L243 `script: btoa(PINNACLE_METADATA_SCRIPT)` → `script: Buffer.from(PINNACLE_METADATA_SCRIPT, "utf8").toString("base64")` so a future non-ASCII comment can't re-break it (the two `btoa(JSON.stringify(...))` arg lines are ASCII-safe but may as well match). Alternative: `git revert b6005cb` (clean — additive feature, no paired migration).
- **Why not auto-fixed tonight:** NO-PUSH (a commit can't deploy), hot-file gate (real commit <24h), and route code. **Verify after deploy:** next :22 tick `ok=true`, `cat_ups>0`, and (first time ever) `serials_filled>0`.

### DUPE1-MIT [MED — ready-to-run, FMV-writer change so NOT auto-shipped] stop `drain_fmv_cold_tail` stamping NO_DATA on inert UUID editions

- **Evidence:** 5,351 `cold-tail-1.0` NO_DATA snapshot rows in 48h target inert TS editions (`external_id ~ '-'`, `set_id_onchain IS NULL`). This is DUPE1's main second-order cost: fmv_snapshots bloat, TS NO_DATA inflation (2,010→5,444), and the view-timeout treadmill. The inert rows are trigger-held and can never price — stamping them is pure waste.
- **Ready-to-run:** in `drain_fmv_cold_tail`'s `candidates` CTE, add to the WHERE: `AND NOT (e.external_id LIKE '%-%' AND e.set_id_onchain IS NULL)` (one line; same signature so grants persist — still re-verify per the migration skill). CAVEAT for the reviewer: the predicate also stops cold-tail restamps on the ~7k HISTORICAL UUID-keyed TS editions (pre-trigger era, have dependents) — arguably also desirable, but if only the re-mint wave is wanted, add `AND e.created_at >= '2026-06-04'`. Note: 798 `1.7.0_haircut` LOW rows/48h also land on inert editions (apply-fmv-haircut sweep) — same treatment may be worth folding in. Queued rather than shipped because it changes an FMV writer's behavior (off-limits class), not because it's hard.
- **Durable fix remains Item B2** (worker `seed_topshot_editions`/`buildEditionKey` int-pair preference). Re-run a canonical-merge dedup only after B2 lands.

### CROSS1 [LOW — operator] wire the `refresh-cross-collection` cron (from the 06-05T21:06Z inbox)

`/api/cron/refresh-cross-collection` still has **zero `pipeline_runs`** (confirmed this run). Operator: add a daily cron-job.org entry (`POST https://www.rippackscity.com/api/cron/refresh-cross-collection`, Bearer `INGEST_SECRET_TOKEN` or `?token=`), then retire the interim Cowork task. ONLY THEN (night-pass-eligible later): add a generous `pipeline_cadence_watchlist` row — adding it now would immediately false-positive (L1 lesson). Record in `docs/operations/cron-schedule.md`.

### P3-BUYERS [LOW — operator watch] `pinnacle-resolve-buyers` cron dropped ~7.3h of ticks (08:00→15:20Z Jun 5), second multi-hour dropout in a week

Recovered on its own; 21 runs/24h 0 fails now. Same flaky external-trigger class as Q3/N1. Operator: check/recreate the cron-job.org entry, or watch for a third occurrence.

### SMOKE-RETRY [LOW — operator/CC, folds the 06-06 inbox P4 into Q5/A6] smoke suite mass-fails under combined cron-rush + deploy churn

00:17:08Z run failed 7 checks on infra timeouts (its own `detect_stalled_pipelines()` RPC call timed out — not a real stall) and manufactured 2 NEW Sentry issues (NEXTJS-W/E). A6's single `rpcRetry` is insufficient under combined contention. Options: second retry w/ backoff, move the GHA smoke schedule off :00/:15 rush minutes, or warn-tier DB-backed assertions during detected contention bursts.

### Carried (unchanged): DUPE1 (trend updated in ledger), N1 (**re-stalled — operator re-fire, 3rd occurrence**), N2, N3, L1, PIN1, Q2, Q5, Q6, Q7 (push/bot-clone infra — confirmed again; also the monitor's local commit `69a2cdf` sits unpushed ahead of origin), Q8, F1/F2-TierB.

## 6. Failed / auto-reverted

- **None failed verification; nothing was auto-reverted.** The one regression that warranted an auto-revert (`b6005cb`, P1-CAD) cannot be reverted from this environment: a git revert only takes effect through a Vercel deploy from GitHub `main`, which NO-PUSH mode cannot produce. Per Section 2's escalation rule it is flagged as the morning's top item with a confirmed one-character fix and a clean revert path.

## 7. Continuity state written

Ledger upserted (AF1-v2 shipped entry, DUPE1 trend+attribution update, N1 re-flag, 5 new queued items); `docs/overnight/metrics-latest.json` overwritten with tonight's values; 3 inbox files archived to `docs/overnight/inbox/archive/`; CLAUDE.md Recent sessions entry prepended; `.lock` re-released. All on disk, uncommitted (NO-PUSH).
