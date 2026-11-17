# Thread close — the Cowork side's durable output, and what must cross to the OTHER memory store

**2026-08-24, Cowork cloud.** Written because `MEMORY.md`'s own first entry settles it: **there are two memory stores and neither side can see the other's.** Everything I wrote this thread went to the **claude.ai PROJECT** store via `project_memory_*`. **Claude Code on Trevor's box has its own ~140-file store and cannot read any of it.** Per that entry's rule — *paste the text, never a pointer, and say which store you wrote to* — the lessons below are written out in full so they can be pasted into the Claude Code side.

---

## 1. Lessons to paste into the Claude Code memory store

**⛔ NEVER PROPOSE A CHANGE THAT MUTATES A CURSOR OR WATERMARK ON AN INFERRED MECHANISM.** I filed a mechanism for `allday-pack-opens-backfill`, correctly labelled the chunking interpretation as "arithmetic on the reported numbers, not a reading of the source" — and the caveat landed exactly on the error. `scanOpens(start, end, "desc")` walks DOWN from `end`, so `events 84699998-84700247` was the FIRST chunk, not the last. On that inversion I proposed a `skipped_permanent` escalation to "advance the cursor past that chunk", which — since zero blocks had been scanned — would have **permanently skipped real pack opens on a backfill that never revisits them.** ⚠ **The disproof was in the telemetry I quoted in my own filing:** `queries: 1` (a walk at its final chunk shows ~100) and `scanned_floor = end + 1` (the `hi + 1` a desc first-chunk failure returns). **When a number in your own evidence block does not fit your story, the story is wrong.** A labelled inference is a FLAGGED one, not a SAFE one — read the source, or file the observation with no recommendation.

**⛔⛔ NEVER ASSERT A GUARD IS ABSENT WITHOUT SEARCHING FOR IT.** I wrote *"nothing fails when prod gains a migration the repo lacks — a `--check` mode wired into CI would fix this"* and recommended building it. `scripts/check-migration-parity.mjs` + `npm run db:migrations:check` + `.github/workflows/migration-parity.yml` had been **enforcing since 2026-08-20** and were **red that morning at 07:58Z**. One `ls scripts/` would have caught it. **Recommending a guard that exists is worse than silence: it duplicates work and reframes a live red signal as noise.**

**⛔ REPO STATE IS `git ls-tree -r origin/main`, NEVER `ls`, NEVER THE WORKING TREE.** I filed "17 migrations in prod with no repo file"; the real number was **0**. I had listed the directory on the mount; the guard's reference — and CI's — is the committed tree. I even flagged "matched by NAME, not version" as *the* subtlety and missed the bigger one: **which tree.**

**⛔ A SUBSTRING TEST ON A MULTI-KB FUNCTION BODY IS NOT A STATE CHECK.** `position('MATERIALIZED' in prosrc) > 0` returned **true** for a migration that was **not applied** — the hit was a June migration's `latest_fmv AS MATERIALIZED` in the LOOP body. What discriminates is the occurrence **count** plus reading the actual statement. (Trevor's session hit the mirror image of this the same day with `position('CREATE TEMP TABLE' …)`.)

**⛔ BURST-SHAPED LANES INVERT GAP-BASED SILENCE DETECTORS.** The seven `wallet-backfill*` lanes have `p90_gap` **20–85 s** and `max_gap` **20,610–21,579 s** — a ~1,000× ratio. Measured: they spend **82–87% of wall-clock time inside a gap longer than 30 minutes**. A 30-minute floor is TRUE most of the time; poll at random and you flag all seven with ~0.85 probability. p50 failed, p90 failed, the next percentile fails too. 💡 Tell: `max_gap / p90_gap` — under ~10 a percentile threshold is fine, over ~100 it is the wrong instrument entirely; measure work done per interval instead. ⛔ **And a ROLLING recalibration eats its own outage:** `2 × max_gap_72h` gives zero false positives *and* fails to flag the one genuinely dead lane, because that lane's 12.2 h outage sat inside the window it calibrated on. **A silence baseline must be FROZEN, from a window believed healthy, with known-bad lanes excluded by name.**

