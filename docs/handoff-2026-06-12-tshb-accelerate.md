# Claude Code handoff — 2026-06-12: accelerate the ASK_ONLY sales-history drain (tiny config change, big effect)

Context: Phase 2's mechanism is PROVEN end-to-end — 21 editions drained, 2,939 sales inserted, zero integrity trips, and fmv-recalc has already re-priced 7 of the 21 into honest sales-derived labels (2:147 -> HIGH $340.23; 2:37 -> MEDIUM $168.64; rest LOW with real values vs their old lone-ask stamps). The problem is pure throughput: GitHub throttles the 15-min cron to ~2-5 fires/DAY (verified: schedule events at 09:52Z and 14:11Z only on 06-11 against 96 scheduled), so 763 pending editions would take ~a month. The IO constraint that originally capped the pacing is GONE (0.85% fails through all of 06-11's wave windows; service_role 30s + the day's structural fixes hold).

THE CHANGE (one file, config-level): in app/api/cron/topshot-sales-history-backfill/route.ts raise the per-tick envelope so each rare GHA fire does a full meal:
- per-tick wall-clock budget: current ~50s -> ~480s (the GHA step already runs curl --max-time 600; route maxDuration permits up to 800 — keep <=600 to fit the curl);
- editions per tick: 15 -> 40;
- KEEP unchanged: the self-throttle (skip when pipeline_runs fails >15/30min), <=400-row batched inserts, idempotent txHash dedup, the int-pair/unmapped keying rules, every-exit logging.
Expected: ~30-40 editions per fire x even 3 fires/day ~= 100-120/day -> drain completes in ~5-7 days; with better GHA luck, 2-3 days. Optionally also fire 2-3 manual workflow_dispatch runs after deploying to take a big bite immediately (manual runs proved clean on 06-11).

Verify: next tick's pipeline_runs extra shows the bigger drain (editions_drained 25-40, budget_hit acceptable), fails stay baseline through the tick, sentinel TS-UUID-48h stays 0, fmv_sanity_flags stays 0.
Revert: git revert (config values only).
Then: when pending approaches 0, run the LT acceptance gate per docs/handoff-2026-06-11-askonly-phase2-greenlight.md (median |ratio-1| must beat 0.363; severe-highs must not grow) + 5 dapper.market spot-checks, and report the verdict with numbers.

Guardrails: direct-to-main, no branches/PRs; PowerShell git; exact-path staging; tsc clean; deploy READY + smoke green; the workflow file itself needs no change (PAT workflow-scope gotcha only applies if you touch .github/workflows/).
