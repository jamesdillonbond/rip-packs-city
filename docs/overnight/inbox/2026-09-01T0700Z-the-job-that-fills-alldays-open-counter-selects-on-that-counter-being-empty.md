> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T07:00Z — the job that fills AllDay's open counter selects on that counter being empty

⚠ **Scope.** Cloud pass, **no desktop bridge**, cannot push. Read at origin/main `8d99f05` (05:54:15Z),
unchanged through the pass. Fired by `trig_01AZzLzkTPp5xbSjK1EFmeCw` — the superseded duplicate task.

## The one-line version

`backfill-allday-dist-opened` picks its work with `allday_pack_supply.opened_count IS NULL` and then
fills `opened_count`. It can therefore only ever run **once per row, forever**. It finished on
**2026-06-30** and has returned `{"done":true}` on roughly **22,700 dispatches** since, while 175 AllDay
distributions took **1,656 pack opens** that never reached the public depletion numbers.

## Three things this cost, worth remembering separately

**1. A self-extinguishing predicate is invisible to every "is it running?" instrument we own.** pg_cron
said *succeeded* 22,700 times, because `net.http_get` really was dispatched. The edge function returned
HTTP **200** every time, because `{"done":true}` is a legitimate answer. It writes **no `pipeline_runs`
row**, so `detect_stalled_pipelines()`, `get_pipeline_alerts()` and the daily rollup cannot see it at
all. **The only observable was a timestamp column that stopped moving, and nothing read it.** The class
to look for: a backfill whose candidate query filters on the column it writes, with no staleness leg.
Its healthy state and its dead state are byte-identical from outside.

**2. `{"done":true}` is also what a failed query returns.** The candidate select's error is never
checked, so a Supabase error returning no rows produces the same body as genuine completion. A
completion signal that is indistinguishable from an error is not a completion signal.

**3. The freeze was two months old and the direction was always the same one.** Depletion was
**understated** on all 175 — 6369 published 93.4% against a true 98.3%. A pack that is 98% ripped
looking 93% ripped is the error that reads as *"there is still supply"*.

## What made the repair safe, and is worth copying

- **Positive control before the destructive step.** The function's own `?mode=probe&dist=` path was
  called first: `{"opened":{"ok":true,"total":6877},"total":{"ok":true,"total":6999}}`. Had the upstream
  leg been dead, nulling `opened_count` would have left 175 public rows **blank** instead of slightly
  stale — strictly worse. The probe is what turned "probably fine" into "measured".
- **Two independent instruments agreeing to the unit.** Dapper's live count minus our stored value
  equalled this repo's own `pack_rips` count for the same window — 343 on dist 6369 before the fix, and
  **1,656 across all 175 dists** after it. Neither instrument feeds the other. That is stronger evidence
  than any single re-read.
- **The pre-image was snapshotted into an audit table first**, so the revert is one `UPDATE … FROM`
  rather than a re-fetch.

## ⛔ It has already re-frozen

The repair used the deployed function exactly as written, which means the predicate is unchanged and the
candidate set is empty again. **The permanent fix is one line** — swap `opened_count IS NULL` for a
staleness window on `opened_updated_at` — and this session must not ship it, because the function's gate
is a **hardcoded string literal in the deployed source** rather than a `GATE_KEY` env secret, so
redeploying would pass that literal through a transcript. Operator work. Anything that re-hydrates in the
meantime is a manual repeat of tonight's migration.

## Two smaller things found on the way

- **24 of the 175 distributions have no `pack_distributions` row at all** (`allday_pack_supply` holds
  3,195 dists, `pack_distributions` 3,052 for AllDay, 3,018 joining). Their corrected `opened_count` can
  never reach `pack_distributions.total_opened`, so any surface reading the table rather than the view is
  permanently blind to them. Not investigated further tonight; recorded so it is not rediscovered.
- **`sync_allday_pack_dist_totals` reads a 25-column analytics view to copy two columns off a 2 MB base
  table** — 751,329 buffers/call against 1,162 for the direct form, **646×**, hourly, ~18.0M buffers/day.
  Measured both ways with identical candidate sets. Not shipped: the function is a registered
  drift-guard **pin**, and re-pinning is a three-file change no cloud session can complete. The full
  measurement and the candidate body are in the handoff.