**⚠ A FAILING PIPELINE IS NOT A STALE FIELD — ask what ELSE writes it.** `apply-fmv-haircut` had failed 11 of 20 days and its `nba_top_shot` leg has failed **every** run since the 08-16 split. I was one step from filing "Top Shot FMV is not being haircut." Measured instead: Top Shot `1.7.0_haircut` **11,405 rows in 14 d, freshest stamp minutes old**; `topshot_fmv_stale_hours` **0.1** of 6. `/api/fmv-recalc` applies the haircut **inline per collection**; the daily job is a catch-up sweep, not the primary writer. Real bug, **medium**, zero user-visible staleness.

**⚠ CHECK THE CALENDAR BEFORE DIAGNOSING A SPORTS PIPELINE.** `sync-nba-projections`: 187 runs / 26 days, `all_upstreams_failed`, and **`rows_written = 0` on every day including the 48 that reported `ok`**. `nba_player_projections` last synced 2026-07-20, **0 future games**. It is August — there is no NBA slate. **The defect is the classification** (`ok:false` where `ok:true, skipped:'no_slate'` belongs); it contributes 5–8 failures/day year-round and will be crying wolf in late October when a genuine break looks identical.

**⚠ `max_exec_time` IN pg_stat_statements IS A CEILING, NOT A MEASUREMENT.** Values clustering at ~7,990 / ~29,950 ms are the `authenticated` (8 s) and `service_role` (30 s) role timeouts — those rows were **killed, not completed**.

---

## 2. `MEMORY.md` (project store) — index lines I did NOT splice, and why

⛔ **I deliberately did not rewrite `MEMORY.md`.** It is ~48 KB, `project_memory_write` takes inline content only, and **this exact file was blanked once on 08-23 by a write that went wrong.** Reproducing 48 KB of dense unicode by hand to add six lines is a bad trade on the project's primary index. The topic files below are all written and correct; only the index lines are missing.

**(a) One line is actively WRONG and should be corrected:**

> `- ⚠ **CLAUDE.md sits at 39,974 / 40,000 (Node `.length`) as of 2026-08-24 — 26 characters of headroom.**`

Measured 2026-08-24 by me: **39,989 — 11 characters.** Replace with:

