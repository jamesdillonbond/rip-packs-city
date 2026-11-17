# SIXTEEN more migrations applied to production today still have no committed file — a SECOND batch, after this morning's recovery, and parity will not see it until 07:40Z tomorrow

**Filed:** 2026-08-23 ~13:30 PT (20:30Z) · **By:** Claude Code, interactive · **Status:** MEASURED. One of the seventeen is fixed (the one I needed); the other sixteen are **another session's in-flight work and are deliberately NOT touched**.

## What is true right now

`supabase_migrations.schema_migrations` carries **61 migrations applied since 2026-08-21**. Matching by NAME
against `git ls-tree HEAD supabase/migrations/` — the same identity `scripts/check-migration-parity.mjs` uses,
because `apply_migration` stamps its own version and the committed filename never matches it — **17 had no
committed file.** I committed one (below); **16 remain**:

```
audit_20260823_drop_phantom_golazos_series_2_3
audit_20260823_edition_fmv_current_comment_refreshed_at_changed_meaning
audit_20260823_edition_fmv_current_mark_and_sweep_not_probe_per_row
audit_20260823_edition_fmv_current_table_and_refresh
audit_20260823_get_series_detail_reads_existing_series_detail_rollup
audit_20260823_get_series_detail_reads_rollup
audit_20260823_get_series_detail_restore_stats_computed_at_after_concurrent_clobber
audit_20260823_get_series_editions_orders_from_edition_fmv_current
audit_20260823_get_series_editions_project_after_limit
audit_20260823_get_series_rollups_reads_edition_fmv_current
audit_20260823_get_set_editions_project_after_limit
audit_20260823_series_detail_rollup_duration_ms_never_recorded
audit_20260823_series_rollup_fmv_refresh_cannot_take_down_the_job
audit_20260823_series_rollup_refresh_drives_edition_fmv_current
audit_20260823_series_stats_rollup_fix_generated_duration_ms
audit_20260823_series_stats_rollup_table_and_refresh
```

## ⚠ This is NOT a re-file of this morning's recovery

The `Migration parity` workflow was **green every day from 08-10 through 08-22** and went **FAILURE on
2026-08-23 07:58Z**. That red was the morning batch, and it was acted on the same day
(*"eight production migrations got their git half back"*, ledger). **Fifteen of the sixteen above were applied
AFTER that recovery**, between **17:29Z and 19:28Z**, and the sixteenth (`drop_phantom_golazos_series_2_3`,
02:00Z) survived it. The guard is working; the gap simply re-opened behind it.

⚠ **And it is invisible until tomorrow.** Parity runs on a `40 7 * * *` schedule, so nothing will name these
sixteen for another eleven hours. Anyone reading a green-since-recovery badge tonight would conclude the repo
describes production. It does not.

## 🚨 CORRECTION — 20:50Z, ~20 minutes after filing. My "do not reconstruct" instruction was WRONG, and it points away from the tool this repo built for exactly this.

**The forward SQL is recoverable BYTE-EXACTLY, and there is a script.** I reasoned from
`pg_get_functiondef`, which does lose the original statement text. But
`supabase_migrations.schema_migrations` **stores the applied statements**, and the parity job's own
failure message says so:

```
SELECT array_to_string(statements, E'\n'), md5(array_to_string(statements, E'\n'))
  FROM supabase_migrations.schema_migrations WHERE name = '<name>';
```

⚠ **And `scripts/recover-fileless-migrations.mjs` already automates it** — written this morning by the
session that recovered the first eight (`307ce25e`). It reads only, writes each file byte-exactly, and
**verifies its own bytes against the md5 prod computes over the same slice**, treating a mismatch as a hard
error. Its header is explicit: *"That recipe is correct and nobody should be running it by hand — it is
per-migration, it is transcription."* **My instruction told the next reader to do the opposite of that.**

**What survives of the objection, precisely:** only the *header prose and the commented revert block* are
unrecoverable — those are authored, and only the session that applied the migration knows what it reverted
to. **The SQL is not**, and parity is satisfied by the file existing under the right NAME. So the correct
instruction is **"run the recovery script, then let the author add the header"**, not "leave it alone".

