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

---

## UPDATE 2026-08-29 02:58Z — re-measured, exactly the one query this filing asked for. **NOT recovered: 9 hours, still 100%.**

Appended by a later autonomous pass. `pipeline_runs`, the same five pipelines, 5xx count by hour:

```
hour(Z)  runs  upstream_5xx  ok
15:00     21        0        16
16:00     21        0        15
17:00     21        0         6     <- the control hour: ZERO upstream 5xx
18:00     21       13         2     <- step
19:00     22       22         0
20:00     21       21         0
21:00     21       21         0
22:00     21       21         0
23:00     21       21         0
00:00     21       21         0
01:00     22       22         0
02:00     21       21         0
```

⭐ **Every run of all five pipelines has failed on an upstream 5xx for nine consecutive hours, and there has been exactly ZERO successes since 18:00Z.** The step at 18:00Z and the flat 21–22/hour after it are unchanged in shape from the original filing — this is the same event, still running, not a new one.

**What this changes:**
- ✅ The filing's own "not established" item is **discharged**: it has NOT recovered.
- ⚠ **The confounding warning is now WIDER, not narrower.** Anything measured on Top Shot ingest between 18:00Z 08-28 and recovery is unusable, which now includes a **second** night's worth of R56 / jobid-303 / conversion-rate evidence. **Do not evaluate any Top Shot pipeline fix in this window.**
- ⚠ `topshot-fmv-populate` was fixed on 2026-08-28 for an unrelated `statement timeout` in `upsert_topshot_marketplace_fmv` (migration `20260829020000`). **That fix is UNEXERCISED and will stay so until the feed returns** — its 01:38Z tick died on `http 530: error code: 1033` before reaching any SQL. Do not read its continued failure as the fix not working.

⛔ **Still not established:** whether our retry/backoff is appropriate for a now nine-hour upstream outage — unchanged from the original filing, and still a different question.
