# 106 `audit_*` scratch tables hold 221 MB of a 14 GB database — and that number is the argument for **leaving them alone**

**Filed 2026-09-02 ~01:15 PT (08:15Z), Claude Code cloud session.**
**Nothing changed, and the recommendation is NO ACTION on size grounds.** Filed because nobody has
measured this, and "the database is full of audit backup tables" is the kind of thing a session
eventually acts on from an impression rather than a number.

## What prompted it

`get_advisors(security)` returns **229 lints: 0 ERROR, 9 WARN, 220 INFO** — and **220 of 229 are the
same lint**, `rls_enabled_no_policy`. An instrument whose output is 96% one INFO line is one a reader
learns to skim, so the question was whether that population is real.

## The measurement

| | tables | total size | est. rows |
|---|---:|---:|---:|
| scratch / backup (`audit_*`, `_*`, `*_prior`, `*_backup`, `*_20260xxx`) | **106** | **221 MB** | 939,876 |
| everything else in `public` | 277 | **14 GB** | 23,846,910 |

**1.5% of the database.** ⛔ **That is not a space problem, and this filing exists mainly to stop the
next session from treating it as one.** On an instance whose binding constraint is measured to be
**disk IO throughput, not capacity** (R46), 221 MB of never-read tables costs approximately nothing:
they are not scanned, not vacuumed hot, and not in the hot set.

**What they DO cost is instrument noise:** ~103 of the 220 INFO lints are these tables, i.e. **47% of
the advisor's entire output is scratch**.

## The one that stands out, and it is still not worth a destructive action

`audit_20260830_pgss_snap` — **117 MB / 242,985 rows, 53% of the scratch total in a single table**. It
is a `pg_stat_statements` snapshot, i.e. a MEASUREMENT ARTIFACT rather than a revert path.

⛔ **Still: do not drop it without asking.** This repo's own measurement discipline says a positive
result needs *"a no-change control the fix cannot move"* — a frozen pgss snapshot is exactly that
shape, and somebody may be mid-comparison against it. **A 117 MB saving on a 14 GB database is not
worth pre-empting that.**

## ⛔ And the rest are REVERT PATHS, which is the real reason not to sweep

The `audit_*` convention on this platform is *"the DB half of a migration's revert path"*, and the
ledger names several of them explicitly — `audit_20260827_jobid55_watchlist_note_backup`,
`audit_20260828_board_mv_watchlist_note_backup`, `audit_20260827_candy_editions_watchlist_note_backup`
are the restore targets for live watchlist notes **right now**. 🚨 **And the `git revert <sha>` half of
every pre-2026-08-03 revert path is already DEAD** (that day's `filter-repo` rewrote every sha), so for
the oldest of these the backup table is the ONLY surviving half. **Dropping by age is exactly backwards:
the oldest are the ones whose code-side revert is already gone.**

## Suggested action

1. **Nothing on size.** Re-file only if `public` approaches a real capacity limit; 1.5% is noise.
2. **If the advisor's readability matters** (a defensible want — 96% of its output is one INFO line),
   the fix is on the READING side: filter `rls_enabled_no_policy` for `audit_*`/`_*` when triaging,
   the same way `pipeline_fails_24h` was taught to split upstream 530s from real failures. **Do not
   quiet the writer by dropping tables.**
3. **A retention convention would need a decision, not a cleanup**: e.g. "an `audit_*` table may be
   dropped once its ledger entry is older than N months AND its migration's `git revert` path still
   resolves". That is Trevor's call and it is worth almost nothing in bytes — the argument for it, if
   any, is tidiness.

## Falsifier / re-derive

Re-run the two size queries. **If the scratch share ever exceeds ~10% of `public`, or a single scratch
table exceeds 1 GB, this filing is wrong and the question is worth reopening.** Also re-check whether
`audit_20260830_pgss_snap` is still referenced by any open filing before considering it.