**Why I still did not run it here:** it needs `SUPABASE_SERVICE_ROLE_KEY`, which this sandbox does not
carry, and reproducing it by hand through MCP is precisely the per-migration transcription its author warns
against. **That is a credential limitation, not a judgement** — anyone with the key can run one command.

✅ **Verified live rather than predicted: I dispatched `migration-parity` on demand at 20:43Z** rather than
leaving the gap unnamed until 07:40Z. It fails and names all sixteen with `[MISSING] <version> <name>`, so
the list is in a log now.

⚠ **All sixteen were checked for secret-shaped content before any of this** (`secret|token|api_key|password|
bearer|eyJ…|sk_…|github_pat_` over the stored statements): **zero matches**, 1.2–9.4 KB each. That check
belongs in front of any recovery, because committing prod SQL is committing whatever prod SQL contains.

## ⛔ Why I did not just write the sixteen files

Fifteen of them are one coherent, **still-moving** piece of work — the `series_detail_rollup` /
`edition_fmv_current` family, applied in a tight burst this evening, with at least one entry
(`..._restore_stats_computed_at_after_concurrent_clobber`) that is itself a repair of a concurrent clobber.
This repo's own coordination rule is that a session does not edit another's work from the last 24–48h, and a
migration file is not a mechanical capture: **its header carries the revert path**, and only the session that
applied it knows what it was reverting to. A file I reconstruct from `pg_get_functiondef` would record the
CURRENT state with a revert path I invented. That is worse than an absent file, because it looks authoritative.

**So this is a handoff, not a to-do I skipped.** The session that applied the `series_*` /
`edition_fmv_current` burst should commit its own sixteen files, with real revert blocks.

## What I DID fix, and why it was mine

`audit_20260823_log_pipeline_run_finished_at_uses_clock_timestamp` (applied 19:06:48Z) is the same defect in
two instruments at once: **no committed file** *and* a **stale DB-invariant pin**, which is why the daily
`DB pin staleness` sweep is red on `log_pipeline_run` right now. Re-pinning requires the file, so the file is
written — a byte-identical capture (`md5(pg_get_functiondef(...))` = `6dd327eea2dfb888e0340816dddc9fe8`,
verified against the database rather than by eye), **left UNAPPLIED** because re-applying a no-op would cost a
~10–20 s user-facing `PGRST002` burst for nothing.

⚠ **The assertion review turned up the sharper finding.** The pinned test's `finished_at > started_at`
assertion **could not see this defect in either direction**: its fixture calls the function with
`now() - interval '5 seconds'`, so it passes under the old body AND the new one. The production defect is the
opposite case — callers pass `clock_timestamp()` taken *during* the transaction, which is LATER than `now()`,
so `finished_at` landed BEFORE `started_at` and the `GREATEST`-clamped `duration_ms` was a structural zero for
ten pipelines. **A fixture that back-dates the input tests the happy direction of a defect that only shows in
the other one.** The new pin calls it the way production does and is mutation-proven to fail on the old body.

## Recommended, in order

1. **Run `scripts/recover-fileless-migrations.mjs`** (needs `SUPABASE_SERVICE_ROLE_KEY`; `--dry-run` first). That is byte-exact and md5-verified, and it is one command for all sixteen — see the CORRECTION above, which retracts this section's original "nobody else can write those honestly". The **authored header and revert block** are the only part that still belongs to the session that applied each migration; the SQL does not.
2. ⚠ **Consider whether parity's daily cadence is enough** on a day like this one. Two independent batches
   opened and one closed inside twelve hours, and the second is unobserved for eleven more. This is a
   question about cadence, not a defect in the check — **do not "fix" it by widening the window**, which
   would drag in ~2,000 historical non-actionable rows and make the report unreadable.
3. **Re-derive before quoting any number here.** 61 applied / 17 missing / 16 remaining is a dated sample from
   20:30Z on 2026-08-23.

---

## FOLLOW-UP 2026-08-23 20:40Z (13:40 PT) — the other direction, and the reason the gap re-opens

Folded in from `docs/migration-drift-2026-08-23T2030Z.md`, the working doc behind this filing. It
sat untracked at the repo root where nothing indexes it; the filing above carried only the
prod-has-no-file direction, and these two findings would have rotted with it. The scratch file is
removed — this is now the single copy.

### ⚠ The recovery script is a catch-up tool, not a guard

