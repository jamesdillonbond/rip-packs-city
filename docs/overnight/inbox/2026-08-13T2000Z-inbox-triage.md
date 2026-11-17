# Inbox triage — 2026-08-13

> Produced by the Cowork cloud daytime pass, 2026-08-13 ~13:00 PT (20:00Z). All 28 un-drained
> inbox files read and cross-checked against `ledger.md`, `CLAUDE.md` and `git log`.
>
> ⚠ **NO-PUSH is specific to that cloud session** (git-proxy repo-set 403, upstream #76248).
> Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl` —
> **commit this file, and do the `git mv` below, as usual.**
>
> ⚠ **The archive list is the ONLY thing safe to move.** Everything else stays in the inbox on
> purpose. This repo has a recorded incident where an inbox item was called "fully drained" because
> one of its two fixes had shipped; every multi-item file below is accounted for item by item.
>
> ⚠ **The clone used was shallow (50 commits, back to 2026-08-12).** Pre-08-12 shas are cited from
> `ledger.md` and migration IDs rather than verified against git objects. A full-depth fetch would
> settle them.

Of the 28 un-drained files in `docs/overnight/inbox/`, **8 are CLOSED**, **3 are SUPERSEDED**, **16 are PARTIAL**, and **1 is OPEN** — 11 archivable, 17 must stay. The high PARTIAL count is not backlog sprawl: it is three shared blockers appearing in many files at once. (a) The **gate-key rotation** is operator-gated on Supabase secrets and is the sole residual in five files (`0300Z` runbook, `0330Z`, `1354Z`, `1530Z`, `1453Z`) — two already-written code fixes (`bd53bb3` pinnacle pack-EV dedupe, `033c0c1` allday-pack-opens tip logging) are committed but deliberately undeployed because they ride that window. (b) The **materialize-latest-FMV-per-edition** precompute is the single unshipped lever behind `1941Z` Fix 2, `1900Z` item 3, `0056Z`, and `2330Z`. (c) The **ipfs-media 502 / MV-refresh saturation** items are characterised but undecided. Every file whose own numbered items all landed is archivable; where a file's residual is genuinely carried by another file still in the inbox, that is stated in the reason rather than archived on that basis.

| filename | status | one-line reason | evidence |
|---|---|---|---|
| `2026-08-09T1941Z.md` | PARTIAL | Fix 1 (6 × `idx_sales_20xx_serial1`) shipped; **Fix 2 (materialized latest-FMV-per-edition) still open** — its own banner says keep it | ledger 2026-08-10 "Drains … **Fix 1**"; migration `20260810045029`; no ledger entry anywhere for a `fmv_latest` MV |
| `2026-08-10T0555Z-cron-budget-headroom-audit.md` | PARTIAL | Items 1–3 closed (item 3 formally declined); **item 4 jobid 235 `market-index-daily` and the jobid 261 re-probe untouched** | ledger 2026-08-10 "Drained items 2 and 3 … item 4 (jobid 235) untouched, as filed" |
| `2026-08-10T0612Z.md` | CLOSED | Its one candidate (Sentry `JAVASCRIPT-NEXTJS-25` cursor-stall smoke) was already filed and fixed a day earlier; the invariant was later re-verified intact | archived `inbox/archive/2026-08-09T1815Z.md` item 2; ledger 2026-08-09 `couldNotRun` ship; `6960281` |
| `2026-08-10T0620Z-headroom-audit-corrections.md` | CLOSED | All three corrections re-measured and accepted in-file (VERIFIED section); its "still open" list belongs to the parent `0555Z`, which stays | in-file VERIFIED 2026-08-09 23:55 PT; jobid 259 half closed by ledger 2026-08-13 "reconcile … 100s → 50s" |
| `2026-08-10T1700Z-board-liveness-rides-the-precompute-transaction.md` | CLOSED | Both numbered fixes shipped — #1 precompute per-leg split, #2 the ≤8h staleness→999 honesty guard, delivered by the probe decoupling; orphan state rows also done | migration `20260810230704` (split) + `20260810233442`/jobid 288; ledger: "reader returns `budget_exhausted=true` when the newest sweep is >8h old … that is the separately-queued cheap honesty guard, delivered free". Residual board slowness lives in `1900Z` |
| `2026-08-10T1900Z-board-liveness-probe-prunes-and-remaining-slow-boards.md` | PARTIAL | Item 1 shipped, item 4 shipped, item 5 done; **item 2's durable half (precompute) and item 3 (`allday_scarcity_board` → materialize-latest-FMV) open** | shipped: `20260810233442`, `20260810230704`, `adf42963`. Item 2 interim only: `idx_sales_2026_ts_otherserial_cover`, ledger "Not a full fix — the durable path is precompute" |
| `2026-08-10T1930Z-which-boards-the-probe-under-measures.md` | CLOSED | Its own item shipped with three corrections recorded; the residual "queue it as precompute" recommendation is carried by `2026-08-12T0056Z`, which stays | migration `audit_20260810_board_liveness_honest_sweep_decoupled` + jobid 288; ledger 2026-08-10 first honest sweep 202.1s, slow_count 5→13 |
| `2026-08-10T2100Z-candy-treasury-argmax-and-wmc-scatter.md` | CLOSED | Candidate 1 closed by the divergence cross-check; Candidate 2 was filed as declined-and-recorded | migration `audit_20260811_edge_fn_http_error_arm_and_candy_treasury_crosscheck`; successor `2026-08-11T0200Z` |
| `2026-08-10T2107Z-daytime-monitor.md` | PARTIAL | C1 `pinnacle-sync` self-resolved (absent from later sweeps, operator note only); **C2 `rpc-refresh-allday-pack-realized` 3/4 fail remains in the un-actioned MV-refresh cluster** | C1: `2026-08-12T0012Z`/`0309Z` stall lists no longer name it. C2: re-reported unchanged in `0012Z` Candidate 2; no ledger fix |
| `2026-08-11T0200Z-candy-treasury-corroborated.md` | CLOSED | Carries its own `✅ CLOSED 2026-08-11` banner; recs 1–3 actioned, one figure corrected (76.8ms → 2,854ms) | in-file banner; `check_candy_treasury_divergence()` shipped, board stays 38 arms |
| `2026-08-11T0300Z-gate-key-rotation-runbook.md` | PARTIAL | Dual-accept code shipped and the runbook's ordering adopted/corrected; **the rotation itself (8 secrets → deploy → repoint cron) is still owed** | ledger 2026-08-11 "dual-accept gate keys …" (`e66884f7`, regression closed `e30bc73d`); "STILL OWED (operator, unchanged)" |
| `2026-08-11T0319Z-daytime-monitor.md` | CLOSED | All three candidates dispositioned in-file: C1 grant chain verified complete + 06:58Z tick succeeded, C2 folds into the standing D3b item with no new work, C3 known cluster confirmed self-recovering | in-file ✅ 03:45Z verification; jobid 287 06:58Z 233.3s. The later 12:58Z failure is a separate filing (`1746Z`) |
| `2026-08-11T0610Z-daytime-monitor.md` | SUPERSEDED | Its only candidate (spork-routed pack-opens stall) was a misdiagnosis; the cause was a 403 auth outage | `2026-08-12T0330Z-edge-fn-403-outage-RESOLVED.md`, which names this file explicitly |
| `2026-08-11T1512Z-daytime-monitor.md` | CLOSED | C1's prescribed fix was refuted in-file (every per-leg budget already <600s; not a live defect, nothing changed); its other entries are dispositioned non-findings superseded by `0330Z` | in-file ⛔ CORRECTION; jobid 287 18:58Z 494.7s + 00:58Z 73.6s both succeeded. Real residual mechanism → `1746Z` |
| `2026-08-11T1746Z-precompute-split-silent-stale-under-role-timeout.md` | OPEN | Nothing actioned: `cron_heavy`'s cumulative 600s cap can still kill a leg outside its `EXCEPTION→999`, leaving a silently-stale arm; still recurring | CLAUDE.md 08-11: "Not a live defect right now, so nothing was changed"; `2026-08-13T1453Z` reports the 12:58Z tick failing again |
| `2026-08-11T1809Z-daytime-monitor.md` | SUPERSEDED | Its single candidate was "characterize ipfs-media 5xx"; two later filings did so with better data | `2026-08-12T0309Z.md` (33 distinct CIDs, per-request gateway flakiness), also `2026-08-12T0012Z.md` |
| `2026-08-11T2112Z.md` | SUPERSEDED | Its single HIGH candidate (`allday-pack-opens-forward` silent while pg_cron reports success) was the same 403 outage | `2026-08-12T0330Z-edge-fn-403-outage-RESOLVED.md`, which names this file explicitly |
| `2026-08-12T0012Z.md` | PARTIAL | C1 ipfs superseded by `0309Z`; **C2 `rpc-refresh-allday-pack-realized` and C3 TopShot mega-wallet `getIDs` computation-limit both un-actioned** | C3: no ledger entry and no commit for sharded-`getIDs` pagination (searched `git log --grep`, `ledger.md`) |
| `2026-08-12T0056Z-first-mint-trophy-stats-index-vs-precompute.md` | PARTIAL | The §3 covering index shipped as the interim win; **the durable fix (precompute the trophy-stats aggregate) is explicitly not the end state and is unshipped** | in-file banner + ledger 2026-08-11: 17,308ms → 2,047ms, "Not a full fix — the durable path is precompute" |
| `2026-08-12T0309Z.md` | PARTIAL | The assigned characterization is complete and closes the 08-11 night-pass queue item; **the disposition it offers (multi-gateway fallback + negative cache, or formally accept as upstream noise) has not been made** | no ipfs gateway-fallback code in `app/api/public/ipfs-media/`; no ledger entry since the 08-11 queue line |
| `2026-08-12T0330Z-edge-fn-403-outage-RESOLVED.md` | PARTIAL | RESOLVED banner is accurate for the outage (7 jobs repointed + new 4xx detector), but its own **"⚠ STILL OWED (operator)" rotation is unfixed and has since regressed on jobid 15/16** | shipped: `audit_20260811_edge_fn_http_error_arm_…`. Regression evidence: `2026-08-13T1530Z`, ledger 2026-08-13 §A |
| `2026-08-12T0358Z-stale-label-lost-in-wmc-denorm.md` | PARTIAL | Trevor chose "A then C". **A shipped** (`wmc.fmv_confidence` + writer + chunked backfill + jobid 302); **C (surface disclosure) still owed**, Pinnacle rows uncovered, backfill ~9 days from done | ledger 2026-08-11 option-A entry: migrations `20260812041945`/`042019`/`042528`; same entry: "**Still owed: part C (surface disclosure)**" |
| `2026-08-12T0428Z-allday-graphql-403-waf-block.md` | PARTIAL | Diagnosis answered against worker source on 08-13 (`ALLDAY_PROXY_URL` → `/allday-consumer`); **the env write + probe re-run are operator-gated and undone**, and the `last_updated_at` corroboration is still untraced | ledger 2026-08-13 §B (commit `c92a30a`); in-file "⚠ Still operator-gated" |
| `2026-08-12T0430Z-suppression-predicate-and-secret-echo.md` | PARTIAL | §1 hazard and §2 import-map both actioned; §3 shipped at the correct layer (`detect_stalled_pipelines()` now returns `notes`); **the stronger machine-evaluated `silence_is_real`/`suppress_while` boolean is deferred to Trevor, not declined** | migration `20260812050544_audit_20260812_detect_stalled_pipelines_carry_watchlist_notes`; ledger line 629; in-file "Still open (deliberately not taken)" |
| `2026-08-12T1354Z-jobid16-403s-and-a-newly-critical-arm.md` | PARTIAL | Option 2 formally retracted and ledgered; **option 1 (complete the rotation) is operator-gated and open, and option 3 (degrade the permanently-red critical arm to warn with an expiry) is undecided** | retraction: `b572417` + ledger 2026-08-12 "CORRECTED my own filing". Arm still firing per `2026-08-13T1530Z` |
| `2026-08-12T2330Z-board-view-timeouts-now-named.md` | PARTIAL | The instrumentation and the estate-wide blind-instrument sweep are done and recorded (negative result); **the lever it names — shared materialize-latest-FMV — is unshipped and the boards still fail to warm** | shipped: `d6a71b2`, `673d243`, `9f96d12`. `2026-08-13T1453Z` still lists `refresh-insights-cache` deals+rookies failing |
| `2026-08-13T1453Z-daytime-monitor.md` | PARTIAL | Candidate 1's **code fix shipped** (`compute-pinnacle-pack-ev` batch dedupe) but the **edge deploy is withheld**, coupled to the gate-key rotation; Pinnacle pack-EV stays frozen at 08-11 06:17Z | `bd53bb3` + ledger 2026-08-13 "CODE ONLY, DEPLOY DELIBERATELY WITHHELD"; `PINNACLE_PACK_EV_GATE_KEY` unset |
| `2026-08-13T1530Z-pg-net-403-attributed-to-jobid-16.md` | PARTIAL | Attribution + duplication correction ledgered and the jobid-55 tip fix committed (undeployed); **the jobid 16/15 secret realignment is operator-gated and jobid 55's ~92% tick loss has no established cause** | `b4b5b1b`, `9feb4ff`, `033c0c1`; ledger 2026-08-13 §A "Operator-gated (secrets); nothing changed here" |

## Archivable now

```
git mv docs/overnight/inbox/2026-08-10T0612Z.md \
       docs/overnight/inbox/2026-08-10T0620Z-headroom-audit-corrections.md \
       docs/overnight/inbox/2026-08-10T1700Z-board-liveness-rides-the-precompute-transaction.md \
       docs/overnight/inbox/2026-08-10T1930Z-which-boards-the-probe-under-measures.md \
       docs/overnight/inbox/2026-08-10T2100Z-candy-treasury-argmax-and-wmc-scatter.md \
       docs/overnight/inbox/2026-08-11T0200Z-candy-treasury-corroborated.md \
       docs/overnight/inbox/2026-08-11T0319Z-daytime-monitor.md \
       docs/overnight/inbox/2026-08-11T0610Z-daytime-monitor.md \
       docs/overnight/inbox/2026-08-11T1512Z-daytime-monitor.md \
       docs/overnight/inbox/2026-08-11T1809Z-daytime-monitor.md \
       docs/overnight/inbox/2026-08-11T2112Z.md \
       docs/overnight/inbox/archive/
```

## Still open — what each one is waiting on

**Operator-gated (credential / deploy / console action)**

- **The gate-key rotation — the single largest blocker, appearing in five files.** Set the 8 `*_GATE_KEY` secrets (+ the `*_GATE_KEY_OLD` transitional pair), deploy the 8 env-var edge functions with `--no-verify-jwt`, then repoint the 9 pg_cron `?key=` values. The dual-accept code already shipped, so partial states are now safe. Blocks: `0300Z` runbook · `0330Z` "STILL OWED" · `1354Z` option 1 · `1530Z` jobid 15/16 realignment (a *regression* — D2b records these as done) · `1453Z`/`bd53bb3` pinnacle pack-EV deploy · `033c0c1` allday-pack-opens deploy.
- **`ALLDAY_PROXY_URL` → the worker's `/allday-consumer` route** (`0428Z`). Vercel env write + a v13 deployments POST (an empty/docs-only commit will not rebake it) + re-run `POST /api/admin/discover-moment-descriptors` with `RPC_ADMIN_TOKEN`; pass condition is the AllDay arm going `conclusive: true`. Until then AllDay `editions.description` cannot populate.
- **`check_edge_fn_http_failures()` is permanently CRITICAL** while jobid 16 403s (`1354Z` option 3). Either fix the secret or time-box a `warn` downgrade with an explicit expiry — this is the `ufc_fmv_stale_hours` failure mode on an arm built six days ago to catch the next D2.
- **Pinnacle pack-EV data is frozen at 2026-08-11 06:17Z** (`1453Z`) and the `gql_historical` pack-pool leg is stale ~40h (`1530Z`) — both resolve with the rotation, nothing else.

**Engineering-gated (code or migration)**

- **Materialize latest-FMV-per-edition** — one MV closes four filings at once: `1941Z` Fix 2, `1900Z` item 3 (`allday_scarcity_board` ~183% of budget), `0056Z` (`topshot_first_mint_trophy_stats` durable fix), `2330Z` (`cross_collection_deals_board` + `/api/market`). ⚠ Per `0555Z`/`0620Z` it must be **incremental keyed on ingest time plus a periodic full sweep** — backfills mutate the past in this DB, so a `sold_at`-keyed design would fabricate history.
- **Precompute cumulative-timeout gap** (`1746Z`, the only fully-OPEN file). `cron_heavy`'s role-level `statement_timeout=600s` bounds the whole `CALL`, so a kill lands outside a leg's `EXCEPTION→999` and leaves a silently-stale arm. Fix direction: lift the cumulative cap inside the orchestrator (or split the two expensive tail legs into a second pg_cron job). Do **not** raise the role timeout. Still recurring on the 12:58Z tick as of 08-13.
- **jobid 235 `rpc-refresh-market-index-daily`** (`0555Z` item 4) — the worst remaining MV refresh, p90 509s against 600s. Design item, same ingest-time-incremental constraint; needs the pricing/board owner.
- **jobid 261 `rpc-refresh-unmapped-backlog-growth` re-probe** (`0555Z`/`0620Z`) — the alert path, effective budget 120s, n=2 post-revert. Re-measure over 24h of hourly ticks before sizing anything; do not splice its inert declared 90s.
- **`rpc-refresh-allday-pack-realized`** (`2107Z` C2, `0012Z` C2) — 3/4 ticks failing on MV-refresh statement timeout. Cut refresh weight or move it off the `:35` pileup; explicitly **do not** bump the timeout.
- **TopShot mega-wallet `getIDs()` computation limit** (`0012Z` C3) — wallet `0xe1f2a091f7bb5245` needs the paginated/sharded read the AllDay path already has. Niche, one wallet, unfiled elsewhere — **this is the item most at risk of being lost.**
- **ipfs-media 502 resilience** (`0309Z`) — multi-gateway fallback + short negative cache, or a formal "accepted upstream noise" decision. Either is fine; leaving it undecided is what keeps the file open.
- **wmc STALE/ASK_ONLY part C** (`0358Z`) — surface disclosure across the 9 portfolio-summing RPCs that still never mention confidence (Golazos is 99.3% STALE-or-ASK_ONLY by displayed value); plus Pinnacle's own writer, which `populate_wmc_fmv_from_snapshots` structurally cannot reach.
- **Machine-evaluated suppression predicate** (`0430Z`) — `notes` now travels with the alert, which captures most of the value; the `silence_is_real` boolean / SQL `suppress_while` is a schema change needing a per-row judgement across 40+ watchlist rows. Trevor's call, explicitly deferred rather than declined.

## Anything I could not determine

- **`jobid 55` `rpc-allday-pack-opens-backfill` ~92% tick loss** (`1530Z` addendum) is genuinely unexplained. Three lanes are closed with evidence (dispatch fine, not a 403, not the pg_net minute slot), and the `tip_unreachable` fix is explicitly *not* claimed as the cause. What would settle it: deploy `033c0c1` in the rotation window and see whether `tip_unreachable` rows appear; if not, instrument the `mode=backfill` body.
- **Whether `editions.last_updated_at` is ever written by the AllDay hydrate path** (`0428Z`). Both the original filing and the 08-13 answer refuse to upgrade "NULL on all 6,190 rows" from corroboration to proof. Settled by reading the AllDay upsert path for that column — a code read, not a measurement.
- **Whether the `1746Z` cumulative-cap kill has actually produced a silently-stale arm in production**, versus remaining theoretical. The 12:58Z tick keeps failing, but nobody has checked which leg was mid-flight or whether its arm sat stale across consecutive ticks. Settled by `SELECT metric, computed_at FROM rpc_trust_health_precompute ORDER BY computed_at` immediately after a failed 12:58Z tick.
- **Whether `panini_squeeze_board: query failed` is a timeout or a different fault** (`2330Z`) — reported distinctly on purpose, message is not a timeout string, and it was never followed up.
- **Pre-2026-08-12 commit shas could not be verified locally** — the clone is shallow (50 commits). `e66884f7` (dual-accept), `e30bc73d` (its regression fix), `6bd15560` (`wmc.fmv_confidence`) and `adf42963` (orphan-row delete) are cited from `ledger.md` and migration IDs, which are internally consistent and corroborated by CLAUDE.md, but were not confirmed against git objects. A full-depth fetch would settle it.
- **`jobid 54` (Sundays) post-fix confirmation** from `0620Z`'s "still open" list — no record that it was checked. Low stakes; one `cron.job_run_details` query settles it.
