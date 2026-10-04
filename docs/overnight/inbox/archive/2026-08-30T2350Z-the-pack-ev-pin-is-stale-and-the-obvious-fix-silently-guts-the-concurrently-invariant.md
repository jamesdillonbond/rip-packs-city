# ⚠ `refresh_mv_pack_ev_latest`'s pin went stale with tonight's watermark gate — and the OBVIOUS fix silently removes the `CONCURRENTLY` invariant for that function

**Filed:** 2026-08-30 16:50 PT (23:50Z) · **By:** Claude (Claude Code, Trevor's box), interactive
**Class:** pinned-function drift · **Status:** ✅ **RESOLVED 2026-08-30 ~22:15 PT** by the Claude Code overnight pass — see the resolution appended at the end. (Originally filed NOT FIXED HERE, deliberately — see §4.)

## 1. The condition

`npm run db:pins:check` → **189 pins, 188 clean, 1 needing attention**:

```
STALE                  refresh_mv_pack_ev_latest
```

The pin in `__tests__/db-invariants-drift-guard.test.ts` points at
`supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql`,
whose body is the one-liner:

```sql
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_pack_ev_latest;
END;
```

Tonight's `20260830222057_audit_20260830_mv_pack_ev_latest_refresh_watermark_gate`
(shipped ~22:2xZ by the cloud session) `CREATE OR REPLACE`d it with a watermark gate that
**`RETURN`s before the REFRESH** when `max(pack_ev_history.snapshotted_at) <= last_seen_snapshot`.
Live `pg_get_functiondef` confirms the gate is deployed.

⚠ **`.github/workflows/db-pin-staleness.yml` runs `npm run db:pins:check` daily at 07:20 UTC and the
script sets exit 1 on any stale pin, so this WILL go red on the next honoured run.** (Per
[the GHA-schedule filing](2026-08-29T2230Z-github-actions-schedules-are-not-honoured.md), "next
honoured run" may be well after 07:20Z.)

ⓘ **Nothing else is red, and that is this drift class working as documented.** The in-CI SQL test
passes, because `supabase/tests/mv_refresh_wrappers.sql` **`CREATE OR REPLACE`s the function from its
own embedded verbatim copy** before asserting — it tests its own text, not prod. The workflow header
says exactly this: the class "leaves the repo, the SQL test, and the in-CI drift guard all green, so
ONLY this live check sees it."

## 2. 🚨 The trap — why the one-line fix is worse than the red

The instinct is "update the embedded verbatim block to the new body." **Do not stop there.**

`mv_refresh_wrappers.sql` exists to pin two invariants that live OUTSIDE the function body, and its
own header says why nine near-identical one-liners are worth a test at all:

1. **`CONCURRENTLY` requires a UNIQUE INDEX on the view.** The test *proves* the coupling by
   dropping the index and showing the refresh break.
2. **Each wrapper must refresh the view its own name implies** — pinned by refreshing through each
   wrapper in turn and checking WHICH view moved.

⛔ **Both assertions require the REFRESH to actually execute.** With the gate in place and the state
row at its steady value, the wrapper takes the skip branch and returns without refreshing — so
dropping the unique index raises nothing, and no view moves. Update the verbatim block alone and the
test goes red; "fix" that red by loosening the assertion and **this function silently stops being
covered by the `CONCURRENTLY` invariant** while the file still reads as if it were.

⭐ That is this repo's own recorded failure shape — a test that keeps its name and title while its
assertion stops holding the promise. See [[a-test-can-pin-the-defect-it-was-named-to-prevent]] and
CLAUDE.md's *"a vacuous assertion reads as coverage everywhere."*

## 3. The fix, specified

Three changes, in one commit:

1. **`supabase/tests/mv_refresh_wrappers.sql`** — replace the verbatim
   `refresh_mv_pack_ev_latest` block with the new gated body (byte-identical to
   `20260830222057` / prod).
2. **In the same file, force the refresh branch before the two assertions that exercise this
   wrapper.** ⭐ The function **fail-opens on NULL** — it only skips when
   `v_hist_max IS NOT NULL AND v_seen IS NOT NULL AND v_hist_max <= v_seen` — so the minimal,
   behaviour-preserving seed is:
   ```sql
   UPDATE public.mv_pack_ev_latest_refresh_state SET last_seen_snapshot = NULL;
   ```
   That keeps BOTH invariants live without weakening either assertion, and without inventing a
   fixture for `pack_ev_history`.
3. **`__tests__/db-invariants-drift-guard.test.ts`** — repoint the `refresh_mv_pack_ev_latest` pin
   from `20260816080000_…` to
   `supabase/migrations/20260830222057_audit_20260830_mv_pack_ev_latest_refresh_watermark_gate.sql`.

⚠ **Consider also pinning the NEW behaviour** rather than only restoring the old coverage: an
assertion that a second immediate call SKIPS (`skipped_count` increments, view unchanged) is the
gate's actual contract, and the cloud session already verified exactly that by hand
("first call REFRESHED, immediate second call SKIPPED"). Without it, a future revert of the gate
would pass every test.

**Falsifier for whoever lands this — run it, do not assume it:** after the change, drop the unique
index on `mv_pack_ev_latest` inside the test transaction and confirm the wrapper still RAISES. If it
does not, the seed in step 2 did not take and the invariant is no longer being tested.

## 4. Why this session did not fix it

⛔ **Live collision risk, not reluctance.** The cloud session that shipped the gate is still working
this exact area — it pushed `9729aaa8d` (*"correct the tick attribution in tonight's guard-trip
entry"*) minutes before this filing. `mv_refresh_wrappers.sql` and `db-invariants-drift-guard.test.ts`
are its files tonight, and step 3's judgement (which assertions describe the new behaviour) is its
design context. Two sessions editing one pinned test concurrently is the clobber class this repo
keeps recording.

👉 **If that session is still up, it should take this — it is ~15 minutes with the spec above.**
Otherwise the night pass or Trevor. ⚠ Whoever takes it: the migration file is already committed, so
this is the MILD variant of the drift class (pin points at an older snapshot) — **not** the severe
one (a function redefined via MCP with no committed migration at all).

---

## ✅ RESOLVED — 2026-08-30 ~22:15 PT, Claude Code (Trevor's box, overnight pass)

Taken because the cloud session named in §4 has closed. All three specified changes landed, plus the
§3 "consider also" arm, in one commit.

**§2's trap was not just avoided — it was MEASURED.** The filing argued the invariant would go dead;
a control now shows it. In an isolated `zz_mvgate_probe` schema on live (dropped after, 0 leftover),
a body-equivalent copy of the function was driven through the file's own sequence:

| probe | got | want |
|---|---|---|
| gate open (NULL watermark), view moves | 31 | 31 |
| ...booked as a refresh | 1/0 | 1/0 |
| ...watermark adopted | true | true |
| gate closed, bumped source must NOT move the view | 31 | 31 |
| ...skip counted | 1/1 | 1/1 |
| new snapshot re-opens the gate | 32 | 32 |
| ...booked as a second refresh | 2/1 | 2/1 |
| **index probe WITH the seed** | **55000** | 55000 |
| 🚨 **CONTROL — index probe WITHOUT the seed** | **`no error`** | `no error` |

That last row is the finding: seeded, dropping the unique index raises 55000 as it always did;
unseeded, it raises **nothing at all**. The one-line fix would have left this file's central
assertion passing vacuously.

**Also landed (the §3 "consider" arm), because without it the filing's own point stands — a revert of
the gate would pass every test here.** New §1c pins the gate's contract: a bumped source must NOT move
the view while the gate is closed, the skip is counted, and a *new* snapshot **re-opens** it. That
third arm is deliberate: the first two alone are equally satisfied by a gate wedged permanently shut,
which is the failure mode that would silently freeze the public pack-EV surface.

**Falsifier status — stated, not fudged.** The filing asks for the drop-index probe to be re-run after
the change. It was, against the body-equivalent copy (table above), *and* with its negative control.
It was **not** run through `scripts/run-db-tests.sh` on the real file: this box has neither `psql` nor
`docker`. The `DB invariants (SQL)` CI job is the first end-to-end execution — and it is an honest
falsifier, because an ineffective seed makes the probe return `no error` and reds the job rather than
passing quietly.

Local: drift guard 197/197 · `npm run db:pins:check` **189 pins, 189 clean, 0 needing attention**
(was 188/1 stale) · full suite 15,619 passed, 0 assertion failures. The 07:20Z
`db-pin-staleness.yml` red is averted.
