# Daytime monitor candidates — CANDY LISTINGS FEED DARK (+2 lower-priority)

Source: rpc-daytime-monitor mid-day tick (~14:1x PT / 21:1xZ, 2026-08-26).
NOT a spell — positive control io_wait=4 / active=6 / total=44 at 21:07Z, and light
indexed queries return instantly. `rpc_ops_snapshot()` itself times out ONLY on its
`sentinel_fmv_confidence_rows` leg (the known "accuracy meter unreadable 20h/day" issue,
filed 2026-08-22), so the health vector below was assembled leg-by-leg. Security clean
(invariants none, RLS-off public tables 0, anon-write-holes 0). Vercel: 20 recent deploys,
several READY, zero ERROR. rpc-live-health artifact structurally valid (all 22 backing
relations + get_pipeline_alerts() present). Headline: editions TS 19,850 / AllDay 6,190 /
Golazos 575 / UFC 518 / Candy 125 (27,258 total); DB 14 GB. Trust-health view unread this
tick (known 60s timeout — read the sentinel, not the view).

## HIGH — candy-listings-indexer: PUBLIC Candy listings feed dark ~38h while invocations continue
- Source: detect_stalled_pipelines() (candy-listings-indexer, 2315 min silent) + direct measurement.
- Measured 2026-08-26 ~21:1xZ: `candy_listings` max(last_seen_at) = **2026-08-25 06:42Z**;
  **0 rows seen in 24h**, 1,595 in 48h (all pre-06:42Z), 6,200 rows total. Terminal
  `candy-listings-indexer` rows in 48h = **1** (the 06:35Z one). `candy-listings-indexer-heartbeat`
  rows in 48h = **15** (fires every 3h, all ok:true, newest 18:35Z).
- Reading: the route is INVOKED ~every 3h (heartbeat writes) but has written **zero listings
  and only ONE terminal completion row in 38h**. The watchlist note's "cry-wolf / it runs and
  writes but doesn't log the terminal row" story assumed `last_seen_at` tracks the heartbeat
  within 3 min — **that is FALSE right now** (last_seen is 38h behind the heartbeat), so this
  is a real work stoppage, not the known logging oscillation. The heartbeat is the instrument
  that lies here.
- Blast radius: /insights/candy-mlb (PUBLIC since 2026-07-31) Deals/Spread/Serials read
  `candy_listings` via candy_deals_board + candy_listing_floor -> asks up to 38h stale on a
  public board.
- Not a spell; persisted across 15 invocations => not transient.
- Risk read: read-only to diagnose; the fix is route/upstream, NOT a low-risk auto-ship.
- Suggested action (night pass / Trevor): discriminate the two states — (a) Magic Eden
  genuinely returns 0 candy asks now (legit-empty: the board's empty-state honesty + the
  watchlist arm need the fix), vs (b) the route is killed/erroring AFTER the heartbeat (real
  break). The **absence of any terminal completion row for 38h** points to (b) — a
  post-heartbeat kill/error, not a clean empty result. Check candy-listings-indexer Vercel
  runtime logs + the ME upstream. User-facing surface — do not auto-ship a guess.

## MEDIUM — topshot-pack-pool-backfill: 64/69 runs in 6h fail "0/3 dists converted; 3 returned no editions"
- Source: pipeline_runs (topshot-pack-pool-backfill), ~every 5 min.
- Measured: 64 of 69 runs in the last 6h fail `0/3 dists converted; 3 returned no editions`
  — a FUNCTIONAL result, not a statement timeout / saturation.
- Reading: the backfill retries the same 3 pack distributions every ~5 min and gets no
  editions for any, indefinitely — either 3 permanently-unresolvable dists that should be
  parked/excluded, or a regression in edition resolution.
- Risk read: read-only to identify the 3 dist IDs; parking them is a bounded data change.
- Suggested action: enumerate the 3 distribution IDs it is stuck on; determine whether they
  are permanently unresolvable (no on-chain editions) and should be excluded, vs a real
  resolution regression. Wasteful either way (~12 failed runs/hr).

## LOW/MEDIUM — compute-golazos-pack-ev: silent ~20h, missed 3 scheduled runs
- Source: detect_stalled_pipelines() (1233 min silent) + cron.job jobid 44 (sched `37 */6`).
- Measured: last run 2026-08-26 00:37Z, ok, no error. jobid 44 active; expected fires at
  06:37 / 12:37 / 18:37Z produced no pipeline_runs rows.
- Reading: cadence miss with no logged failure — likely pg_cron job-startup-timeout collateral
  (max_worker_processes=6 vs cron.max_running_jobs=32, per focus 2026-08-22) OR a silent HTTP
  kill. Golazos pack-EV; low user impact (575 editions).
