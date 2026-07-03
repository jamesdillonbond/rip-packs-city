# Finding — Q6 evm-transfers Base-429 backoff (2026-07-03)

**TL;DR:** The backoff Q6 asked for **already exists and works** — it was shipped
2026-05-31 (also tagged "Q6") in `app/api/cron/evm-transfers-ingest/route.ts`.
The pipeline is ~99% green. There is a small residual (2 cosmetic `ok=false`
runs in the last 14 days from `getLogs` exhausting its 4 retry attempts on a
sustained Base rate-limit burst). The clean fix for that residual changes a
**monitored pipeline's `ok` semantics**, so it's flagged here for Trevor's
sign-off rather than shipped blind. No code changed writing this doc.

---

## What already exists (shipped 2026-05-31, commit history tagged "Q6")

`app/api/cron/evm-transfers-ingest/route.ts` → `fetchLogsWithRateLimitBackoff()`:

- **Exponential backoff** on HTTP 429: `LOGS_RETRY_BASE_MS(2000) · 2^attempt` +
  up to 500ms jitter, `LOGS_RETRY_MAX_ATTEMPTS = 4`.
- **Window halving** on each 429: `RETRY_WINDOW_FACTOR = 0.5`, so the getLogs
  span walks 5k → 2.5k → 1.25k → 0.625k blocks across the 4 attempts, shrinking
  under the burst threshold.
- **Baseline window lowered** `BLOCKS_PER_WINDOW` 10k → 5k (the 10k getLogs was
  the original burst that tripped `base_mainnet`'s limit). 5k still vastly
  outpaces Base's ~1,800 blocks/hr, so the forward cursor never lags.
- `isRateLimitErr()` matches both `"429"` and `/rate.?limit/i`; non-429 errors
  hard-fail immediately (no pointless retry).
- Telemetry: `extra.rate_limited_attempts`, `extra.logs_attempts`,
  `extra.window_halved` on successful runs.

So **Step 3's precondition ("hits 429 … without proper backoff") is not met.**
Proper exponential backoff + adaptive window shrink is present.

## Live health (pipeline_runs, last 10 days, as of 2026-07-03)

| day | runs | ok | fail | runs w/429 | max 429 attempts |
|-----|------|----|------|-----------|------------------|
| 07-03 | 19 | 19 | 0 | 2 | 1 |
| 07-02 | 24 | 22 | 2 | 4 | 2 |
| 07-01 | 24 | 24 | 0 | 3 | 1 |
| 06-30 | 24 | 24 | 0 | 13 | 1 |
| 06-29 | 23 | 23 | 0 | 12 | 1 |
| 06-28 | 24 | 24 | 0 | 18 | 1 |
| 06-27 | 24 | 24 | 0 | 6 | 1 |
| 06-26 | 18 | 18 | 0 | 10 | 1 |

429s are common but almost always clear in a **single** retry. The backoff is
doing its job. This matches the overnight ledger's standing "evm-429 benign"
disposition.

## The residual (the only thing left)

The 2 failures on 07-02 are both:

```
base_mainnet proxy returned 429: {"code":-32016,"message":"over rate limit"}
```

with `extra.from_block`, `extra.rate_limited_attempts`, `extra.logs_attempts`
all **null**. That null signature means the throw happened *inside*
`fetchLogsWithRateLimitBackoff` after it **exhausted all 4 attempts** — the
route never reached line ~290 where it stamps `from_block` (which would be set
if getLogs had succeeded and a later call, e.g. `getBlockByNumber`, had thrown).
So: a sustained Base burst outlasted 4 retries.

**Blast radius: cosmetic.** A rate-limited tick simply doesn't advance the
cursor; the next 30-min tick retries the same window. Because 5k blocks/tick >>
Base's ~1,800 blocks/hr, the forward cursor cannot fall behind from an occasional
skipped tick. **No data is lost.** The only artifact is a red `ok=false` row the
overnight pass has to hand-wave as benign each time. Also note: Beezie/Base is a
parallel data plane with **no product consumer yet** (per CLAUDE.md), so even a
multi-tick gap would be invisible to users.

## Why I did not just "bump the retries"

Increasing `LOGS_RETRY_MAX_ATTEMPTS` past 4 is unsafe as-is: the exponential
sleeps already sum to 2+4+8 = 14s over 3 gaps, and the whole contract loop is
bounded by `BUDGET_MS = 25s` (route `maxDuration = 60`). Adding attempts 5–6
would add 16s + 32s of sleeping, blowing the budget and risking a silent
`after()` lambda kill mid-write — strictly worse than the benign red row.

## Recommended fix (needs Trevor / pipeline-owner sign-off)

Treat **rate-limit exhaustion as a deferral, not a failure**, scoped tightly:

- In `runContract`'s catch, if `isRateLimitErr(errorMsg)` after a full retry
  effort, log the run with `ok = true` + `extra.deferred_rate_limited = true`
  (keep the raw 429 message in `extra` and preserve `rate_limited_attempts` for
  visibility), and leave the cursor unadvanced (already the case — nothing wrote).
- **Non-429 errors keep hard-failing (`ok = false`).**

This makes the pipeline tell the truth — a skipped-window-due-to-rate-limit is a
deferral the design already recovers from — and removes the recurring false
`ok=false` noise that the overnight pass keeps classifying as benign.

**Why it needs sign-off, not a blind ship:** it changes the `ok` semantics of a
pipeline the unattended overnight/daytime monitors read (the "pipeline fails 24h"
count). That's a deliberate cross-system change, and the 429 path can't be
exercised/verified from a dev session (Base WAF blocks non-proxy egress), only
`tsc`. One-line green-light and it's a ~10-line, revertable route change.

## Secondary hardening (latent, low value today)

`getBlockByNumber` (route line ~319) — the fallback that resolves block
timestamps for logs missing `blockTimestamp` — is fired via `Promise.all` with
**no** rate-limit backoff. It is not the cause of the observed failures and does
not currently fire (Base includes `blockTimestamp` on every log, so
`missingBlocks` stays empty), but if Base ever drops that field, a burst of
parallel `eth_getBlockByNumber` calls could 429 unwrapped. If the deferral fix
above ships, wrapping this path in the same backoff (or serializing it) is cheap
insurance. Not urgent.
