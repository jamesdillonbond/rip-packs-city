# Handoff 2026-06-18 — topshot-deal-floor-serials cron is 429-throttled (88% of GQL calls fail/run)

Plain text. Claude Code's direct file inspection wins over this doc. The floor-serial feature WORKS and is live; this is an efficiency/coverage fix, not a breakage.

## Confirmed diagnosis (measured live 2026-06-18)

The cron (`app/api/cron/topshot-deal-floor-serials/route.ts`, registered cron-job.org job 7850139 @ :37 hourly) ran clean at 04:37Z (`ok=true`) but its `pipeline_runs.extra` shows **`gql_errors: 388, listings_found: 53`** out of ~592 deal editions. The thrown errors are **HTTP 429** — confirmed in Vercel runtime logs: the messages are `Top Shot GraphQL failed with 429` (the `!response.ok` throw in `topshotGraphql`, lib/chains/flow/topshot.ts L31-34).

Root cause: the worker pool fans out ~592 `searchMintedMoments` calls at `CONCURRENCY = 5` with NO retry. That burst trips the Cloudflare/TS-GQL rate limit on the topshot-proxy, so ~388/run get 429 and are dropped (the edition keeps its prior serial, or stays null). Coverage after run 1 = 54/592; it converges over ~10+ hourly runs because errored editions retain prior serials, but it's slow and hammers the shared proxy 388×/hour.

## Fix (route code — pick 1+2, they're the core)

1. **Retry 429/5xx with backoff.** Wrap `fetchFloorListing` (or the `topshotGraphql` call inside it) in a bounded exponential-backoff retry — e.g. up to 3 retries on a 429 / 5xx / network throw, base ~400ms with jitter, give up after. A 429 means "slow down + retry," not "no listing." This alone should take most of the 388 to success. (Repo already has retry helpers — `rpcRetry` and the sentinel's `withRetry`; mirror one.)
2. **Lower `CONCURRENCY` 5 → 2** (and consider a small inter-call jitter). Reliability beats raw speed here — the route is `after()`-wrapped with `maxDuration = 300`, so a slower, fully-covering run is fine.
3. Optional — **converge faster + lighter:** prioritize editions where `low_ask_serial IS NULL` first (process those before refreshing already-serialed ones), so first-coverage isn't competing with refresh load. Keep refreshing the rest at a lower cadence.
4. Optional — distinguish a 429 (transient, retry) from a genuine `searchSummary.data.data = []` (no active listing → `skippedNoListing`, correct) in the counters, so the extra cleanly separates "throttled" from "no listing."

## Do NOT

- Don't raise the cron frequency to chase coverage — more frequent bursts = MORE 429s (the pack-EV "frequency is the lever" rule is inverted here because the bottleneck is an upstream rate limit, not our throughput). Hourly is the right cadence; fix the per-run reliability instead.

## Verify

After the fix, a run's `pipeline_runs.extra` should show `gql_errors` near 0 and `listings_found` ≈ (editionsTargeted − genuine-no-listing). Deal-board coverage (`SELECT count(low_ask_serial) FROM cross_collection_deals_board WHERE collection_slug='nba_top_shot'`) should reach ~all 592 within one or two runs.

## Interim state (no action needed to be safe)

Coverage fills in on its own overnight at ~53/run; edition deals that don't yet have a serial render exactly as before (set + tier + mint, no serial) — no regression. The cron is registered, enabled, and logging clean.
