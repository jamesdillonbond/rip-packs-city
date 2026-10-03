# Focus — 2026-08-17, steers appended through 2026-09-05 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## STEER — added 2026-10-03 ~6:30 AM PT (Claude Code cloud; replaces the spent 09-18 → 09-20 steers, rolled verbatim to the archive)

No live steer is owed by a clock. What a night pass needs to know that the ledger top does not say in one line:

- **pack-mint-probes `failure_rate` (medium) is EXPECTED to stay lit** while the backward walk is on the mainnet24 historical node (heights ≤ 85,981,134). #166 (`20261003045659`) gives node faults 12 attempts; `failed` should hold at the by-design "window missed" rows. **Re-open trigger:** probes with `status='failed' AND attempts >= 12` growing. Do not lengthen the request timeout — measured harmful 10-02.
- **Scratch Flowty-export jobs (`scratch-20261002-*`, jobids 673/674/676) are Trevor's in-flight export** — they drive HIGH `pg_net_http_400/429` arms. Not a regression; leave them running; cleanup SQL is in the 10-02/10-03 SCRATCH ledger entries.
- **DONE 2026-10-03 (do not re-queue):** #163 routes deleted; DEP0169 silenced (`node-fetch` in `serverExternalPackages` — a DEP0169 group RETURNING means that entry was dropped or the SDK changed transport); `atlas-editions` stalled-set HIGH fixed at the retry order (`20261003151308` — **re-open** if > 0 stalled sets on two ticks ≥ 1 h apart); Golazos `badge_editions.low_ask` has ONE writer (the on-chain reconciler) — the Flowty compound-key write is gone from `golazos-listing-cache`. **Flowty independence needs no build** (FMV ask leg reads no Flowty data); only teardown remains, on the day Flowty goes dark. Also DONE 10-03: **#164 verified live** (concierge watchlist + single-edition alerts write, show on `/alerts`, remove; `fmv_alerts`/`watchlist` are back at 0 because the test rows were removed, so 0 is NOT a regression); `/alerts` makes no channel claim until its read succeeds; `public.scratch_flip_probe` RLS on (scratch tables belong in `flowty_archive`).
- **`sync-nba-projections` alert mute now expires 2026-10-28** (moved from 10-14, #8): the arm returning then is the season re-look, not a regression.
- **Fast Break has NO active run (decided 2026-10-03):** `fast_break_runs.is_active` is false on both finished playoff runs, so every surface shows its designed off-season state. When Top Shot announces the 2026-27 run, insert it with `is_active = true`.

## ⏬ Older steers rolled to [focus-archive-2026-H2.md](focus-archive-2026-H2.md): 2026-09-14 and earlier on 2026-09-24; 2026-09-18 → 2026-09-20 on 2026-10-03. The persistent sections below (do-not-re-flag, inbox append-only, STANDING, sentinel queue, DECIDED, RETIRED STEERS) were kept.

## STEER — do NOT re-flag these (current)

- **The three standing trust breaches are all known-class.** `panini_sale_price_capture_dry_days` (an arm that is **crying wolf** — it counts dry days on a field deliberately abandoned and replaced on 08-08, while the replacement works at ~22%; the fix is to RE-POINT the arm, not to chase the capture), `unmapped_resolution_backlog_max` (AllDay permanent floor — its own text says do NOT raise `breach_at`), `public_board_slow_count` (saturation collateral; **do not characterize its direction from fewer than several days** — it has been called both "climbing" and "oscillating down" on ~1-day windows and both were fair).
- **Sentry issues titled `smoke check could not run: …` are the honest-degradation path WORKING**, not security failures. Verify against the live invariant (`check_public_security_invariants()`, `check_anon_write_surface()`) before treating one as a breach.
- **`rpc-topshot-pack-opens-history` returning `done: true` ~96×/day is a DELIBERATE STANDBY.** It looks like a dead cron on every instrument. Do not unschedule it.
- **SERIAL-FMV-MULT-CRON — BY DESIGN.** `serial_fmv_multipliers` and `serial_fmv_power_model` refresh **weekly** via pg_cron. Staleness ≤7d is expected; do not re-queue as an escalating cron-silent item.

## ⚠ DO NOT ARCHIVE `docs/overnight/inbox/` FILES (measured 2026-08-17 — a queued action that would have broken things)

The `inbox/` convention says files are "archived to `inbox/archive/` after draining", and the 08-17 handoff had ~40 Aug 9–14 files queued to archive "once push is restored". **Do not run that.** Those files have become **permanent citation targets**: they are referenced by exact path from `CLAUDE.md` (4), `docs/overnight/ledger.md` (many), a dozen handoffs, the roadmap, `docs/sessions/2026-08.md`, **four committed `supabase/migrations/*.sql` files**, and **`lib/analytics/rpc-with-retry.ts:268`** (live product source). Moving them breaks every one of those, and migrations are immutable history that must not be edited to chase a path.

Evidence this has already bitten: `inbox/archive/2026-08-10T0515Z-…md` cites `inbox/2026-08-09T1941Z.md` — an already-archived file pointing at a still-live inbox path.

**The convention and the citation practice are in conflict, and the citations win.** Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`. ⚠ **THIS IS ENFORCED: `__tests__/inbox-is-append-only-since-the-rule.test.ts` bans any filing dated on or after the rule from sitting in `archive/`.** ⛔ **And the 2026-08-24 night-pass handoff queued the OPPOSITE** — *"a push-capable pass should archive resolved items"*, calling ~200 live filings *"the accrued cost of the long NO-PUSH streak"*. **They are not debt; they are the intended steady state.** A push-capable pass tried it on 2026-08-24 and the guard stopped it. **Retire a filing by annotating it in place with a ✅ RESOLVED section — never by moving it.**

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

## STANDING — read the three daily instrument LOGS, not their badges (added 2026-08-22)

Three credentialed detectors run daily and are the only things that can see their rot classes:
`edge-fn-drift` (06:40Z) · `db-pin-staleness` (07:20Z) · `migration-parity` (07:40Z). **Measured 2026-08-22:
edge-fn-drift red 14 consecutive runs, db-pin-staleness red 13, migration-parity 14/14 green — and BOTH red
ones are LOUDLY CORRECT, not broken.** 25 edge functions are not running `main`; 6 of 187 DB pins no longer
match live. Details: known-issues **#23**, **#24**.

⚠ **Nothing surfaces them (#25).** The sentinel — the thing actually read — has no GitHub Actions arm, so a
correct detector can stay red indefinitely and nobody notices. Until that is fixed, **reading these three
logs is a MANUAL step in any health sweep**, and CLAUDE.md's rule applies literally: *check the LOG, not the
badge* — a permanently-red instrument and a broken one look identical.

✅ **#24 is RESOLVED as of 2026-08-22 — all six pins re-pinned, assertions reviewed, not merely repointed.**
The warning that stood here (repointing without reviewing the assertions converts a working alarm into a
silent green) was honoured: every pin got its own diff, and five gained mutation-tested assertions for the
behaviour that had drifted. ⚠ **VERIFY, do not assume:** the 07:20Z `db-pin-staleness` run should now report
**187 clean, 0 needing attention** — its first green since 2026-08-03. If it names a pin instead, read WHICH
before reopening. 🚨 **IT DID NAME PINS — this prediction was FALSIFIED on 08-23 and the reason is durable;
see the 2026-08-23 STEER above.** Closure is a moment, not a state: a same-day rewrite of a pinned function
re-opens the instrument within hours. Recipe + what the six taught: [database.md](../reference/database.md).

⚠ **#23 and #25 remain OPEN and are operator-blocked.** 25 edge functions are still not running `main`
(redeploy needs both `deno.json` in `files` AND `import_map_path`, or a stale-but-working function goes
hard-down — and the list includes off-limits `compute-*-pack-ev` / `ingest-*`). Nothing still reads the
daily detectors; that fix is a sentinel arm keyed on a failure STREAK, blocked on putting a GitHub token
with `actions: read` into Vercel env.

## DECIDED 2026-08-22 — two open decisions closed, so nobody re-opens them

- ✅ **pg_cron jobid 70 / the `cron_heavy` privilege question: do NOT grant, no grant is needed.**
  `postgres` IS a member of `cron_heavy`, and `cron_heavy` already holds EXECUTE on `cron.schedule` and
  `cron.unschedule` — only `cron.alter_job` is missing, and `cron.schedule` upserts on
  `(jobname, username)`, so rescheduling under the job's own role updates it in place. Granting
  `alter_job` would widen a privilege to buy a capability the role already has by another door.
  ⚠ **The blocker is the HARNESS, not the database** — the Claude Code auto-mode classifier denies
  `SET ROLE`. The two-line self-checking recipe (and what to do if it returns a jobid other than 70) is
  in **known-issues item 19**, which has been corrected: its old "NO session-reachable role can
  reschedule" headline was **REFUTED**. **Transferable:** *"the sandbox could not do it" is not evidence
  that the DATABASE forbids it* — that conflation turned a two-line fix into a privilege-grant proposal.
- ✅ **The FMV-confidence accuracy meter: the destination is a NIGHTLY MATERIALISED TALLY**, not a
  cheaper in-band query. Rationale in §7 of
  `inbox/2026-08-22T1745Z-the-headline-accuracy-metric-is-unreadable-20h-a-day-…md`. The short form: a
  3.3× cheaper query still runs in-band and can still be killed in a spell — it lowers the odds without
  removing the dependency; and **a GATE metric needs a SERIES, which the in-band rewrite does not
  provide at all**. ⚠ **The lateral rewrite is NOT the alternative — it is the tally's WRITER**, so the
  23:10Z measurement (`trig_01H3p6o5iB7yyjLVzrbbviaA`) keeps its full value and has been repointed at
  that question. ⚠ **The tie check is now BLOCKING**: a tally is computed once and read all day, so an
  arbitrary tie-break is frozen into the published number. ⚠ **New third state for the redesign:
  STALE** — a stored tally that silently ages is worse than a query that loudly times out, because a
  timeout is falsifiable. Nothing has shipped: no table, no writer, no migration.

## RETIRED STEERS — these were in this file and are now WRONG; do not re-add

- ⛔ **"TS on-chain unmapped spike — do NOT skip/retire this class."** `topshot-flowty-unmapped-drain` was **deliberately RETIRED 2026-08-16** (schedule removed from `vercel.json`, verified absent) because its queue reached **0 open** and proving emptiness cost a full backlog scan on ~73 ticks/day. The old steer now argues against a decision that was correctly made.
- ⛔ **"evm-transfers-ingest Base-429 — benign, don't chase."** That cron was **disabled 2026-08-02** as pure waste (`evm_nft_transfers` holds ZERO rows; absent from `vercel.json`, GHA and pg_cron). There is nothing left to not-chase.
- ⛔ **"`unmapped_resolution_backlog_max` self-clears <100 in ~1–2 days."** It did not. It is **291** and is now understood as an AllDay **permanent-class floor**, continuously replenished. Do not wait for it to clear and do not raise its threshold.
- **The whole 2026-06-24 studio-platform post-ship watch** (3 backfill routes, the watchlist follow-ups, the TS dead-media tail, the spork-proxy correction, the UFC studio resolver) — all shipped and long since folded into `CLAUDE.md` + the ledger. Kept out of this file to stop it decaying into an archive again.