- Suggested action: read cron.job_run_details for jobid 44 over 24h — if startup-timeout (no
  worker) it is the known saturation-worker class; if a route kill, characterize separately.

## Known / not filed (noted for completeness — all pre-existing classes)
- 4 pg_cron MV-refresh statement timeouts (rpc-refresh-allday-pack-realized 3/4 fails,
  -new-collectors, -challenge-costs, -thin-sale-ask-disclosure-refresh) = #27 board-MV /
  disk-IO saturation class (Trevor-blocked; do not re-investigate per focus PRIORITY 3).
  Side effect worth knowing: mv_allday_pack_realized is going stale from the repeated fails.
- wallet-username-resolver timeout (known 72% pooler fails), sync-nba-projections
  all_upstreams_failed (ESPN #8 measured-dead), topshot-active-listings-ingest egress_blocked
  (#20/#30 atlas-proxy), refresh_wmc_fmv_* timeouts + reconcile-saved-wallet-stats
  soft-deadline (saturation / graceful).
- allday-pack-opens-backfill silent since 13:06Z is BENIGN — jobid 55 succeeds every 10 min
  ("1 row"); walker parked at done=true (lap finished, per today's ledger). Watchlist arm
  cry-wolf, not a new finding.
- Sentry dark ~8d by decision (unpaid; Trevor chose not to raise the subscription).

---

## ✅ ANSWERED 2026-08-26 ~19:1x PT (2026-08-27 02:1xZ) by Claude Code — it is **(b)**, a post-heartbeat `maxDuration` KILL

The filing asks to discriminate **(a) Magic Eden legitimately returns 0 candy asks** from
**(b) the route is killed/erroring AFTER the heartbeat**. Vercel runtime logs settle it:

```
00:35:12  GET /api/candy-listings-indexer  202  [error/serverless-middleware]
          Vercel Runtime Timeout Error: Task timed out after 300 seconds
```

**(b), confirmed.** The route answers **202** — fire-and-forget — writes its heartbeat
**before** the work, and the lambda is then **killed at `maxDuration = 300 s`**.
ⓘ Corroborated independently: `/api/candy-listings-indexer` appears in the route list of
the `Vercel Runtime Timeout Error: Task timed out after 300 seconds` cluster in
`get_runtime_errors` (the largest error cluster on the platform, 24,027 events / 7 d).

⭐ **This filing's sharpest observation — "the heartbeat is the instrument that lies here" —
is exactly the documented kill signature, and it is worth naming as such.** CLAUDE.md:

> *Any `after()` route needs an invocation heartbeat written BEFORE the work … because
> `try/catch` CANNOT catch a `maxDuration` kill — without it a killed tick is
> indistinguishable from a cron that never fired. **Read kills by CORRELATION (heartbeat,
> no terminal row)**.*

**Heartbeat present + terminal row absent IS the kill correlation.** The instrument is not
lying; it is reporting the only thing it can see (that the route was entered), and the
absent terminal row is the other half of the designed signal. ✅ So the watchlist note's
"cry-wolf / logging oscillation" story is correctly rejected here — but the replacement is
not "unknown breakage", it is **a named, expected-to-be-detectable failure mode**.

## 👉 Likely cause, filed as a hypothesis rather than a finding

Same 100-minute log window, the sibling Candy route:

```
00:50:42  GET /api/ingest/candy-offers  202
  [candy-offers-indexer] offers_made fetch failed for <wallet>: ME /wallets/<w>/offers_made
  HTTP 429: Error 1015: You are being rate limited      (× 6 wallets in one tick)
```

**Magic Eden is Cloudflare-rate-limiting us (1015).** If the listings walk is retrying or
serialising through the same throttled upstream, it would slow past 300 s and be killed —
which produces precisely the observed signature. ⚠ **Hypothesis, not measured**: nothing
here proves the listings route hits 429s specifically, only that its sibling does against
the same host in the same window.

**Discriminator for whoever takes this:** log or count the ME response codes inside the
listings walk. **429s → an upstream throttle problem** (back off, page smaller, spread the
cadence). **200s but slow → a page-size/pagination problem** inside our own walk. The fix
differs completely, and the 300 s kill looks identical either way.

⛔ **Still not auto-shippable**, as the filing says: it is route logic on a PUBLIC surface
(`/insights/candy-mlb` Deals/Spread/Serials read `candy_listings`). ⚠ And note the board is
degraded on a **second, independent axis** in the same window — every
`refresh-insights-cache` tick logs `candy_scarcity_board` / `candy_player_board` /
`candy_parallel_premium` / `candy_offer_spread_board` failing with `canceling statement due
to statement timeout`, with one tick at **504 after 60 s**. **Stale asks and unrenderable
boards are two different faults on the same page**; fixing the indexer will not fix the
board timeouts.