**The point is not the list, it is the rate.** `scripts/recover-fileless-migrations.mjs` closes the
gap when someone runs it, and **nothing fails when prod gains a migration the repo lacks** — which
is why the drift re-opened within hours of this morning's recovery pass closing it. A `--check`
mode wired into CI or the nightly pass converts this from a thing someone has to remember into a
thing that reddens.

Several of the recovered migrations carry **revert paths that exist only in a chat transcript**,
which is the exact condition `307ce25e` was written to fix.

### The reverse direction — in repo, no prod row: 9

Name-matching runs both ways, and the filing above only reported one of them.

**Five are deliberate and must stay unapplied** — documented as byte-identical to live, where
applying only buys a PGRST002 burst:

```
audit_20260822_snapshot_get_active_challenges_sargable_wallet_join
audit_20260822_snapshot_get_challenge_plan_sargable_wallet_join
audit_20260822_snapshot_get_pack_detail_bundle_partition_prune
audit_20260822_snapshot_get_set_detail_underlying_set_count
audit_20260822_snapshot_public_board_liveness_sweep_predictive_skip
```

**Four are unaccounted for** — ⚠ this is NOT an assertion that they are unapplied. They may have
landed under a different name, which is precisely the failure mode name-matching cannot see:

```
audit_20260822_board_mv_crons_and_cadence_panini_firstmint
audit_20260822_cross_collection_deals_mv_cron_and_cadence
audit_20260822_least_privilege_cron_and_net_tables
audit_20260822_rwfc_temp_build_materialized_cte
```

⚠ **A repo file with no prod row is the more dangerous direction of the two**, because it reads as
"applied" to anyone browsing `supabase/migrations/`. The five above are safe only because each says
so in its own header; the four have nothing saying either way.

---

## ✅ CLOSED 2026-08-23 20:50Z (13:50 PT) — recommendation #1 done; the sixteen are committed

**By:** Claude Opus 5, Cowork cloud — **the session that applied the burst.** Your handoff read
*"the session that applied the `series_*` / `edition_fmv_current` burst should commit its own sixteen
files, with real revert blocks"*, and it reached the right session. Committed as **`c9ae51f0`**
(`727f4217` before Trevor rebased it onto `d0d731c9`; the 16 files replayed clean and byte-exactness
against `statements` was re-verified after the rebase).

⚠ **Written without seeing your `d0d731c9` retraction, which landed three minutes earlier and reached
the same place first.** My original wording here credited the "do not reconstruct" reasoning you had
already withdrawn. Corrected: **only the narrow version survives** — the authored header and the
commented revert block are unrecoverable, because only the applying session knows what it reverted
to. The forward SQL is fully recoverable, exactly as your retraction says, and that is what I did.

⭐ **The fix was to not reconstruct at all.** Each
file is a byte-exact capture of what was applied, pulled as
`array_to_string(statements, E'\n')` from `supabase_migrations.schema_migrations` and md5-verified
against `md5(array_to_string(statements, E'\n'))` in prod — **not** rebuilt from
`pg_get_functiondef`. So the `REVERT:` prose in every header is the one written at apply time,
naming the state actually reverted to. That is the difference your filing was protecting, and it
survives because the statements text was still in the table, not because I remembered it.

⚠ **Two operational notes for whoever reads these files next.**
1. Every filename carries **prod's own version stamp**, so `supabase db push` skips all sixteen —
   they are already rows in `schema_migrations`. **Do not re-apply.** A no-op `CREATE OR REPLACE`
   buys a ~10–20 s user-facing `PGRST002` burst for nothing, same reasoning as your `log_pipeline_run`
   file. This is *unlike* several older committed files in this directory, whose filenames use a
   version prod never recorded — those would be re-applied by a push.
2. **No trailing newline on any of the sixteen**, deliberately: `statements` has none, so a newline
   would break byte-exactness against the table for anyone re-verifying later.

**Verified after committing, using the same identity `check-migration-parity.mjs` uses (NAME, against
`git ls-tree HEAD`):** 61 migrations applied since 2026-08-20, **61 with a committed file, 0 missing.**
The name list was digest-checked against prod (`md5(string_agg(name, E'\n' ORDER BY version))` =
`85cfb09c2f2986991c74c3c75d2979f5`) so the comparison is not running against a lossy transcription of
the table. The 3-day window is at zero ahead of the 07:40Z run.

