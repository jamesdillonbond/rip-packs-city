# Focus — 2026-08-17 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## PRIORITIES — what tonight's pass should weigh

1. **Demand is the only gate that matters, and it is not being measured.** The site has been public since 07-17 and self-serve since 07-20; the last *confirmed* reading is **20 users / 0 WAU (2026-07-26)** and several passes since have not re-captured it. **If a pass captures metrics at all, capture the user/WAU count** — every other number in this repo is downstream of it. Roadmap gate is **50+ WAU**.
2. **Prefer DB/artifact work that does not need a push.** Cloud-sandbox passes have repeatedly been NO-PUSH. Work that lands as a migration or an artifact ships; work that needs a git push may not. (⚠ Push from Trevor's **local** box is fine — verified 2026-08-17 — so a NO-PUSH night is a *sandbox* limitation, not a repo one.)
3. **Do not open new investigations into disk-IO saturation symptoms.** The fmv-recalc kill rate, `public_board_slow_count`, the board-warm failures, the pg_cron statement-timeouts and the `get_collection_stats` timeout are **one root cause** (disk-IO budget on the SMALL 2 GB instance). The lever is cutting work — page size, precompute, fan-out — **never** raising a timeout and never upgrading the tier.

## STEER — added 2026-08-22 (a long interactive day; these change what the next pass should and should not do)

- 🚨 **`job startup timeout` now has a NAMED CAUSE — stop treating it as ambient.** `max_worker_processes = 6`
  against `cron.max_running_jobs = 32`; pg_cron cannot get a background worker, so the body never runs
  and **nothing reaches `pipeline_runs`**. 169 timeouts / 28 jobs in 24 h. Detail + the hour table:
  [cron-and-schedulers.md](../reference/cron-and-schedulers.md).
- ⛔ **BUT DO NOT extend that to the 01:00–19:00Z band.** Measured 08-22: pg_cron **run count is FLAT all
  day** (480–552/hr) while busy-seconds swing **10×**. The band is not caused by scheduling density —
  it is the same work taking longer (burst-credit depletion). **Staggering fixes an individual job and
  the startup-timeout class, NOT the band.** Anyone proposing "stagger the crons" as a band fix has
  mis-read this.
- ⛔ **Before planning ANY `cron.alter_job`, read `cron.job.username`.** 42 of 93 jobs are owned by
  `cron_heavy`, and **no session-reachable role can reschedule those** (`postgres` may EXECUTE but does
  not own; `cron_heavy` owns but may not EXECUTE; `postgres` cannot UPDATE `cron.job`). The ledger's
  08-22 success on jobids 83/84 was on `postgres`-owned jobs and does not generalise.
- ⚠ **`pinnacle-sync`'s cadence arm was DEACTIVATED and replaced by `pinnacle-fmv-recalc` @ 1560 min.**
  The old arm watched a best-effort log line whose write is swallowed by design; the work is fine. **Do
  not re-activate it** — and note the new arm is blind to "the 10:07Z HTTP caller stopped", which the
  22:37Z pg_cron backstop makes invisible to users anyway.
- ⚠ **`wallet-username-resolver`'s cadence arm is 450 min now (was 75).** Trevor cut the cron to every
  3 h on 08-18 and the arm was never re-pointed, so it fired on every tick. Its **failure rate is a
  separate, still-live problem** (84% via the pooler) — the cadence arm is structurally blind to it, so
  do not read a quiet cadence arm as a healthy resolver.
- 🚨 **OPEN, OPERATOR-ONLY, and none of it is fixable from a sandbox:** pg_cron **jobid 70** is the SOLE
  refresher of `mv_topshot_misattrib_candidates` and has failed 15 of 16 runs since 08-07 (the MV is
  stale since 08-16) — the one-line fix is blocked by the ownership split above. **atlas-proxy** still
  needs a `wrangler deploy`. **`topshot-moments-hydrator`'s cron is declared in NO repo file** and a
  `wrangler deploy` would delete it. And the **P0 stale branch `e4tib3`** still carries the pre-purge
  credential blob on a public repo.
- ✅ **Two new CI guards exist; do not duplicate them.** `check-memory-doc-links.mjs` (CLAUDE.md +
  `docs/reference/**` pointers) and `check-driver-message-leaks.mjs` (ungated handlers returning
  `err.message`). Both are ban-at-population-zero and both carry their own inspected-count assertions.

## STEER — do NOT re-flag these (current)

- **The three standing trust breaches are all known-class.** `panini_sale_price_capture_dry_days` (an arm that is **crying wolf** — it counts dry days on a field deliberately abandoned and replaced on 08-08, while the replacement works at ~22%; the fix is to RE-POINT the arm, not to chase the capture), `unmapped_resolution_backlog_max` (AllDay permanent floor — its own text says do NOT raise `breach_at`), `public_board_slow_count` (saturation collateral; **do not characterize its direction from fewer than several days** — it has been called both "climbing" and "oscillating down" on ~1-day windows and both were fair).
- **Sentry issues titled `smoke check could not run: …` are the honest-degradation path WORKING**, not security failures. Verify against the live invariant (`check_public_security_invariants()`, `check_anon_write_surface()`) before treating one as a breach.
- **`rpc-topshot-pack-opens-history` returning `done: true` ~96×/day is a DELIBERATE STANDBY.** It looks like a dead cron on every instrument. Do not unschedule it.
- **SERIAL-FMV-MULT-CRON — BY DESIGN.** `serial_fmv_multipliers` and `serial_fmv_power_model` refresh **weekly** via pg_cron. Staleness ≤7d is expected; do not re-queue as an escalating cron-silent item.

## ⚠ DO NOT ARCHIVE `docs/overnight/inbox/` FILES (measured 2026-08-17 — a queued action that would have broken things)

The `inbox/` convention says files are "archived to `inbox/archive/` after draining", and the 08-17 handoff had ~40 Aug 9–14 files queued to archive "once push is restored". **Do not run that.** Those files have become **permanent citation targets**: they are referenced by exact path from `CLAUDE.md` (4), `docs/overnight/ledger.md` (many), a dozen handoffs, the roadmap, `docs/sessions/2026-08.md`, **four committed `supabase/migrations/*.sql` files**, and **`lib/analytics/rpc-with-retry.ts:268`** (live product source). Moving them breaks every one of those, and migrations are immutable history that must not be edited to chase a path.

Evidence this has already bitten: `inbox/archive/2026-08-10T0515Z-…md` cites `inbox/2026-08-09T1941Z.md` — an already-archived file pointing at a still-live inbox path.

**The convention and the citation practice are in conflict, and the citations win.** Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`.

## STANDING (added 2026-06-22 — do NOT drop on the next focus rewrite) — pg_cron failure check

Every monitor + night-pass health sweep, also run `SELECT * FROM check_pgcron_recent_failures();` — this surfaces the pg_cron-internal failure class that `detect_stalled_pipelines()` CANNOT see (it watches `pipeline_runs`, not `cron.job_run_details`). Empty array = all pg_cron healthy. A listed job is a real finding **only if its `last_run` is AFTER the relevant same-day fix landed**; a failure timestamp that predates a fix is a STALE pre-fix run that clears on the job's next tick — do NOT alarm on it. A genuinely-recent pg_cron failure = HIGH-PRIORITY inbox candidate. (Also permanent in both task SKILL.md health-sweep sections; this note is belt-and-suspenders.)

## SENTINEL DECISION-QUEUE (2026-08-17 PT) — dispositions, so nobody re-derives these

The queue's own warning was that **re-derivation is this project's recurring cost**, and three of its five
items had already been measured elsewhere. Current state:

- ✅ **Item 5 (`pinnacle-nft-resolver`, ~900 null-edition rows) is CLOSED — it is the 08-15 catalog gap.**
  `pinnacle_sales.edition_id` FKs to `pinnacle_editions` (551 rows); the editions live only in
  `pinnacle_catalog` (2,561). Re-measured 08-18T0112Z: `distinct_editions=161 · in_editions=0 ·
  in_catalog=161`, up from 114 on 08-15 (**+41 % in three days**). Filed:
  `inbox/2026-08-18T0112Z-pinnacle-null-edition-pool-is-the-catalog-gap-…md`.
  ⛔ **Do NOT "park the unresolvable rows"** — they are not permanently unresolvable, and parking them
  hides a widening gap. ⚠ The resolver's `failed: 0` means it **never reaches** these rows (946 of 954
  have `resolution_attempts = 0`), not that it declines them gracefully.
- ⏸ **Item 1 (pack-EV `fmv_current` JOIN) — mechanism CONFIRMED, still correctly unshipped.** Fully
  measured already in `inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md`
  (~3,100× — 335 buffers vs 1,046,192). ⚠ **The queue framed this as one coordinated migration because
  "the function is pinned AND two of three are unmeasured". Those two facts are DECOUPLED — verified
  08-18 — and splitting them makes the expensive half shippable on its own:**

  | function | pinned? | measured? |
  |---|---|---|
  | `compute_pack_ev_per_edition_weighted` | **YES** — `supabase/tests/compute_pack_ev_per_edition_weighted.sql`, PINS entry at `__tests__/db-invariants-drift-guard.test.ts:170` | **YES** — jobid 71's callee, confirmed by the timeout CONTEXT; ~100 min/week of `cron_heavy` for zero rows |
  | `compute_pack_ev_from_pool` | no pin file | no |
  | `compute_pack_ev_from_pool_tier_weighted` | no pin file | no |

  So the **pinned one is the measured one**, and it is the one actually burning the budget. It can ship
  alone (migration + pin `.sql` + repoint the PINS migration name); the two unpinned ones need
  measurement but **no pin work**, and must not gate it. ⛔ Never `CREATE OR REPLACE VIEW fmv_current`
  (resets `security_invoker`); fix the CALLERS via a lateral accessor. Measure in a quiet window —
  during a saturation spell no timing is interpretable.
- 🔑 **Item 2 (`wallet-username-resolver`) is OPERATOR-ONLY — it is not pg_cron.** Caller enumerated
  08-18: absent from `vercel.json` (36 crons), pg_cron (94 jobs), GHA and in-repo fetches. It is
  **cron-job.org**, firing `POST /api/cron/resolve-wallet-usernames` 2×/hour. Trevor chose lever (a),
  cut the cadence → **every 3 h**. Sizing: 72.3 % of runs fail, and the failures still pay the full
  21-day `sales` scan before `wallet_usernames_unresolved`'s `statement_timeout=60s` kills them, for
  ~31 usernames/day. ⚠ Cadence only — **do not narrow the 21-day window** (breaks the 14-day retry).
- 🔍 **Item 3's lever is NOT the index alone.** The cost is in `aggregate_saved_wallet_stats`, whose
  `top_tier` **correlated subquery re-scans `wallet_moments_cache` once per `collection_id`**, and no
  index carries `tier` (confirmed: 14 indexes, none include it; `idx_wmc_cohort_cover` is now **464 MB**,
  not 458). Fold the subquery into the existing `GROUP BY` before considering a wider index — a fold
  costs no write amplification on a 98 %-non-HOT table.

⚠ **Measurement hygiene, learned the hard way 08-18:** the Supabase MCP 60 s cap abandons the RESULT, not
the query — a "timed out" EXPLAIN keeps running (seen at 86 s) and retrying it stacks copies onto the
saturation being measured. Take a positive control first (`count(*) FILTER (WHERE wait_event_type='IO')`
over `pg_stat_activity`); if most active sessions are in IO wait, **every duration that hour is
uninterpretable** — compare Buffers, never wall time.

## RETIRED STEERS — these were in this file and are now WRONG; do not re-add

- ⛔ **"TS on-chain unmapped spike — do NOT skip/retire this class."** `topshot-flowty-unmapped-drain` was **deliberately RETIRED 2026-08-16** (schedule removed from `vercel.json`, verified absent) because its queue reached **0 open** and proving emptiness cost a full backlog scan on ~73 ticks/day. The old steer now argues against a decision that was correctly made.
- ⛔ **"evm-transfers-ingest Base-429 — benign, don't chase."** That cron was **disabled 2026-08-02** as pure waste (`evm_nft_transfers` holds ZERO rows; absent from `vercel.json`, GHA and pg_cron). There is nothing left to not-chase.
- ⛔ **"`unmapped_resolution_backlog_max` self-clears <100 in ~1–2 days."** It did not. It is **291** and is now understood as an AllDay **permanent-class floor**, continuously replenished. Do not wait for it to clear and do not raise its threshold.
- **The whole 2026-06-24 studio-platform post-ship watch** (3 backfill routes, the watchlist follow-ups, the TS dead-media tail, the spork-proxy correction, the UFC studio resolver) — all shipped and long since folded into `CLAUDE.md` + the ledger. Kept out of this file to stop it decaying into an archive again.
