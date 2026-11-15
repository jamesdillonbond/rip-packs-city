# Claude Code → Cowork/Trevor: #248 fast-lane fix FAILED its pre-registered cost bar — revert staged, NOT applied (needs a yes)

## ✅ RESOLVED — 2026-11-15 ~1:00 PM PT (Claude Code cloud; Trevor: "Do what you think is best") — NOT reverted; the fix stays, job 617 stays daily, the 446 writer is fixed

The 7,195 bar judged the fast lane alone, but the fix exists so its backstop can run 12× less often. Across the estate:
- **Added by the fix:** (9,146 − 4,609) reads/call × 288 PostgREST calls/day ≈ **+1.3M disk reads/day**.
- **Removed by job 617 going daily:** 11 fewer runs/day. pgss lifetime average 140,026 reads/run; ~395k measured 11-14. That is **−1.5M to −4.3M reads/day**.
- So **net ≤ 0 or better**, and the miss rate stays at 0.15 % instead of going back to 0.8 %. The revert would cost the misses and save no IO once 617 returned to 2-hourly.
- **Shipped instead:** `20261115204212`. `reconcile_wmc_fmv_for_wallet` (job 446) no longer writes `edition_fmv_current`'s older value over one the lane pushed after its last refresh. 81 editions were matched at apply.
- The staged revert files were deleted. Revert path, if ever needed, is unchanged: re-apply `20260830144724`, then reverse `20261115175130`.

**Filed:** 2026-11-15 ~12:40 PM PT by Claude Code cloud (scheduled #248 24-hour watch). **Owner:** Trevor decides; Cowork applies (Chrome → Supabase SQL editor; repo push). **Severity:** LOW–MEDIUM (an IO-cost regression, not an outage).
**Why not applied:** `apply_migration` raised Supabase's destructive-statement question at ~12:36 PM PT and nobody was there to answer it (scheduled run), so **nothing was applied**. Verified after: live `md5(prosrc)` still `fc41b0b8c2d75806f1bf6905e01e192c` (the 11-14 body), job 617 still `33 12 * * *`, watchlist still 1560.

## The measurement (pg_stat_statements deltas, `service_role` −2064728835023368966 = the `/api/wmc-fmv-populate` route)

The 11-14 fix's revert rule: in a quiet window ≥ 1 h, reads/call above the 08-28 bar (7,195 PostgREST / 74,159 pg_cron) → re-apply `20260830144724`.

| window (PT, 11-15) | calls | reads/call | buffers/call |
|---|---|---|---|
| 8:49 → 9:50 AM (other session) | 12 | 5,907 | — |
| 9:33 → 10:34 AM (other session; same calls as my 9:41 → 10:43) | 12 | 12,324 | 101,558 |
| 10:43 → 11:43 AM | 13 | 6,979 | 62,226 |
| 11:43 AM → 12:34 PM | 10 | 9,062 | 76,553 |
| **pooled 9:33 AM → 12:34 PM (3 h)** | **36** | **9,146 (+27 % over the bar)** | **77,603** |
| pre-apply 11-14 | 12 | 4,609 | 36,901 |

- One-hour windows swing ~2× because a few heavy ticks carry the cost. Every window of 2 h or more is over the bar, and so is the 23 h pooled rate (8,266).
- The read share of buffers is ~12 % in every window and in the pre-apply one. So the excess is **work** (2.1× the blocks touched), not a colder cache.
- `cron_heavy` (job 303) stays under its bar: 8,869 reads/call pooled.
- A ≥ 3 h window is what the 10:40 AM entry in #248 asked for before reverting.

## The trade (what a revert gives back)

- The fix bought fast-lane misses of **0.8 % → 0.11–0.15 %** of wallet rows.
- Most of the misses that remain are a different writer: job 446 (`reconcile_saved_wallets_wmc_fmv`) copies `edition_fmv_current`, which only refreshes at :59. So it writes the old price back over the lane's new one, and `rwfc_applied` then hides that row from the lane. Details are in #248.
- Fixing 446 is independent of this revert either way.

## To apply (if Trevor says yes)

1. Run `docs/proposals/rwfc-revert-to-0830-body-STAGED.sql` in the SQL editor. It is guarded on both ends: the live md5 must be `fc41b0b8…` before, and the installed body must be `80f04618…` (the 08-30 body) after. In the same transaction it puts job 617 back to `33 */2 * * *` and the `wmc-fmv-stuck-resync` watchlist row back to 183/366. 617 must return, because the misses it heals come back to ~0.8 %. It was still fixing ~7,040 rows per 2-hourly run before it moved to daily at 9:51 AM.
2. Repo half, one push:
   - Move the SQL to `supabase/migrations/<applied version>_audit_20261115_rwfc_revert_to_0830_body_cost_bar.sql`.
   - Replace `supabase/tests/refresh_wmc_fmv_changed.sql` with `docs/proposals/rwfc-revert-to-0830-body-PIN-STAGED.sql.txt`. That is the 08-30 pin, verbatim from `3511b5627^`.
   - In `__tests__/db-invariants-drift-guard.test.ts`, re-point the `refresh_wmc_fmv_changed` pin's `migration:` to the new file. Keep the comment ABOVE `migration:`.
3. Ledger, then #248.

**If Trevor says no** (keeps the fix and accepts the IO): close the cost leg in #248 with "accepted at ~9.1k reads/call, +27 %", and delete the two staged files.
**Revert of the revert:** re-apply `20261114171317`, then `20261115175130`.
