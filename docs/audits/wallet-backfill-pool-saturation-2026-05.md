# Wallet-backfill pool-saturation — sync-mode verification (post bc63612)

**Date:** 2026-05-11
**Deploy:** [`bc63612`](https://github.com/jamesdillonbond/rip-packs-city/commit/bc63612) READY 2026-05-10 23:28 UTC.
**Round:** 7 Item 6 fix, verified Round 8 Item 1.

## Success criterion

> At the next 00:00/06:00/12:00/18:00 UTC cron tick, query pipeline_runs for the 5-minute span starting HH:05
> and confirm pinnacle-nft-resolver + sync-flowty-listings both show ok=true (no pool exhaustion artifact).

The 2026-05-11 06:00 tick (first full post-deploy 6h tick) is the verification window. Three findings.

## Primary criterion: PASS

| Pipeline | Runs in 06:00→06:15 | ok=true | Errors | Comment |
|---|---:|---:|---|---|
| `pinnacle-nft-resolver` | 4 | 4 | 0 | All ok. Durations 3.5s → 91s → 11.7s → 4.0s. The 91s run is the immediate-post-burst tick at 06:05 — well under maxDuration and no pool-timeout signature. |
| `sync-flowty-listings`  | 4 | 4 | 0 | All ok. Durations 145s → 96s → 2.8s → 0.4s. Pre-deploy this was a frequent "canceling statement due to statement timeout" / pool-exhaustion victim. |

Both pipelines completed cleanly in the HH:05 window. The pool-saturation cascade that was knocking these two
out at HH:05 across earlier audits is gone after bc63612.

## Secondary finding 1: wmc-fmv-populate one-off timeout

`wmc-fmv-populate` at 2026-05-11 06:00:42 UTC for the TopShot collection ran for 283s and failed with
`upstream request timeout` (`rows_updated: 0`). The 06:20 retry succeeded for all 5 collections in <12s
total (TS in 1.8s, AllDay 11.2s, Pinnacle 2.6s, Golazos 0.2s, UFC 1.5s).

Not a pool-saturation signature — that would surface as `canceling statement due to statement timeout` from
Postgres. `upstream request timeout` is a Cloudflare/Vercel edge timeout, most likely from the TS proxy worker
or the editions-join RPC. One-off; next tick recovered. Not blocking Item 1.

Worth a watch entry: if TS `wmc-fmv-populate` recurs with the same signature at future ticks (especially the
ones immediately post-multicollection-burst), revisit.

## Secondary finding 2: Golazos + UFC fan-out gap at 06:00 (NEW regression)

This finding is **not** in the prompt's success criterion but emerged while validating the orchestrator's
overall health. It is real and is caused by the bc63612 multicollection rewrite.

| Tick | wallet-backfill (TS) | wallet-backfill-allday | wallet-backfill-pinnacle | wallet-backfill-golazos | wallet-backfill-ufc |
|---|---:|---:|---:|---:|---:|
| pre_12h (2026-05-10 12:00) | 51 | 186 | 187 | 43 | 38 |
| pre_18h (2026-05-10 18:00) | 24 | 205 | 201 | 45 | 37 |
| **post_00h** (2026-05-11 00:00) | 42 | 191 | 170 | 42 | 31 |
| **post_06h** (2026-05-11 06:00) | 30 | 200 | 203 | **0** | **0** |

The 00:00 tick (first post-deploy run) worked correctly across all five children. The 06:00 tick (second
post-deploy run) has zero `wallet-backfill-golazos` and zero `wallet-backfill-ufc` `pipeline_runs` rows in
the entire 06:00 → 06:39 UTC window (verified against `now()=06:39:28 UTC`). Pre-deploy ticks (12h, 18h) had
the steady 40-ish-row pattern for Golazos and UFC.

Per `runIdOnlyBackfill` ([lib/wallet-backfill-helpers.ts:315](../../lib/wallet-backfill-helpers.ts#L315)), every
exit path writes a `pipeline_runs` row (success, no-IDs, storage-limit, no-capability, generic error). So the
0-row count at 06:00 means the Golazos/UFC after() worker never executed — the orchestrator's
`Promise.all(FIRE_AND_FORGET_COLLECTIONS.map(fireOnce))` never dispatched to those two routes for any wallet
at that tick.

AllDay + Pinnacle sync-mode at the same 06:00 tick: 200 + 203 rows, all `ok=true`, all `mode='details_allday'`
/ `mode='details_pinnacle'` (199) + `mode='details_pinnacle_paginated'` (4). Zero `soft_deadline`. The
sync-poll round-trip logic was never even exercised because the single-shot single-call path completed in <30s
for every wallet that fired.

### Diagnostic hypotheses (not fixed in this commit)

1. The orchestrator's `after()` task does `await Promise.all(fire...)` THEN the sync `for-await` loop. Fire
   runs first. Each `fireOnce` has a 10s timeout. Should always complete in <10s. Unless the Golazos/UFC
   routes themselves were unreachable at the 06:00 burst (cold-start storm?) and `AbortSignal.timeout(10_000)`
   killed all 200+200 calls.
2. The 00:00 tick had 42+31 rows but the 06:00 tick had 0+0 — same code, same orchestrator. The variable is
   the load profile. At 06:00 there may have been more mega-wallets needing AllDay/Pinnacle work, pushing
   the multicollection lambda's after() task past a budget that wasn't an issue at 00:00. But Promise.all is
   awaited FIRST in the code so it should have already completed before sync polls started.
3. Cron-job.org may have an independent schedule for the fire-and-forget side that's broken — not visible in
   the pipeline_runs data, only in cron-job.org's UI.

### Recommended follow-up (separate item)

- Add a `pipeline_runs` row from the orchestrator itself (currently nothing logs when multicollection runs).
  Without that, every dispatch failure is invisible — we can only infer "the after() task didn't reach the
  fire-and-forget side" from negative space.
- Wrap the orchestrator's `Promise.all(fire)` and `for-await(sync)` in a try/catch with a final summary
  pipeline_runs row pinning `{wallet, fire_results: [...], sync_results: [...]}`.
- If after observability arrives the gap persists, swap the order: dispatch fire-and-forget BEFORE awaiting
  any sync poll. Today's code already does this on paper — the regression must be elsewhere.

## Conclusion

Primary verification PASSES: the original pool-saturation symptom (pinnacle-nft-resolver +
sync-flowty-listings being knocked out at HH:05) is gone after bc63612. The sync-mode AllDay+Pinnacle path
worked correctly at the 06:00 tick — 100% ok=true, single-shot single-round-trip for every wallet.

A new regression in the Golazos+UFC fire-and-forget fan-out surfaced at the same 06:00 tick. This was
introduced by the bc63612 rewrite of `wallet-backfill-multicollection`. It is independent of the
pool-saturation fix. It belongs in the next round as a separate item — diagnostics, then fix.
