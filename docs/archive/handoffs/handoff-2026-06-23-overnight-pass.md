# Overnight pass handoff — 2026-06-23

**Mode:** GENUINE OVERNIGHT (scheduled 01:02 PDT) — but see the clock-skew note. **Push available.** Sandbox-native clone `$HOME/rpc` (the `/tmp` uid-squash hazard recurred at run start, so clone + scratch use `$HOME` / the outputs mount). `origin/main` `d6e17c5` unchanged start→end (re-fetched before the ship gate; no concurrent human push).

Shipped **1** (a Cowork artifact repair, subagent-verified PASS) + 1 idempotent maintenance refresh (thin-fmv-guard). Reverted 0. Auto-reverted 0. No production code/DB-migration ships (none were SHIP-eligible — the only standing candidate was the artifact repair). Post-ship watch on the heavy 06-22/06-23 daytime wave: **ALL PASS, 0 regressions.** Health GREEN.

## CLOCK SKEW — read first
The sandbox shell `date` reported **08:02 UTC** at run start, but the production DB `now()` is **13:33 UTC** — a ~5.5h skew (the VM clock booted ~5.5h behind real time). The DB clock is authoritative (proven by the `30 13 * * *` pg_cron job firing at 13:30:00). So real wall-clock at run start was **~13:33 UTC = ~06:33 PDT**, i.e. ~33 min PAST the 00:00–06:00 quiet-hours window. Treated as a borderline-late genuine-overnight fire: did the full health triage + post-ship watch, shipped only the reversible non-production artifact repair (explicitly low-risk, monitor-requested 5x, non-git/non-deploy) and an idempotent maintenance refresh; shipped NO production code or risky migrations. All timestamps below in DB/real UTC.

## Shipped
### CAND-1 — rpc-live-health artifact: leak-panel predicate fix (artifact repair, not a code/DB ship)
The `rpc-live-health` Cowork dashboard's Open-Issues "edition writer leak" panel computed `leak_24h`/`leak_48h` with `external_id !~ '^[0-9]+:[0-9]+$'`, which counts the benign `::subID` parallel editions (cataloged in the 2026-06-20->22 subedition work) as a UUID-writer leak — reading ~385-1,775 (WARN band) when the real hyphen-UUID leak is ~2. The authoritative sentinel (the `%-%` hyphen form) was already correct; only this dashboard panel carried the stale predicate. Flagged by the daytime monitor across 5 consecutive ticks (15:17Z->06:06Z) as the one standing artifact-repair candidate.

- **Change:** both predicates -> `external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'` (the canonical-edition predicate the `rpc-data` skill already uses). Only those 2 SQL lines changed; the rest of the 601-line dashboard is byte-identical (the OneDrive artifact can be Read but not Edit/bash-written, so the fix was done via the proper `update_artifact` full-file install from a verified scratch reproduction).
- **Functional proof (live SQL):** the NEW predicate returns `leak_24h=0`, `leak_48h=2` (matches the authoritative sentinel hyphen-UUID-48h = 2/250); the OLD buggy predicate returns 385/48h (inflated by `::` parallels in the window).
- **Reproduction integrity verified:** scratch file char-count 40283, all structural markers intact (4 `<script`/4 `</script>`, 10 MATERIALIZED CTEs, 9 render fns, `loadAll();`, JSON meta parses as "Rpc Live Health"), OLD form count 0 / NEW form count 2.
- **Independent fresh-subagent verification:** read the LIVE installed artifact (`C:\Users\TDill\OneDrive\Documents\Claude\Artifacts\rpc-live-health\index.html`) -> VERDICT PASS (both corrected predicates present at 355/356, old form 0x, balanced script tags, meta block intact, not truncated).
- **Revert:** `update_artifact` the two predicates back to `^[0-9]+:[0-9]+$` (or restore the pre-edit content; the only delta is those 2 lines).
- **Target metric (next monitor tick):** rpc-live-health `leak_48h` reports ~2 (good band), not ~385/1,775.

### thin-fmv-guard — manual idempotent refresh (maintenance, not a logic change)
`rpc-refresh-thin-fmv-guard` (daily `30 13 * * *`) FAILED its 13:30Z tick today (120s statement-timeout on the `topshot_thin_fmv_editions` INSERT) — but it ran **6.5s yesterday** and the query runs **3.9s right now** with a healthy fully-index-driven plan, so today's failure was **transient contention** (the same 13:30Z window also timed out `compute-topshot-pack-ev`'s `targets` query at 13:31Z — a 1-minute contention micro-cluster). Not a reproducible regression -> no fix shipped. Ran the existing `refresh_topshot_thin_fmv_editions()` once (0.37s warm, 101 flagged) to clear the ~1-day staleness and confirm function health. **Watch:** if the 06-24 13:30Z tick fails again, escalate to a planner/timeout fix (the special-serial-MV class).

