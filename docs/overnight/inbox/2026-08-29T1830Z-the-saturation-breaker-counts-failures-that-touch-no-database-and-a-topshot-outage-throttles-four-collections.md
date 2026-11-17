# The saturation breaker counts failures that touch **no database** — so a Top Shot API outage is throttling sales-history backfills for **four collections**

**Filed 2026-08-29 ~18:30Z (11:30 PT). Status: MEASURED, NOT SHIPPED — a breaker made
LESS sensitive needs deliberate sign-off, and this one is shared by six routes.**

## The mechanism

`lib/studio-sales-history.ts` self-throttles before doing any work:

```js
const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
const { count } = await supabaseAdmin.from("pipeline_runs")
  .select("id", { count: "exact", head: true })
  .eq("ok", false)
  .neq("pipeline", cfg.pipelineName)     // ← ANY other pipeline
  .gte("finished_at", since)
if ((count ?? 0) > SATURATION_FAIL_THRESHOLD /* 15 */) { skip the tick }
```

It counts **every pipeline's failures fleet-wide in the last 30 minutes** and treats that
as a proxy for database pressure.

## The measurement — 49 half-hour windows over 24 h, replicating the breaker's own query

| | |
|---|---:|
| windows where the breaker fires (`> 15`) | **17 of 49 — 34.7%** |
| windows that would still fire with the dead-endpoint pipelines removed | **4 — 8.2%** |
| mean failures per window | **17.8** |
| …of which come from the 9 `public-api.nbatopshot.com` pipelines | **10.3 (58%)** |

**The Top Shot legacy-endpoint outage is, on its own, the difference between a breaker that
fires 8% of the time and one that fires 35% of the time** — a 4.25× increase.

🚨 **And it is throttling FOUR collections, not one.** Every route delegating to this module
skips together: `allday-sales-history-backfill`, `allday-studio-sales-history-backfill`,
`golazos-sales-history-backfill`, `golazos-studio-sales-history-backfill`,
`pinnacle-studio-sales-history-backfill`, `topshot-sales-history-backfill`. Over 48 h, five
of those six wrote **zero rows**. The skip is logged as
`{"skipped":"saturation","recent_fails":16}` with `ok: true`, so nothing reports it.

## ⭐ Why this is a defect and not the valve working

**The breaker exists to protect the database. The failures inflating it never reach the
database.** A `530 error code: 1033` from `public-api.nbatopshot.com` is an HTTP fault that
dies before any SQL is issued — `topshot-fmv-populate`'s own row shows `duration_ms: 483`
and `pages_fetched: 0`. Ten such failures per window cost the DB nothing, and they are
58% of the signal the breaker reads.

So the breaker throttles **hardest** in the one situation where the database is **least**
loaded: an upstream API is down, so the pipelines that would otherwise be hammering
Postgres are instead failing instantly at the network layer.

⛔ **This is NOT the "guard fails open" bug that was already fixed here.** That one
(`count ?? 0` reading a statement timeout as "no failures") is fixed and its comment is in
the file — this is the opposite direction: the guard fires when it should not, because its
INPUT conflates two unrelated kinds of failure.

## 👉 Proposal — narrow the input, do not raise the threshold

The semantically right count is **DB-pressure failures**, not all failures:

```js
.or('error.ilike.%statement timeout%,error.ilike.%connection pool%,' +
    'error.ilike.%lock timeout%,error.ilike.%too many clients%,error.ilike.%PGRST002%')
```

⛔ **Raising `SATURATION_FAIL_THRESHOLD` is the wrong lever** — it would make the breaker
slower to fire during *real* saturation too, which is the failure mode it was built for.
Narrowing the input keeps full sensitivity to database pressure while ignoring upstream
faults.

⚠ **Why it is filed rather than shipped, stated plainly:**
- It makes a **safety breaker fire less often**, on an instance whose binding constraint is
  disk IO. Getting the signature list wrong removes protection during genuine saturation —
  strictly worse than the current over-firing.
- The list above is a **positive allowlist and therefore incomplete by construction**.
  Before shipping, derive it from the actual `error` values on `ok = false` rows over a
  saturation spell, rather than from what looks right.
- Six routes share this module, so the blast radius of a mistake is every collection.

## ⚠ A second, independent problem in the same block

`allday-sales-history-backfill` at 18:07:30Z logged
`{"skipped":"throttle_error"}` with **`duration_ms: 61265`** — the breaker's own
`count: "exact"` over `pipeline_runs` **timed out after 61 seconds**. The file's comment
already predicts this (*"it is a `count: exact` over `pipeline_runs` — the table every
pipeline is writing to — so it is likeliest to fail during the very saturation it exists to
detect"*), and the fail-closed handling is correct. But it means a tick can burn 61 s of a
300 s budget to learn nothing. 👉 Cheaper signal worth considering: a bounded
`head: true` count with an explicit `.limit()`, or reading the existing
`pipeline_runs_daily` rollup — ⛔ **not the rollup as-is**: it refreshes six-hourly and this
needs a 30-minute window, so that swap would silently read a stale number.

⛔ **NOT established:** how much data the skipped ticks actually cost. These are historical
backfills, so a skipped tick is deferred work rather than lost work — the queues persist.
**The cost is that the 2023-11 → 2026 coverage gap closes ~35% slower than intended, not
that rows are missing.** Nobody should escalate this as data loss.
