# RPC Claude Code — wire the recurring on-chain drain (the one remaining mis-attribution piece) (2026-06-21)

The TS sales mis-attribution bug is fixed (writer fix `f796447`, one-time drain `f908c83`, fmv-recalc converging). Two DB fixes were added autonomously from Cowork this session (both verified, both reversible):

- **Guard-refresh route is now fast** — `audit_20260621_conflated_refresh_detector_only_fast` redefined `refresh_topshot_conflated_editions()` to delegate to `refresh_topshot_conflated_editions_detector_only()` (dropped the redundant self-healer scan that was blowing the 120s budget and timing out the daily cron 7869080). Runs instantly now; security/anon clean. Revert: re-add `PERFORM public.remap_misattributed_topshot_sales();` at the top of the body.
- **DB self-healer now runs on its own schedule** — pg_cron job `rpc-remap-misattributed-sales` (jobid 7, `23 */6 * * *`) runs `remap_misattributed_topshot_sales()` then refreshes the guard, decoupled from the route's 120s cap. It converges the **wmc-resolvable** transients (it just re-keyed 150 that had accumulated; it's fast now post-drain). Revert: `SELECT cron.unschedule('rpc-remap-misattributed-sales');`.

## The one remaining gated piece — the untracked residual
Measured now: the guard sits at ~17 editions / 44 colliding nfts = **22 genuine + 22 untracked-wallet strays, and `stray_self_healable` = 0**. The DB self-healer has converged everything it can; the 22 strays are moments held by untracked wallets (no `wmc` truth), so they need on-chain `getMintedMoment`. They're suppressed from the boards meanwhile (safe), and forward churn will keep adding a small untracked trickle.

**Wire `/api/admin/drain-topshot-misattribution?rekey=1` as a daily VERCEL cron (not cron-job.org).** The route's own header is explicit: cron-job.org's 30s cap kills the on-chain calls; a Vercel cron waits for the full `maxDuration`. Auth: the deployed route auto-injects `X-Proxy-Secret`, and a Vercel cron supplies `CRON_SECRET` — so it just works server-side (this is exactly why it can't be triggered from a local/MCP session). Add it to `vercel.json` crons at a low cadence (daily is fine; the residual is small + suppressed).

After it runs: it re-keys the untracked strays to on-chain truth, the pg_cron self-healer + detector refresh the guard, and the guard trends to 0 over a few days. Then `fmv-recalc` the drained editions (the normal sweep + force-stale cover them). Verify: `SELECT count(*) FROM topshot_conflated_editions` trends to 0; re-run the colliding-nft classification (this session's query) — `not_in_wmc_need_drain` → 0.

## Not action items (status only)
- **fmv-recalc tail** (~1,386 stale of 4,713 affected): auto-completing via the "RPC FMV Recalc Force Stale" cron (`/api/fmv-recalc?force_stale=true`, every 20 min, ~307s/run); 71% done, finishes within ~1–2 hours. No action.
- The writer fix + one-time drain are shipped and verified (guard was 0, sales_on_uuid 0, all-time collisions ~0 right after CC's drain; the current ~17 is forward churn the above two mechanisms converge).

Guardrails: direct-to-main, PowerShell git, rev-list 0, tsc clean; `maxDuration` ≤ 800 (Pro cap). Update CLAUDE.md + the ledger.