## Post-ship regression watch (06-22/06-23 daytime wave) — ALL PASS, 0 reverts
- **Item 5 — All Day + Pinnacle ASK_ONLY parity (`9056eff`, current prod, + migration).** AllDay ASK_ONLY **65->665** (+600), NO_DATA **2269->1667** (-602), HIGH+MED 891->**904** unaffected/improving — EXACTLY the predicted Step-5d floor-ask reshuffle (NOT a regression). Reconciles exactly to 6,191 AllDay editions. Pinnacle: ASK_ONLY **640**, priced-NO_DATA contradiction **684->0** (gone). TS HIGH+MED 4328->**4366** improving; sum 17,316 vs 17,318 (gap 2 = fresh `::` parallels, benign).
- **Item 1 — legacy-TS image recovery (`35fc464` + migration).** `rep_nft_id` confirmed present in entity-grid RPCs (`get_set_editions`, `get_player_editions`). Tiles can recover via `media/<nft_id>/image`.
- **Item 6 — Pinnacle STALE-not-NO_DATA + Item 7 special-serial usernames (`35fc464` + migration).** Migrations landed; Pinnacle FMV breakdown healthy (HIGH+MED 799). Username resolution is read-layer (no MV column, expected).
- **75ee62f CC-queue drain.** UFC editions stable at **518** (+72 seed held, no further drift); orphaned 3-arg `get_user_top_owned_moments` dropped (one overload remains); `softIfTransientRpc` smoke hardening confirmed — Sentry NEXTJS-A is gone from the unresolved set.
- **Last night's `audit_20260622_refresh_special_serial_owners_mv_force_hashjoin`.** CONFIRMED durably resolved: 06-22 04:13Z FAILED (120s pre-fix) -> 16:13Z succeeded (4.4s) -> 06-23 04:13Z succeeded (4.6s). Two consecutive cron successes at ~4.5s. Ship target met.
- **dbdbd0dd Flowty user-facing teardown.** Current-prod-superseded but surfaces stay clean (0 new Sentry cluster).

## Health-drift triage — GREEN
- **Security 0/0/0/0:** RLS-off base tables [] ; anon/auth write-on-RLS-off base (relkind r/p) [] ; `check_public_security_invariants()` [] ; `check_secdef_anon_execute_violations()` [].
- **`detect_stalled_pipelines()` []** / **`get_pipeline_alerts()` []**.
- **`check_pgcron_recent_failures()`:** 1 — `rpc-refresh-thin-fmv-guard` (today's 13:30Z transient, addressed above; the fn reads cron.job_run_details so it will keep reporting the failed latest cron run until tomorrow's tick — the manual refresh doesn't write a cron row).
- **trust-health 9/9 ok:** edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap $0/50, pack_ev_board_stale 1.44d/2, pack_ev_depleted 0/30, pinnacle_ask 0.1h/3, pinnacle_fmv 3.4h/30, ts_uuid_dupes_24h 0/200, unmapped_resolution_backlog 24/100.
- **pipeline_runs 24h fails:** evm-transfers-ingest x4 (Base-429, known-benign); compute-topshot-pack-ev x1 (13:31Z, the same transient contention window as thin-fmv-guard). Both self-recovering.
- **sentinel hyphen-UUID-48h:** 2/250.
- **editions FLAT:** TS 17,318 / AllDay 6,191 / Golazos 581 / UFC 518 (no writer leak).
- **conflation_guard:** 44 (17->31->44 over 24h = benign accrual; ts_uuid_dupes 0, editions flat; `rpc-remap-misattributed-sales` every-6h converger last succeeded 12:23Z 30.5s).
- **DB:** 5167 MB (+77 over ~1.5d vs 5090 baseline, benign).
- **Sentry:** 1 unresolved — NEXTJS-1Q (router-state-header parse, 1 event/1 user, 17h ago, deploy-swap RSC transient, not recurring; 17h quiet < 24h-precedent threshold, left armed).
- **Vercel:** prod `9056eff8` READY, 0 ERROR across 20 recent (CANCELED entries are docs-only/superseded, normal).

## Closed / resolved this cycle (by daytime CC — recorded, verified where cheap)
- **UFC-EDITIONS-SEED-GAP** — `75ee62f` / `audit_20260622_seed_missing_ufc_editions_from_wmc` seeded 72 -> UFC 518 (verified stable).
- **get_user_top_owned_moments 3-arg orphan** — dropped (`75ee62f`; one overload remains).
- **BADGE-CATALOG-CRONJOB-DUP** — duplicate cron-job.org entry deleted (`9d441ce`).
- **N1 snapshot-institutional-wallets** — verified healthy by daytime (`9d441ce`), off the 06:00Z rush; `detect_stalled` [].
- **REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT** — durably resolved (2 consecutive cron successes; post-ship watch above).

## Queued / carried (unchanged — off-limits / CC / operator)
refresh-conflated-editions cron (operator; remap converges via pg_cron every 6h), BUYERBF-PERINVOCATION-WORK (CC), ALLDAY-V1-UNMAPPED-DRIFT (operator/CC; 24/100, trust-green), TS-WMC-UUID-FOSSILS (CC, 1,683 accepted residual), VERCEL cost family (Trevor), A1-WORKER-PASSTHROUGH-CLEANUP (Trevor/wrangler), PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS x2. New watch: THIN-FMV-GUARD-CONTENTION (if 06-24 13:30Z tick fails again, planner/timeout fix).

## Output state
Handoff + ledger + metrics-latest.json + inbox archive committed & pushed to `main` from `$HOME/rpc`. Lock released on the mount.
