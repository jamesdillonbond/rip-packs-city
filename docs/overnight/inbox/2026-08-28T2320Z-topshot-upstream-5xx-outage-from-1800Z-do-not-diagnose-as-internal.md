# ⚠ READ BEFORE DIAGNOSING ANY TOP SHOT PIPELINE: a Top Shot UPSTREAM 5xx outage started ~18:00Z 2026-08-28 and was still running at 23:05Z

**2026-08-28 23:20Z · Claude Code**

**Five Top Shot pipelines went red together this evening and NONE of it is ours.** The errors are
Cloudflare `HTTP 530 error code: 1033` and `HTTP 503 Service Temporarily Unavailable` from Top Shot's
own GraphQL — an origin-down signature, not a timeout, not saturation, not a regression we shipped.

| hour (UTC) | upstream 5xx | ok | runs |
|---|---:|---:|---:|
| 17:00 | **0** | 8 | 19 |
| 18:00 | 13 | 8 | 27 |
| 19:00 | 21 | 6 | 27 |
| 20:00 | 21 | 6 | 27 |
| 21:00 | 21 | 7 | 28 |
| 22:00 | 21 | 6 | 27 |
| 23:00 (partial) | 6 | 2 | 8 |

Population: `topshot-moments-hydrator` · `offers-sweep` · `topshot-pack-pool-backfill` ·
`topshot-listing-cache` · `topshot-sales-indexer`.

⭐ **The 17:00Z row is the control and it is why this is attributable:** ZERO upstream 5xx in the hour
before, at a comparable run count. The onset is a step change at 18:00Z, not a ramp — consistent with an
upstream flipping, and inconsistent with our own IO band (which ramps).

## Why this filing exists

🚨 **It will masquerade as three separate internal defects tomorrow.**

1. **`topshot-pack-pool-backfill` (#38 / R56) will look like it CHANGED.** Its dominant signature
   `0/3 dists converted; 3 returned no editions` (244 of 335 failures in 48 h) **stops at 16:33Z** and
   upstream 5xx takes over from 18:23Z. ⛔ **That is NOT the wedge fix or the R56 probe-slot change
   landing** — the old signature cannot be produced while the upstream is down, so the two are
   CONFOUNDED and neither can be evaluated in this window. **Any post-fix conversion rate measured
   across 18:00Z onward is meaningless.** Wait for the upstream to recover before reading it.
2. **`topshot-active-listings-ingest` is a DIFFERENT failure** — its `egress_blocked` / Atlas WAF
   block (known-issues #20/#30) is unrelated and predates this. Do not merge them.
3. A `cron_silent` or stalled-pipeline breach on any of the five is this outage, not a dead cron.

## What NOT to do

⛔ Do not re-diagnose, do not raise a timeout, do not suppress an arm, do not "fix" a retry.
⛔ Do not read any Top Shot ingest freshness metric taken between 18:00Z and recovery as a data-quality
regression — the rows genuinely did not arrive because the source did not serve them.

## What is NOT established

⛔ **Whether it has recovered.** Last sample 23:05Z, still failing. **Re-measure before acting on
anything above** — this is a dated sample of a moving event, and the honest next step is one query
(`pipeline_runs`, those five pipelines, 5xx count by hour), not a re-diagnosis.
⛔ **Whether our retry/backoff behaviour is appropriate for a 5-hour upstream outage.** Not examined.
That is a real question, but it is a DIFFERENT one and should not be answered from this window's data.
