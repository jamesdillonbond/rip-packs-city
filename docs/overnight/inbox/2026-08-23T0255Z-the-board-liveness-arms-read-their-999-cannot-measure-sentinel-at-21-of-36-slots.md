# `public_board_slow_count` / `public_board_empty_count` write their **"could not measure" sentinel** at 21 of their last 36 slots — the standing breach is partly an unmeasured arm, not 45 unhealthy boards

**Filed 2026-08-22 19:55 PT (2026-08-23 02:55Z), Claude Code interactive.** Found by reading
`rpc_trust_health_precompute` directly instead of the trust-board view (which still times out at
60 s).

## The observation that started it

```
metric                     value  computed_at                 duration_ms
public_board_slow_count      999  2026-08-22 20:48:00Z            120
public_board_empty_count     999  2026-08-22 20:48:00Z            118
```

⚠ **999 with a 120 ms duration is not a measurement.** `rpc_thp_leg_board_liveness()` writes exactly
`999` to both arms when `public_board_liveness_probe()` returns `budget_exhausted = true`, and again
from its own `EXCEPTION WHEN OTHERS`. The comment in the function says so outright: *"incomplete
sweep is INCONCLUSIVE, not green."*

**Run the probe live, right now, and it is fine:**

```
{"probed":45,"active":45,"slow":12,"empty_or_error":0,"budget_exhausted":false,
 "sweep_checked_at":"2026-08-23T00:28:01Z","sweep_age_min":136}
```

So the board fleet's real state at this instant is **12 slow, 0 empty, full 45/45 coverage** — while
the arm the trust board reads says **999**.

## The mechanism, end to end

Two schedules, and they are the whole story:

| job | schedule (UTC) |
|---|---|
| `rpc-public-board-liveness-sweep` (jobid 288) | `28 */6 * * *` → 00:28, 06:28, 12:28, 18:28 |
| `rpc-thp-leg-board-liveness` (jobid 326) | `48 2,8,14,20 * * *` → 02:48, 08:48, 14:48, 20:48 |

`public_board_liveness_probe()` declares the sweep stale — and therefore writes 999 — if **either**
`max(checked_at)` is older than **480 min**, **or** `n_probed < n_active`, where `n_probed` counts
watchlist boards whose state row was refreshed inside that same 480-minute window. **It demands
100 % coverage of all 45 active boards within 8 hours.**

🚨 **But the sweep was deliberately redesigned on 2026-08-16 to NOT deliver that.** The 08-16
migration gave `public_board_liveness_sweep()` **least-recently-probed rotation** plus a
**predictive skip** ("decline to START a board whose median cost will not fit in what is left"), so
that under a 600 s budget it covers the watchlist **across several ticks**. Partial coverage per tick
is now *normal by design*.

⚠ **The probe's 480-minute all-or-nothing rule was never updated to match.** The sweep's contract
became "coverage over N ticks"; the reader still asserts "coverage in one tick". That is the whole
defect — not a broken sweep, not unhealthy boards, a **reader whose freshness window contradicts the
writer's design**.

Two independent things then push it over:

1. **Band truncation.** The 12:28 and 18:28 sweeps land inside the degraded 01:00–19:00Z disk-IO
   band and routinely stop early — measured tick sizes 1, 6, 8, 10, 13, 19, 22, 27 boards against 45.
2. **Ticks that never run at all.** On 08-18 and 08-20 the *only* sweep of the day was 00:28; the
   06:28/12:28/18:28 ticks left no trace. That is the `job startup timeout` /
   `max_worker_processes = 6` class already named in `focus.md`.

## Measured: how often the arm is actually a number

Reconstructed the probe's inputs at all 36 leg slots over the last 9 days from
`public_board_liveness_history`, then applied the probe's own 480-min / full-coverage rule:

| leg slot (UTC) | slots with a real reading |
|---|---|
| **02:48** | **9 / 9** |
| **08:48** | 5 / 9 |
| **14:48** | 1 / 9 |
| **20:48** | **0 / 9** |
| **total** | **15 / 36 (41.7 %)** — the other **21 slots write 999** |

12 of those 21 had **zero** boards inside the window (`newest_age_min` 496–1220).

⚠ **Positive control for the reconstruction:** it predicts 999 at 2026-08-22 20:48Z, and the live
precompute row at that exact timestamp *is* 999/999. The reconstruction is not free-floating.

⚠ **Trap this cost me one wrong answer, worth recording:** `public_board_liveness_history` is a
**LOG**, unique on `(view_name, checked_at)`, and `capture_board_liveness_history()` inserts with
`ON CONFLICT DO NOTHING` — so a capture only writes rows whose `checked_at` is new. My first pass
grouped by `captured_at` and read "8 boards" as *the watchlist is 8*, when it meant *8 boards were
newly probed*. **Grouping a log by its capture instant is not a snapshot of the state.** The correct
shape is an as-of rebuild: latest `checked_at` per `view_name` at or before each slot.

## Why this matters beyond tidiness

- 🚨 **999 is also the escalation value.** The board cannot distinguish *"45 boards are broken"* from
  *"we could not look"*. Those are opposite operational states sharing one number.
- ⚠ **It rewrites the standing characterization.** `focus.md` and CLAUDE.md list
  `public_board_slow_count` as a standing breach that is "saturation collateral" and warn *"do not
  characterize its direction from fewer than several days"*. That warning is now explained: **the
  series alternates between a real count and a sentinel**, so any trend read off it is reading an
  interleaving of two different quantities. The real count today is **12**, not 999.
- ⚠ **The arm is blind exactly when it is needed.** It exists to warn *before* a public board fails.
  It reads 999 at 14:48 and 20:48 — **inside the degraded band**, the hours when a board is most
  likely to actually be slow. The one slot that always works (02:48) is the quietest hour.

## Proposed fix — and the honesty trap inside it

The tempting fix is to widen the 480-minute window. ⚠ **That alone is wrong**: it would let the arm
report counts over boards last probed a day ago as if they were current.

Split the claim instead, because there are three states here and the arm currently has two:

1. **A new coverage arm** — `public_board_unprobed_count` (or a coverage %) — carrying the
   *"we could not look at N of 45"* claim on its own, breaching on its own threshold. This is the
   honest home for the 999.
2. **Let the count arms report over the boards actually probed**, with the window widened to match
   the rotation's real cycle (measure it; do not guess a multiple of 6 h), so `slow` and `empty` stay
   *counts of a measured set* rather than a sentinel.
3. ⚠ **The counts must not be published as if they covered the whole watchlist.** `slow = 12` over 45
   probed and `slow = 12` over 8 probed are different claims; whatever renders them has to carry the
   denominator, or this turns into the `?? 0` / `|| 1` fabricated-number shape one layer up.

⚠ **Before shipping any of it, check who reads these two metric names** — the trust-board view, the
sentinel route's `Trust Health` check, and any Cowork artifact HTML (which is outside both the repo
and the catalogue, and has already been the sole caller of 8 views). A rename without that sweep
breaks a live board.

## Not established here

- **Whether the 15/36 rate is stable or drifting.** Nine days is one window, and it spans the 08-16
  rotation change. ⚠ A rate is not a trend; re-measure before quoting this as a baseline.
- **Why the 06:28/12:28/18:28 ticks vanished entirely on 08-18 and 08-20.** Attributed to the
  `max_worker_processes` starvation class on shape alone — that attribution is a hypothesis, not a
  measurement, and the pg_cron ownership split (`jobid 288` is `postgres`-owned, so it *is*
  reachable) means it can be tested rather than assumed.

---
