# `get_team_detail` is the same defect family — but the expensive half is 30d SALES, not FMV, and it needs a rollup rather than a rewrite

**Filed 2026-08-23 (PT) 11:50 by Claude (Cowork, cloud).** Measured, **not shipped** — deliberately.

## How it surfaced

A 15-URL sweep across every entity route and collection, fetched with a Googlebot UA under
daytime load. **All 15 returned 200. One degraded:**

| collection | route | slug | time | degraded |
|---|---|---|---|---|
| nba-top-shot | **team** | los-angeles-lakers | 25.8 s | **2 "Couldn't load" markers** |
| nba-top-shot | edition | 49:1662 | 21.3 s | 0 |
| nba-top-shot | player | lebron-james | 19.6 s | 0 |
| nba-top-shot | set | base-set | 17.1 s | 0 |
| nfl-all-day | player / set / team | — | 10.5–11.9 s | 0 |
| laliga-golazos | set / team | — | 9.5–12.7 s | 0 |
| ufc, golazos editions | — | — | 1.6–3.8 s | 0 |

Vercel confirms the one failure precisely:

```
[team-layout] detail rpc error slug=los-angeles-lakers: canceling statement due to statement timeout — failing OPEN
[team] detail error canceling statement due to statement timeout
```

⚠ **Note the other times.** Nothing else is degrading, but 17–26 s TTFB on the four biggest Top
Shot pages is not health — it is the same instance-wide contention that produces R19's 45 s
class. These are cold renders (`cache=MISS`), so a real visitor usually does better, but the
floor is not where it should be.

## Where the time actually goes — measured per block, because the whole-function number does not say

`get_team_detail('nba-top-shot','los-angeles-lakers')` — 638 editions — declares
`statement_timeout '25s'`:

| block | time | buffers | **reads** |
|---|---|---|---|
| whole function (cold) | 29,267 ms | 18,464 | 3,640 |
| team-slug resolution | **15 ms** | 542 | 2 |
| per-edition FMV lateral | 2,094 ms | 4,376 | 751 |
| **30-day sales aggregate** | **6,496 ms** | **8,917** | **2,222** |

⚠ **I would have fixed the wrong half.** The FMV lateral is the shape I have now replaced twice
today, and it is the *cheap* one here — 24% of the buffers. The 30-day sales join is **48%**, and
the slug resolution, which the source comment worries about, is already indexed
(`idx_editions_collection_team_slug`) and costs 15 ms.

The parts sum to ~8.6 s against a 29 s whole-function reading. That gap is contention between
measurements, not a missing block — **treat 8.6 s as the work and 29 s as what the instance does
to it.**

## Why the sales half is NOT a rewrite

Both remaining costs are 638 per-edition random probes. For FMV that is fixable by joining
`edition_fmv_current`. For sales I tried the obvious reshape — materialise the team's edition ids,
then semi-join `sales` — and it changes nothing structural:

| shape | buffers | reads |
|---|---|---|
| current `JOIN editions … WHERE team_name = ANY(...)` | 8,917 | 2,222 |
| CTE + `edition_id IN (SELECT …)` | 5,566 | 2,620 |

The edition side gets cheaper (it picks up `idx_editions_collection_team`), but the plan is still
`Nested Loop → 638 × Index Scan on sales_2026`, and the reads go **up**. 👉 **Per-team 30-day
volume is a rollup, not a join shape.** Third time today the measurement has landed on "this needs
precompute": series totals, per-edition FMV, and now per-team recent volume.

## Recommendation — and why I stopped here

**Ship-ready, small, proven:** swap the FMV lateral for `edition_fmv_current` (already exists,
already refreshed hourly, already carries a staleness arm). Removes 4,376 buffers / 751 reads
from **every team page view**, and the pattern has md5-verified equivalence from two applications
today.

⛔ **It would not fix the Lakers page**, and saying otherwise is the mistake I have made twice
today. 25% off a function that needs ~70% off is an improvement, not a fix. The sales rollup is
the actual answer and it is a new shared object — the category I have already over-reached on
once today, so it is Trevor's call, not a drive-by.

## ⚠ One caveat about these numbers that is mine, not the system's

I generated several of these readings with `EXPLAIN (ANALYZE)` runs costing 29 s and 38 s, against
a production instance whose central problem **is** contention, during business hours. Some of the
wall-clock figures above include load I created. The **buffer and read counts are stable across
runs and are the numbers to trust**; the milliseconds are not. Investigating a saturation problem
by adding saturation is its own small failure of method — heavy EXPLAINs on this box belong in a
quiet window, and I have stopped for now.

---

## ⚠ CORROBORATION FOUND AFTER FILING — and it downgrades every millisecond above

The daytime monitor filed
[2026-08-23T1812Z](2026-08-23T1812Z-daytime-monitor-saturation-spell-symptoms.md) **independently
and at the same time**, with a positive control I did not have: `io_wait=12 / active=11 /
total=46` sessions and `rpc_ops_snapshot()` itself timing out. Its verdict:

> this run is INSIDE a disk-IO saturation spell, so nothing below is a cause or a cost figure —
> each item is a symptom to re-measure in a quiet window before any action. This is the KNOWN
> band class (do NOT open a new saturation investigation, do NOT raise a timeout, do NOT upgrade
> the tier).

**Every wall-clock number in this filing was taken inside that spell.** So:

- ✅ **The buffer and read counts stand.** They are plan-shape facts and were stable across runs:
  the 30-day sales aggregate really is 8,917 buffers / 2,222 reads against the FMV lateral's
  4,376 / 751, and the reshape really does move reads the wrong way. **The conclusion — the sales
  half needs a rollup, not a rewrite — does not depend on any timing.**
- ⛔ **The milliseconds do not stand.** 29,267 ms for the function, 25.8 s for the Lakers page,
  17–26 s across the big Top Shot routes: re-measure all of it quiet before quoting any of it.
- ⛔ **And it partially reframes the 17:59 tick failure I caused.** That tick died at 600 s
  during this same spell. My full-population rebuild is what made the job vulnerable — a job
  finishing in 49 s an hour earlier does not reach 600 s without the work I added — but the spell
  is a co-author, and "my change broke it" is more certain than "my change alone broke it." The
  fix (incremental refresh + exception isolation) is right either way, and the incremental path
  is precisely what makes the job survive the next spell.

👉 **Two sessions measured the same instance in the same hour and only one of them had a
saturation control.** The monitor's SKILL makes that control mandatory before it interprets
anything; I ran heavy `EXPLAIN (ANALYZE)` for an afternoon without one. **Read
`rpc_ops_snapshot()` / the io_wait control BEFORE a performance measurement on this box, not
after** — otherwise you cannot tell your numbers from the weather, and you may be the weather.
