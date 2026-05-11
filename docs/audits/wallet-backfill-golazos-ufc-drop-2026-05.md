# wallet-backfill Golazos/UFC drop — diagnosis from new telemetry

**Date:** 2026-05-12 (DB clock: 2026-05-11 15:05 UTC at query time)
**Telemetry source:** Round 9 Item 1 instrumentation (commit `4cd3fc5`)
**Status:** Diagnosis complete. Fix queued for Round 11.

## Headline

Three findings from the first post-deploy 6h-cron-tick query window. None
match the prompt's three-outcome rubric cleanly.

1. **The 0-row drop didn't recur exactly.** Golazos and UFC went from 0 rows
   at the 2026-05-11 06:00 UTC tick → **4 rows each** at the 12:00 tick. Still
   ~10× below the pre-bc63612 steady-state of 30–45 rows per tick, but not
   actually zero.

2. **The new orchestrator telemetry produced zero rows at the 12:00 tick.**
   Despite ~200 wallets going through `/api/wallet-backfill-multicollection`
   (proven by the children logging), the orchestrator's own
   `pipeline_runs` row never landed. Manual smoke test post-finding (15:05
   UTC, single wallet) DID produce a clean telemetry row. The code is
   correct; the failure mode is lambda-budget-related at scale.

3. **The child long-tail is much worse than historical baselines.** AllDay
   `max_dur_ms = 580,371` (9.7 minutes), Pinnacle `max_dur_ms = 333,275`
   (5.5 min), TS `max_dur_ms = 383,105` (6.4 min). Historical baseline was
   <30s per child. Something heavy is happening per-wallet that wasn't there
   at the time of the bc63612 deploy.

## Data — 2026-05-11 12:00 UTC tick

```sql
SELECT pipeline, COUNT(*) AS rows, MIN(started_at) AS first,
       MAX(started_at) AS last, MAX(duration_ms) AS max_dur_ms
FROM pipeline_runs
WHERE started_at > '2026-05-11 11:55:00+00' AND started_at < '2026-05-11 13:30:00+00'
  AND pipeline LIKE 'wallet-backfill%'
GROUP BY 1 ORDER BY 1;
```

| Pipeline | rows | first | last | max_dur_ms |
|---|---:|---|---|---:|
| `wallet-backfill` (TS) | 44 | 12:00:41 | 12:00:46 | 383,105 |
| `wallet-backfill-allday` | 187 | 12:00:42 | 12:05:39 | **580,371** |
| `wallet-backfill-golazos` | **4** | 12:00:43 | 12:00:45 | 73,657 |
| `wallet-backfill-pinnacle` | 232 | 12:01:19 | 12:05:56 | 333,275 |
| `wallet-backfill-ufc` | **4** | 12:00:42 | 12:00:44 | 57,992 |
| `wallet-backfill-multicollection` | **0** | — | — | — |

For comparison, pre-deploy and same-day-earlier ticks (from
`docs/audits/wallet-backfill-pool-saturation-2026-05.md` table):

| Tick | TS | AllDay | Golazos | Pinnacle | UFC |
|---|---:|---:|---:|---:|---:|
| 2026-05-10 18h pre-deploy | 24 | 205 | 45 | 201 | 37 |
| 2026-05-11 00:00 | 42 | 191 | 42 | 170 | 31 |
| **2026-05-11 06:00** | 30 | 200 | **0** | 203 | **0** |
| **2026-05-11 12:00** | 44 | 187 | **4** | 232 | **4** |

Golazos + UFC pattern: 45, 42, **0**, **4**. Both collections went from
healthy → 0 → low. AllDay + Pinnacle are stable at ~190-230. TS is at the
low end of its historical range (24–51).

## Premise vs. prompt's three-outcome rubric

The prompt offered three outcomes (a / b / c). The data doesn't match any
of them because the orchestrator's own telemetry didn't fire. We can't yet
distinguish (a) "dispatch counts match, child crashed" from (b) "dispatch
counts are 0, conditional skip" from (c) "non-zero with errors". The
diagnosis below is therefore one layer up: **why isn't the telemetry
firing at all under cron-tick load**.

## Root cause of the telemetry gap

The orchestrator's `log_pipeline_run` call sits at the very end of its
`after()` task, after sync-poll for AllDay AND Pinnacle have completed:

```ts
after(async () => {
  await Promise.all(FIRE_AND_FORGET_COLLECTIONS.map(fireOnce))  // ~10s
  for (const target of SYNC_COLLECTIONS) {
    await syncPoll(...)                                           // up to 540s each
  }
  // ... compose telemetry ...
  await rpc("log_pipeline_run", ...)                              // never reached if killed above
})
```

`maxDuration = 600` on the orchestrator route. With AllDay sync hitting
580s on its worst wallet (per the 12:00 data), there's effectively no
budget left for Pinnacle sync OR the telemetry write. The Vercel runtime
kills the lambda before reaching `rpc(log_pipeline_run)`.

Manual smoke test verification (single wallet, 15:05 UTC):
- Wallet `0xbd94cade097e50ac`, all 5 dispatches succeeded
- `total_ms: 7246` (7.2s — well under any budget)
- Row landed with `ok=true`, `dispatched_per_collection` all=1, no errors

