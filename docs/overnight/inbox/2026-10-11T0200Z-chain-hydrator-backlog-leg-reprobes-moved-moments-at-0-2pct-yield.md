# The chain hydrator's backlog leg re-probes moved Moments at a 0.2 % yield — 20,896 scripts a week for 51 rows

- **Filed:** 2026-10-10 ~7:00 PM PT (Cowork cloud, "keep going" pass; read-only finding, nothing changed on the lane).
- **Spell check:** not spell-observed — a count over 7 days of `topshot_moment_hydrate_requests`, not a timing.

## What

`topshot_moment_hydrate_tick(30)` (pg_cron 469, `3-59/4`) runs two dispatchers: `_dispatch_head` (pulls < 3 days old, since `20260924043605`) and `topshot_moment_hydrate_dispatch` (the newest-first cursor walk over every verified Top Shot `pack_pull`, 3,000 examined / 30 dispatched a tick). Each dispatch asks the **puller's** wallet to `borrowMoment(id)`; a Moment that has since sold or moved panics `no nft`, the drain files it `no_nft`, and the dispatcher skips that nft for **30 days**, then asks the same wallet again.

Measured over the 7 days to 2026-10-10 6:57 PM PT (`topshot_moment_hydrate_requests` joined to the pull's `acquired_date`):

| pull age at dispatch | requests | written | no_nft | yield |
|---|---|---|---|---|
| < 2 d (head leg) | 10,206 | 8,078 | 1,778 | **79.1 %** |
| 2–30 d | 7 | 6 | 1 | 85.7 % |
| **30–180 d (the backlog walk)** | **20,978** | **51** | **20,896** | **0.2 %** |
| > 180 d | 18 | 0 | 18 | 0 % |

So the backlog leg is almost entirely the 30-day **re-probe of Moments already known to have left the puller's wallet** — a Moment that moved does not come back, and the only other sources (a later `sales` row with edition+serial, the new owner's `wallet_moments_cache`, an Atlas event) are already exclusion criteria in the dispatcher, so what is left is exactly the set nothing can resolve this way. `topshot_ownership` names a different current owner for 57 of the 22,691 `no_nft` rows, so re-targeting the probe at the current holder is not available either.

Cost: ~450 Flow REST scripts an hour, 10.8k a day, every one a 400 — the whole `flow-rest-moment-moved-400` info row and ~95 % of `net._http_response` 400s. Flow REST is free and the lane is healthy (`ok=true`, 1–5 s a tick), so this is noise and wasted slots, not an outage: with the backlog leg at 30/tick the head leg is the only thing hydrating anything, and it already runs first.

## What to do (a one-token change, owner's call — the dispatcher is pinned)

In `topshot_moment_hydrate_dispatch` (`20260907214240`), `WHEN q.outcome IN ('no_nft', 'no_collection') THEN interval '30 days'` → a window long enough that a moved Moment is asked again only when something could have changed — `interval '365 days'` keeps the lane self-healing without the weekly 20k no-ops; a permanent skip (`interval '100 years'`) is the honest reading of "moved does not come back" but removes the self-heal. Either way the walk then advances to never-probed pulls (if any remain — `wrapped` has read `false` on every tick, so the cursor has not reached the end of the queue in weeks; after the change it should wrap within a day, which is the falsifier: a `wrapped: true` tick). Three-file change (pin `supabase/tests/…` if one exists + migration + drift-guard row); the `flow-rest-moment-moved-400` info row should fall to the head leg's ~250/day.

## Why filed, not shipped

The hydrator's dispatch logic is ingest route-logic owned by the Claude Code lanes (the 10-10 night handoff lists chain-arrival / hydrate as off-limits for the autonomous pass), the function may be pinned, and the retry window is a design value the 09-07 header chose on purpose — this filing carries the number that header did not have.