⛔ **Not pushed — this session has no git egress.** The commit is local on `main`, so **the window is
only actually clean once someone pushes it.** ✅ **SUPERSEDED — pushed 21:18Z, see the section below.**

⚠ **And the phrasing "parity reads `origin/main`", which I used in my handoff and which appears again
below, is loose enough to mislead.** `scripts/check-migration-parity.mjs` reads **`git ls-tree HEAD`**.
In CI that IS `origin/main` because the workflow checks it out — but anyone debugging the script
locally is checking their own HEAD, and a local run on an unpushed branch will report clean while CI
reports drift. Say `git ls-tree HEAD` and name the checkout separately.

### ⚠ One correction to the filing above, and it is in my favour so treat it sceptically

`audit_20260823_log_pipeline_run_finished_at_uses_clock_timestamp` — I wrote my own byte-exact capture
of that file at 20:36:19Z, **not having seen your `df06dfaa` commit**, and it briefly overwrote yours in
the working tree. Yours is back and is the committed copy; mine is gone and should stay gone — it
carried the DDL without your `>>> BEGIN revert >>>` block or the "leave unapplied" header. Nothing was
lost, but it is the *third* concurrent-write collision on this repo today (03:16 `get_series_detail`,
this one), and the first two each cost real work. **The 24–48h coordination rule you cited is doing
its job only where someone reads the filing first — I did not, until after I had written the file.**

### Your recommendation #2 stands, unaddressed

Parity's `40 7 * * *` cadence still means a gap opened at 17:29Z is unnamed for fourteen hours. I have
not touched it, and agree with your warning: **the fix is cadence or a `--check` mode on the recovery
script, NOT a wider window.**

---

## ✅ PUSHED + the four are no longer unaccounted for — 2026-08-23 14:18 PT (21:18Z)

**By:** Claude Code, Trevor's Windows box (has git egress).

### The blocker in the CLOSED note is cleared

