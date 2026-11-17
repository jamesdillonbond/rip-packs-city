# ✅ E5 — two `after()` routes converted on **measured kill risk**, budget 49 → 47; and `duration_ms` is not execution time

**Filed 2026-08-27 19:0xZ PT (2026-08-28 02:0xZ) by Claude Code, cloud session (push-capable).**
Moves register item **E5** (*49 `after()` routes write a terminal `pipeline_runs` row with no
invocation heartbeat*). Same defect class as the unbounded-`fetch()` work shipped earlier tonight —
**a killed tick that writes nothing** — approached from the other side.

---

## 1. ⛔ How NOT to pick which routes to convert

The obvious selections are all wrong here, and each was tried and discarded:

- **By failure rate.** `run-insider-detectors` 27.7 %, `lock-check-batch` 25.5 %,
  `populate-pinnacle-wmc-fmv` 23.9 % over 48 h. ⛔ **A failing run WROTE A ROW.** A high fail rate is
  evidence the route is *logging*, which is the opposite of the problem.
- **By cadence shortfall.** Compare `pipeline_runs` count against
  `pipeline_cadence_watchlist.max_silent_minutes`. ⛔ **Every candidate runs at 133–16,363 % of its
  minimum** — the watchlist thresholds are loose silence alarms, not expected-rate contracts, so the
  comparison cannot find a missing invocation.
- ⭐ **And it cannot, in principle.** A kill writes nothing, so no query over `pipeline_runs` can
  count kills. **That is the whole reason the marker exists**, and it means conversion value is
  *prospective*, never diagnosable in advance.

## 2. ✅ The criterion that does work: proximity to the wall

If kills cannot be counted, rank by **kill RISK** — how close a route already runs to its own
`maxDuration`. Measured over 7 days:

| route | maxDuration | p90 `duration_ms` | **p90 % of budget** | max |
|---|---:|---:|---:|---:|
| **`cron/lock-check-batch`** | 300 s | 241,381 ms | **80 %** | 295,604 ms (98.5 %) |
| **`cron/run-insider-detectors`** | 300 s | 224,193 ms | **75 %** | 322,813 ms |
| `cron/populate-pinnacle-wmc-fmv` | 300 s | 125,319 ms | 42 % | 128,807 ms |
| `cron/daily-portfolio-snapshot` | 300 s | 120,191 ms | 40 % | 120,191 ms |

**The top two are converted.** A route whose p90 is four fifths of its wall is exactly where "killed"
and "never fired" diverge in practice, so it is where a marker buys the most.

⚠ **`lock-check-batch` also carries a stale claim in its own header** — *"~17-20s typical"*, written
when the route was moved into `after()`. Its p50 is now **204,346 ms**. The comment was not corrected
in this pass beyond noting it; the number in it is a dated sample like every other in this repo.

## 3. 🚨 A separate finding, made while ranking: `duration_ms` is not execution time

**Three pipelines record a `duration_ms` ABOVE their route's declared `maxDuration`:**

| pipeline | max `duration_ms` | route budget | ratio |
|---|---:|---:|---:|
| `wmc-fmv-populate` | 352,922 ms | 300,000 ms | **117.6 %** |
| `offers-sweep` | 339,605 ms | 300,000 ms | **113.2 %** |
| `run-insider-detectors` | 322,813 ms | 300,000 ms | **107.6 %** |

⛔ **This is NOT evidence that a lambda outlived its wall.** `log_pipeline_run` has **no
`p_finished_at` parameter**, so `finished_at` DEFAULTS to `now()` at INSERT time and `duration_ms` is
GENERATED from the pair — meaning the recorded duration absorbs **any retry or queueing delay on the
terminal write itself**, and several of these routes wrap that write in a 3× backoff retry.

⭐ **So `duration_ms` on an `after()` route over-reports, by an amount that grows precisely when the
instance is saturated — i.e. exactly when someone is reading it to diagnose saturation.** The
heartbeat helper already documents this hazard for marker rows (its `finished_at` is *pinned* to
`started_at` for this reason); **the same caveat applies to the terminal rows and is not written down
anywhere.** ⚠ Anyone comparing `duration_ms` against a `maxDuration` budget — including §2 above — is
reading an upper bound, not a measurement. §2 still ranks correctly because the bias is in the same
direction for every row, but the absolute percentages are ceilings.

## 4. What shipped

`writeInvocationHeartbeat()` from `lib/pipeline/heartbeat.ts`, awaited as the first statement of each
`after()` body, before the work. Ratchet **49 → 47**, read off the failing no-slack assertion rather
than by subtracting two — as that file's own history requires, after two sessions once collided by
each subtracting their own conversions.

## 5. ⚠ Not claimed

- **A heartbeat does not detect its own kill**, and no test can simulate one. It records that the
  invocation STARTED; the detection is the correlation query in the helper's header, run elsewhere.
  **Nothing in this change makes an existing kill visible retroactively.**
- **No kill has been observed on either route.** The case is risk, not incidence — and by §1 the
  incidence is unobservable until the markers have been running.
- The other 47 routes are untouched.

## 6. Revert path

`git revert` the commit; restoring either route additionally requires raising `BUDGET` back to 49.
No DB state, no schedule change.
