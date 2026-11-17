# candy-editions-ingest missed its 08-27 22:10Z tick — first miss since the 08-22 move to the quiet slot

**Filed:** 2026-08-28T0310Z (daytime monitor, 20:06 PT tick). **Written to mount, push unavailable** (NO-PUSH cloud session: `remote.origin.pushurl` empty, `url` carries no auth — same limitation as the 08-27 night pass).

**Risk read:** LOW / re-measure. One missed tick is not a trend, and there is no user-facing coverage loss *yet*. Filed so the night pass checks the next tick rather than skims past a note that reads "fixed."

## What was observed (measured, not inferred)
`pipeline_runs` for `candy-editions-ingest`, last rows:
- 2026-08-25 22:10:18Z — ok, 28,483 rows
- 2026-08-26 22:10:25Z — ok, 28,483 rows
- **08-27 22:10Z — NO ROW.** Now ~29 h silent (last run 08-26 22:10Z vs now 08-28 03:06Z).

`rpc_ops_snapshot()` fired the `cron_silent` arm ("Last run > 24h ago — expected within 1800 min", severity medium). It was NOT firing at the 08:05Z night pass because the last run was then only ~10 h old.

## Why this is new information
The 08-22 ship moved the Vercel cron `40 8 * * *` → `10 22 * * *` specifically to get the job out of the 01:00–19:00Z disk-IO band, and the watchlist note + ledger now read that as the fix (superseding "NOT FIXED"). 22:10Z is inside the quiet window, and the first two runs there (08-25, 08-26) succeeded. **The 08-27 miss is the first failure at the new slot** — so it either means (a) a one-off Vercel cron miss / a single kill (the route logs to `pipeline_runs` only on completion, so a killed run leaves no row and reads as silence), or (b) the 22:10Z slot is not reliably safe either. n=1 cannot distinguish these.

## Not-yet-user-facing (controls)
Candy price/coverage is fresh at capture: `candy_fmv_stale_hours` 0.2 (ok), `candy_sales_stale_hours` 3.4 (ok), `candy_fmv_pct_stale_30d` 0 (ok). Editions change slowly — rows_written has been byte-identical at 28,483 every run — so a single missed editions refresh does not degrade any live surface today. This is why severity is medium, not high.

## Suggested action (night pass) — RE-MEASURE, do not conclude
1. Check whether the **next** scheduled run (08-28 22:10Z) lands. If it succeeds, this was a one-off miss — annotate and close.
2. If 08-28 also misses, the quiet-slot move is not sufficient on its own, and the durable fix is the already-identified **lever (b): `paginateGroup` chunking** from `docs/handoff-2026-08-04-candy-editions-timeout.md` Item 2 (ingest-route logic — needs a push; off-limits for unattended auto-ship, so it's an operator/decision item, not a night auto-ship).
3. Optional cheap corroboration: a Vercel runtime-error check for `Task timed out` on `/api/ingest/candy-editions` at ~22:10Z on 08-27 would distinguish a kill (lever-b territory) from a cron that never fired (Vercel-side).

⛔ Do NOT raise the 1800m threshold and do NOT re-point the arm — the arm is correct; it caught a real missed tick. The watchlist note already carries the full 08-22 history.