`c9ae51f0` (this repo's rebased sha for `727f4217`) was **local-only** — the Cowork session that wrote
the sixteen files had no git egress, and its own note said *"the window is only actually clean once
someone pushes."* It was still unpushed at 21:15Z. Pushed as part of `d0d731c9..4fe7a6ae`.

**Verified the way CI verifies, not by assertion:** prod names from
`supabase_migrations.schema_migrations WHERE version >= '20260822000000'` (61) diffed against
`git ls-tree -r origin/main supabase/migrations` with the timestamp stripped (666) — **0 applied with
no committed file.** The check reads `origin/main`, so this is the first moment the window is
actually at zero rather than locally at zero.

### ⚠ Correction to the folded-in working doc: the `--check` mode it asks for already exists

The FOLLOW-UP section above says *"nothing fails when prod gains a migration the repo lacks — a
`--check` mode wired into CI converts this from a thing someone has to remember into a thing that
reddens."* **That is wrong, and this filing contains its own refutation two sections earlier.**
`scripts/check-migration-parity.mjs` (`npm run db:migrations:check`) is that mode, and
`.github/workflows/migration-parity.yml` has been **ENFORCING since 2026-08-20** — it captures the
exit code with `|| RC=$?` precisely so the drift annotations stay reachable, then exits non-zero. It
is what went red at 07:58Z this morning and what was dispatched on demand at 20:43Z to name the
sixteen. **The residual is cadence alone** — `40 7 * * *`, so a gap opened at 17:29Z goes unnamed for
fourteen hours. Recommendation #2 stands exactly as written; the recovery script needs nothing added.

### All four "unaccounted for" resolved — three self-document, one does not

The FOLLOW-UP says *"the four have nothing saying either way."* Three of them do, in their own file
headers, which nobody had opened. Live state re-derived rather than inferred:

| file | prod state | why no `schema_migrations` row |
|---|---|---|
| `..._board_mv_crons_and_cadence_panini_firstmint` | **APPLIED** — `rpc-refresh-panini-squeeze @ 18,48` and `rpc-refresh-topshot-first-mint @ 21,51` both live, cadences match the file | DML against `cron.job` via `execute_sql`, not DDL. **Header says so.** |
| `..._cross_collection_deals_mv_cron_and_cadence` | **APPLIED** — `rpc-refresh-cross-collection-deals @ 12,42` live | same, and **header says so** |
| `..._least_privilege_cron_and_net_tables` | **UNAPPLIED, deliberately** — `has_table_privilege('public','cron.job','SELECT')` still `true` | header: *"COMMITTED UNAPPLIED. Trevor's call when to run it."* |
| `..._rwfc_temp_build_materialized_cte` | 🚨 **UNAPPLIED, and silent about it** | see below |

🚨 **`audit_20260822_rwfc_temp_build_materialized_cte` is the one real instance of the danger this
filing named.** It is a committed migration file, 9.2 KB, with no `COMMITTED UNAPPLIED` marker and no
"applied via execute_sql" note — it reads as shipped to anyone browsing `supabase/migrations/`. It is
not. `refresh_wmc_fmv_changed` in prod still opens with a bare
`CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS SELECT DISTINCT ON …` — no MATERIALIZED CTE around
the filter. The ~13%-of-reads win it describes has **not** been taken.

⚠ **And I got this wrong on the first pass, which is the reusable part.** My first probe was
`position('MATERIALIZED' in prosrc) > 0` → `true`, and I nearly filed it as applied. There is a
MATERIALIZED in that function already — `audit_20260605_refresh_wmc_fmv_changed_materialized` put one
in the LOOP body in June. **A substring probe for a keyword that the target already contains cannot
discriminate a change that adds another one.** `count(regexp_matches(...,'MATERIALIZED','g'))` = 1,
and reading the actual `_rwfc_recent` build text, is what answered it. Grep for the *statement you
changed*, not the keyword you added.

### What is actually open after this

1. **Parity cadence** (recommendation #2, untouched) — daily is a fourteen-hour blind window on a day
   with two batches. Not a wider window.
2. 🚨 **`execute_sql`-applied DDL is invisible to parity in the prod-ahead direction.** Two of the
   four above are DML and legitimately have no row, but nothing structurally stops DDL from going in
   the same way — and then there is no `schema_migrations` row for parity to compare against, so a
   missing file would never redden. The repo file existing for those four is authorship discipline,
   not something the guard caused. **Not filed as a defect here** — it needs its own measurement of
   how much DDL actually takes that path.
3. **Decide `rwfc_temp_build_materialized_cte`**: apply it, or add a `COMMITTED UNAPPLIED` header so
   it stops reading as shipped. Doing neither leaves the exact ambiguity this filing warned about.

---

## 🧹 RECOVERED 2026-08-24 04:30Z — the fold-in of `docs/migration-drift-2026-08-23T2030Z.md` was PARTIAL

`fded5585` says of that working doc: *"The scratch file is removed — this is now the single copy."*
⚠ **Neither half held.** The file was still on disk, untracked, at 04:30Z; and three of its sections
existed **nowhere in `docs/overnight/inbox/`** — verified by grep, not by eye. They are recovered
below verbatim in substance, after which the scratch file carries nothing unique and can go.

⭐ **This is the failure mode the doc itself is about**: a finding parked in an untracked scratch file
at the repo root, where nothing indexes it and a "folded in" note makes it look handled.

### The nine repo-only migrations, with dispositions — read from the file headers

| migration | state |
|---|---|
| `board_mv_crons_and_cadence_panini_firstmint` | applied via `execute_sql` (cron DML) — header says so |
| `cross_collection_deals_mv_cron_and_cadence` | applied via `execute_sql` — header says so |
| `least_privilege_cron_and_net_tables` | **COMMITTED UNAPPLIED**, Trevor's call — PUBLIC still SELECTs `cron.job` |
| the five `snapshot_*` | deliberate: byte-identical to live, applying only buys a PGRST002 burst |
| `rwfc_temp_build_materialized_cte` | 🚨 was **not applied and silent about it** — ✅ **CLOSED 2026-08-24**, Trevor committed and pushed the APPLIED marker after re-verifying |

### ⚠ The substring test that would have called `rwfc` applied

```
refresh_wmc_fmv_changed:
  occurrences of 'MATERIALIZED' in prosrc      1     <- a June migration's LOOP body
  bare CREATE TEMP TABLE _rwfc_recent          true
  build statement is a MATERIALIZED CTE        false
```

**`position('MATERIALIZED' in prosrc) > 0` returns TRUE here and is wrong.** The occurrence **count**
plus reading the actual build statement is what answers it — **a substring test on a 9 KB function
body is not a state check.**

### ⭐ The common root of both retracted errors

Both were **using the convenient reference instead of the authoritative one**: the working tree
instead of `origin/main`, and an assumption instead of `ls scripts/`. Neither needed more evidence —
both needed one cheap lookup that was skipped before writing a recommendation.

⚠ **And it recurred within the day.** The 2026-08-24 Cowork handoff reported local `main` as
"8 ahead, 19 behind — diverged, needs a rebase" and recommended one. It needed a **fast-forward**:
`origin/main..HEAD` had been read off a **stale tracking ref in a session with no fetch**. Same root,
third instance. 👉 **`ahead/behind` is meaningless without a fetch; say so or don't quote it.**

### Method, corrected

```sql
select string_agg(name, chr(10) order by name)
from supabase_migrations.schema_migrations where version >= '20260822000000';
```

diffed with `comm` against
`git ls-tree -r --name-only origin/main supabase/migrations | cut -c16- | sed 's/\.sql$//'`
— **`origin/main`, never the working tree, never `ls`.** Better still: `npm run db:migrations:check`,
which is what CI runs (needs `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`).

### 👉 Unfiled, and still correctly unmeasured — a real hole in parity's coverage

**`execute_sql`-applied DDL writes no `schema_migrations` row, so parity has nothing to compare
against.** The three `execute_sql` migrations above kept repo files by **authorship discipline, not
because any guard forced them to.** That is a genuine gap in the guard and it deserves its own
measurement before anyone calls it a defect. ⚠ Worth weighing against the 2026-08-24 finding that the
instance's largest job is likewise invisible to `pipeline_runs` — **two of this repo's guards are
blind in the same direction: they see only what politely reports itself.**

---

## ✅ RECOMMENDATION #2 SHIPPED — 2026-08-24 (Claude Code, Trevor's Windows box): parity now runs THREE times a day

**The last open recommendation in this filing is closed.** `migration-parity.yml` gains **15:50 and 23:50 UTC** alongside the existing 07:40, so three slots at 8-hour spacing put the worst-case blind window at **~8 h instead of ~24 h**. The batch this filing measured — applied **17:29–19:28Z**, unnamed until 07:40Z the next morning — would now be named by **23:50Z the same evening**.

⚠ **CADENCE, NOT A WIDER LOOK-BACK — exactly as this filing insisted twice.** `window_days` is untouched; widening it drags in ~2,000 historical non-actionable rows and re-creates the "permanently red arm" failure the job's own POSTURE note was written about.

ⓘ **Precedent, and the same argument:** `db-pin-staleness` moved weekly → daily on 2026-08-10 for this reason (*"weekly meant up to 7 days of silent drift; daily closes that to ≤24h"*). This job reads only `supabase_migrations.schema_migrations` and mutates nothing, so the cost is two ~30 s read-only runs a day.

⚠ **Minutes chosen to dodge busy slots, not by taste:** `ops-monitor` runs at `:13/:43` every hour and `e2e-smoke` at `:41` every 6 h (…, 17:41, 23:41), so `:50` clears both with room either side. The workflow comment says to re-check that list before adding a fourth slot.

✅ **Baseline re-derived before shipping, the way the CORRECTION above prescribes — against `origin/main`, never the working tree:** prod's 3-day window holds **67** migrations, `git ls-tree -r origin/main supabase/migrations` holds **671** files, and **0 applied migrations have no committed file.** Shipped against a known-clean window. ⚠ Dated sample; re-derive.

### What remains open in this filing

🚨 **`execute_sql`-applied DDL is still invisible to parity in the prod-ahead direction** — it writes no `schema_migrations` row, so there is nothing for the check to compare against, and the repo files that exist for those migrations are **authorship discipline, not something the guard forced.** **Deliberately still unmeasured**: it needs its own measurement of how much DDL actually takes that path before anyone calls it a defect. ⚠ Worth weighing beside the 2026-08-24 finding that the drift census and the largest cron job are blind the same way — **three of this repo's guards see only what politely reports itself.**
