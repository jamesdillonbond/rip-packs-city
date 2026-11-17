> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T20:18Z — the queued index drop would have turned its own verify function into a hard ERROR

**Pass:** cloud, 20:18–20:26Z (13:18–13:26 PT). Fired by `trig_018AyNcnbCZuYb1Ztts6rbBR`. No device bridge, no push.
**Repo read:** `origin/main` `9f12fca` @ 20:19Z. **DB `now()`** 20:19:05Z.
**Status:** SHIPPED — `20260901202259_audit_20260901_wmc_reindex_verify_tolerates_an_absent_target_index`.

## The finding

Two previous passes (18:18Z, 18:58Z) queued `DROP INDEX CONCURRENTLY public.idx_wmc_cohort_cover` for the 02:00–04:00Z quiet band, with the exit condition *"re-run `run_wmc_reindex_verify()` 24 h after the drop"*.

`run_wmc_reindex_verify()` hard-codes that index name in a `FOREACH … ARRAY[…]` and measures each one with `extensions.pgstatindex(('public.' || v_idx)::regclass)`. **`::regclass` raises 42P01 when the name does not resolve.** So the moment the queued drop lands:

- the function ERRORS instead of returning `ok:false`;
- its `cron_heavy` caller fails;
- **no `wmc-reindex-verify` row is written to `pipeline_runs` at all** — the monitor goes **dark**, not red;
- and the exit condition the drop was queued with cannot be executed.

⭐ This is the same lesson open thread 14 already records — *read the verify function's target LIST before the window closes* — applied to a **drop** rather than a build. It was found by checking the queued action against the function's own source, not by running anything.

## The fix (shipped)

`to_regclass` guard per target. An absent target is recorded as `{"index": …, "status":"absent"}`, counted in `rows_skipped`, and does **not** set `ok=false` — a deliberately dropped index has no leaf density to be under 60 %. The INVALID `*_ccnew` scan and the <60 % test on surviving targets are unchanged. `rows_found/written/skipped` now derive from the target array instead of a hard-coded `4, 4, 0`.

**No behaviour change today** — all four targets exist, so the 20:23:16Z run returned the same `4 / 4 / 0`, `ok:false`, `absent:[]` as the 18:30:46Z row. The absent branch was separately hand-evaluated in a `DO` block against a bogus index name (`measured=1, absent=1`, no raise).

## What did NOT ship, and why

The drop itself. DB `now()` was **13:19 PT — peak write band**, and the 18:18Z pass made a deliberate same-day decision to hold it for 02:00–04:00Z. The evidence is now stronger, not weaker: `idx_wmc_cohort_cover`'s `idx_scan` read **12,042 at 18:23Z, 19:04Z and 20:21Z — zero scans in 118 minutes** — while `idx_wmc_wallet_coll_ek_fmv`, which strictly covers it with an identical INCLUDE and is **46 MB smaller**, took **+187,079** scans in ~80 minutes of that span.

## Amended exit condition for the drop

The old one is unexecutable even after this ship (an absent target now reports rather than fails). 24 h after the drop, require: total index bytes on `wallet_moments_cache` **~299 MB below** the same-hour reading the day before; `run_wmc_reindex_verify()` returns `absent:["idx_wmc_cohort_cover"]`, `rows_skipped=1`, **and does not raise**; no `wallet_moments_cache` query in `ops_pgss_delta` regresses on blocks/call.

## Two things worth carrying forward

1. ⛔ **This task is not device-bound**, despite its name and its stored prompt both saying so. `ToolSearch` found no `mcp__remote-devices__*` tool; `git push --dry-run` was proxy-denied. Both autonomous-pass tasks are unbound. The duplicate `trig_01AZzLzkTPp5xbSjK1EFmeCw` (`58 */2`) is still enabled — `update_trigger(enabled=false)` was refused with "MCP tool call requires approval" for the **second** time, by a second independent run.
2. ✅ **`check-migration-parity` is CLEAN**, derived fresh by NAME over 13 register rows vs 820 committed filenames. The four migrations the 18:58Z pass stranded were recovered and pushed by `rpc-migration-autorecover[bot]` at 19:54Z, byte-exact (three spot-checked with plain `md5sum`). The containment loop cleaned up after a stranded pass with nobody in the loop.
3. ⚠ **Vercel `level=error` line retrieval timed out on every scoping tried** (3 h, 60 min, single deploymentId). `group_by` counts still answer: 111 × 502 all on `/api/public/ipfs-media/[cid]`, 2 × 500 on `/api/wallet-search`, ~6,208 requests, and **35 error-level lines that I could not read**. Not claiming clean.
