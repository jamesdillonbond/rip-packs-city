> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# Inbox — 2026-09-01T04:58Z (cloud pass)

## 1. ⛔ The obvious port of last night's biggest win would silently stop refreshing 1,133 wallets

`refresh_wmc_fmv_changed` still carries the anti-pattern that `refresh_wmc_fmv_drift_active` was fixed for
on 08-31, and each function's source tells you to check the other when editing one. It is worth
~6.8 GB/day. **But the fix is a scope change, not a plan change**: `drift_active` is by definition scoped
to the 26 allow-listed wallets, while `_changed` is the general refresher. `wallet_moments_cache` holds
2,506,331 rows across **1,159 distinct wallets**; the 26 active own 8.1%. The port would look like a ~4×
win on the pgss diff and be a stale-price regression on 91.9% of the cache. **Declined on accuracy.**

## 2. ✅ A post-ship "correction" was itself a cold-index artefact

The 04:30Z pass downgraded the drift_active win from 1.94× to ~26% off n=4 — taken 25 minutes after a
175 MB `CREATE INDEX CONCURRENTLY`. At n=11 on a provably post-ship window it is **1.87×**, and calls 5–11
alone run at 12,891 blocks/call vs 30,993 pre-fix. **Mirror of an existing ledger rule: do not measure a
candidate in a state its baseline never occupied.** A cold new index is such a state.

## 3. ⓘ The pass's own EXPLAIN is a top-ten consumer of the instance

`explain (analyze, buffers, verbose)` of the `get_allday_unresolved_pulls` body cost **128,334 blocks** —
the same as a real production call (128,340). Second time the saturation programme's own instrument has
ranked on its own board. The lever is derived; do not re-run it.

## 4. 🚨 This pass was the duplicate task, again

Fired 04:58Z, 28 minutes after the other task's 04:30Z run. `trig_01AZzLzkTPp5xbSjK1EFmeCw` (`58 */2`) and
`trig_018AyNcnbCZuYb1Ztts6rbBR` (`18 */2`) are both enabled and both unbound. Third pass raising it;
deletion needs Trevor's approval.

## 5. ⓘ Task prompt thread #15 is stale

"Scheduling the pgss snapshot is queued for Trevor" — already shipped 08-31 as `ops_pgss_snapshot()` on
`5 */2 * * *` plus `ops_pgss_delta(interval, int)`. Use the delta reader; it stamps `baseline_age`, which
is what made this pass's post-ship claim provable.