```
- ⚠ **CLAUDE.md is at STEADY STATE: 39,989 / 40,000 (Node `.length`, 2026-08-24) — 11 characters.** [Topic file](claude-md-is-at-steady-state-not-merely-full.md). Already condensed 713k→39k on 08-17 and **zero repeated sentences ≥60 chars remain** — there is NO slack to reclaim by tidying. ⛔ **Do NOT pick a displacement candidate by section size** — size is ANTI-correlated; `### Series map` (988 chars, looks like lookup data) carries the rule whose violation dropped 385,734 rows on 08-05. 👉 An ADDITION ARRIVES PAIRED WITH ITS DISPLACEMENT, chosen by whoever adds it.
```

**(b) Four topic files exist but are unindexed** (`project_memory_read` by name works; they are simply not discoverable from the index):

```
- **[⛔ BURST LANES INVERT GAP-BASED SILENCE DETECTORS](burst-lanes-invert-gap-based-silence-detectors.md)** — the wallet-backfill family spends 82–87% of wall-clock inside a >30-min gap; `max_gap/p90_gap ≈ 1000×`. p50 failed, p90 failed, the next percentile will too. ⛔ And a ROLLING recalibration learns an ongoing outage as normal — FREEZE the baseline.
- **[⚠ A FAILING PIPELINE IS NOT A STALE FIELD](a-failing-pipeline-is-not-a-stale-field.md)** — ask what ELSE writes the field before escalating. The FMV haircut sweep was red while the haircut was minutes fresh; `sync-nba-projections` is off-season, not broken.
- **[⛔ USE THE AUTHORITATIVE REFERENCE, NOT THE CONVENIENT ONE](use-the-authoritative-reference-not-the-convenient-one.md)** — repo state is `git ls-tree -r origin/main`, never `ls`. And **never assert a guard/caller/test is ABSENT without searching** — I recommended building `migration-parity`, which had been enforcing for four days and was red that morning.
- **[📊 THE READ PATH, ATTRIBUTED](rpc-read-path-cost-attribution.md)** — top 15 PostgREST entry points = 93 h of DB time in 11 d (34% duty cycle); 0.9% of the calls are 14.6% of the time. ⚠ PARTIAL — it cannot see non-PostgREST callers like jobid 303.
```

**(c) Still owed from 08-22 — there is no Dune section in the index at all**, so `rpc-dune-ownership-pipeline.md` and `dune-datapoint-not-credits.md` are unreachable from it:

```
## Dune
- **[⛔ TWO METERS — datapoints are binding, and the old "credits are not the constraint" note was WRONG](rpc-dune-ownership-pipeline.md)** — credits buy `/execute` (~fixed); **datapoints buy `/results` and are rows × columns**. One ownership walk = 146,100 × 6 = **876,600 dp = 87.7% of the 1,000,000 cycle**. ⚠ Size reservations from `count(*)`, not `pipeline_runs.rows_found`. ⚠ The `{{set_ids}}` param already exists (2026-07-07). **Backfill is 311M dp ≈ 26 years — nothing on the free tier finishes it.**
- **[402 is a DATAPOINT limit, not credits](dune-datapoint-not-credits.md)** — Trevor will say "credits" and the dune.com gauge will look fine.
```

---

## 3. Open items, with current state

| item | state | owner |
|---|---|---|
| **Rotate `INGEST_SECRET_TOKEN` / `CRON_SECRET`** | Leaked twice into transcripts from the cron-job.org **Common-tab DOM**. Phase 0 silence baseline is frozen and committed (`docs/rotation-phase0-baseline-2026-08-23.md` + `.csv`, 155 lanes). ⚠ **Verification tail is 24 h**, not an evening: 20 lanes have a natural cadence ≥80,000 s and 7 more are burst lanes with ~6 h quiet stretches. | **Operator only** |
| **`backfill-topshot-pack-supply` observability** | jobid 16, every 5 min, ~6.1 h of DB time / 11 d, writes **no `pipeline_runs` row**. One `log_pipeline_run` call unblocks the cadence decision. Same class as jobid 303. | Edge fn → MCP-shippable |
| **`apply-fmv-haircut` `nba_top_shot` leg** | Fails every run since the 08-16 per-collection split (`upstream request timeout`). Six collections rescued, the largest left behind. **Medium — not an accuracy breach.** | Route code |
| **`sync-nba-projections` no-slate classification** | Fix before the season resumes in late October, while the alarm still means something. | Route code |
| **My `__tests__` edit** | `claude-md-stays-under-the-memory-file-limit.test.ts` — failure message + header comment carry the "don't size-rank" lesson. **Assertions byte-identical**, `tsc` 0 syntax errors. ⚠ **Uncommitted on the mount.** | Needs `git add` |
| **`MEMORY.md` index lines** | Section 2 above. | Desktop session |

⚠ **Scope line, per the pass skill:** the no-push blocker is specific to **this cloud session**. Trevor's machine and Claude Code push normally. **Commit these files as usual.**

---

## 4. What this thread shipped to production

- `audit_20260822_ownership_backfill_targets_cost_ordering` — `get_ownership_backfill_targets` re-ordered by true cost (**13 sets → 88 sets per cycle**, same 900,000-datapoint reservation).
- `audit_20260823_ownership_targets_drop_rn1_escape` — retired the `rn = 1` escape once the route's empty-list skip landed.
- `audit_20260822_rwfc_temp_build_materialized_cte` — applied at operator instruction; body md5 `28ec5ce4c94b886e1625ca381dfe5bf0` verified against the pre-apply file, positive control clean.
- cron-job.org job **8020459** → `40 11 24 * *` (monthly on the cycle-anchor day).
- Inbox INDEX repaired (it was already short by one **before** I wrote anything).

**Retracted in place, in full:** the `allday-pack-opens-backfill` mechanism, and the migration-drift filing. No wrong claim of mine survives in the repo.