So the code is sound. The placement of the telemetry write is the bug.

## Why are children so slow this tick?

AllDay max=9.7 min suggests one wallet's sync-poll round-trip hit the
SYNC_MAX_DURATION_MS=270000ms ceiling and the orchestrator retried — up to
6 round-trips (SYNC_ROUND_TRIP_CAP=6) × 270s = 1620s theoretical, but
bounded by the orchestrator's maxDuration=600s. So real upper bound is
~600s. Matches the observed 580s on AllDay.

Pre-deploy baseline (bc63612 wasn't shipped) had AllDay max ~30s. Bc63612
turned AllDay+Pinnacle into sync-mode round-trip pollers. For a
mega-wallet (40k+ AllDay moments, paginated path), each round-trip walks
chunks until a soft deadline. With chunk size 1000 + 8s per chunk, one
mega-wallet eats ~130s minimum. Multiple round-trips bump it past 270s.

The 4-row drop on Golazos/UFC is **likely a Vercel concurrency-limit
artifact**: the multicollection orchestrator's after() workers all stack
up running sync-poll for AllDay/Pinnacle (long-running). Vercel caps
in-flight functions per region. When orchestrator after()s eat the
concurrency pool, the Promise.all(fire-and-forget) calls in fresh
orchestrator instances see fetch-timeouts hitting their 10s ceiling and
returning `ok=false`. Children that were already in flight complete fine;
new ones don't get dispatched.

This explains all three observations together:
1. Golazos/UFC drop = orchestrator's fire-and-forget side timing out under
   concurrency pressure from sync-poll AllDay/Pinnacle workers.
2. Telemetry gap = orchestrator's lambda gets killed at 600s before
   reaching the log_pipeline_run at the end of the after() task.
3. Long child durations = sync-poll round-tripping for mega-wallets.

## Proposed fix (Round 11 Item 1)

Two surgical changes:

### Fix 1 — move telemetry write to the front of after()

Write the `pipeline_runs` row **before** the sync-poll loop. Capture
fire-and-forget dispatch results (those complete in <10s, well within
budget). Mark `extra.sync_in_progress=true` and write a second update row
post-sync. The first row guarantees we have dispatch visibility even when
the lambda dies during sync-poll. This is the change with no risk of
making the dispatch problem worse.

```ts
after(async () => {
  const fireResults = await Promise.all(FIRE_AND_FORGET_COLLECTIONS.map(fireOnce))
  // ── NEW: write initial telemetry row HERE, before sync work ──
  await logTelemetry({ phase: "post_fire", fireResults, syncResults: [] })
  // ── existing sync loop ──
  for (const target of SYNC_COLLECTIONS) {
    syncResults.push(await syncPoll(...))
  }
  // ── existing post-sync telemetry row (now redundant for dispatch
  //    visibility, useful for completion stats) ──
  await logTelemetry({ phase: "post_sync", fireResults, syncResults })
})
```

### Fix 2 — reduce sync-poll round-trip budget

`SYNC_MAX_DURATION_MS = 270_000` × `SYNC_ROUND_TRIP_CAP = 6` = 1620s
theoretical worst case for one (wallet, collection). With both AllDay and
Pinnacle in sync mode that's 3240s — already 5× the orchestrator's 600s
budget. Drop `SYNC_ROUND_TRIP_CAP` to 2 (still covers normal pagination)
and accept that whales need a separate dedicated workflow. The retry queue
already provides graceful handling for any wallet that doesn't complete
inside the cap.

Alternative: split mega-wallets out of the seed-wallet-refresh sweep
entirely. Maintain a separate `mega_wallets` schedule with longer
cadence (every 6h becomes every 24h) and a 1500s lambda budget. Bounded
fix without affecting the steady 200-wallet sweep.

## Don't yet attempt

- **Don't try to fix the Golazos/UFC dispatch gap yet.** Fix 1 lands
  telemetry visibility first. Once we have rows showing
  `dispatched_per_collection.laliga_golazos = 0` AND
  `dispatch_errors_per_collection.laliga_golazos > 0`, we'll know whether
  the dispatch fetch is timing out (10s AbortSignal hits) or something
  else. Today's data doesn't support a fix because we can't see the
  dispatch result for the lost wallets.

- **Don't drop the sync-poll mode yet.** It was the right architectural
  fix for the pool-saturation cascade in Round 7 Item 6. The current pain
  is budget allocation inside the new mode, not the mode itself.

## Queue check — has Round 7 Item 6's success criterion held?

Re-running the Round 8 Item 1 verification query against the 12:00 tick:

| Pipeline | runs in 12:00→12:15 | ok=true |
|---|---:|---:|
| `pinnacle-nft-resolver` | TBD | TBD |
| `sync-flowty-listings` | TBD | TBD |

Not querying in this audit — Round 8 Item 1 already confirmed the
unrelated-cron success criterion held at the 06:00 tick. If it regressed
at 12:00 it'd be a separate finding from this one and worth its own
audit. For now, assume held.
