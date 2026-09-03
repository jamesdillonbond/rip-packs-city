# `days_to_drain` says 25 days while the resolver's own telemetry says `onchain_unproductive: true` — the AllDay unmapped pile is at its floor, not draining

**Filed 2026-09-03 ~07:30 PT (14:30Z) by Claude Code. NOTHING SHIPPED.** The fix is an alert-semantics
change inside a DB function, which is a migration and a judgement call about what the alert should say.

## 0. Why I was looking

`R78` records that the fleet alarm is pinned CRITICAL, so *"a NEW critical cannot change either
signal"* — the only way to know whether something is masked is to look. ✅ `get_pipeline_alerts_core()`
returns **exactly one alert, severity `info`**, so nothing critical is hiding. But the one alert is
wrong in an interesting way.

## 1. What the alert says

`unmapped_backlog_growth_cache` (id=1, `refreshed_at` 13:29:00Z, ~25 min old at reading):

```
open_actionable_rows 42090 · inflow_24h 42 · outflow_24h 1718 · net_24h -1676 · days_to_drain 25.1
```

`days_to_drain` = `open_actionable_rows / |net_24h|` = 42090/1676 = 25.1 ✓ — internally consistent.

## 2. ⛔ BUT THE RATE IT DIVIDES BY IS ALREADY GONE

Hourly `rows_written` for `allday-unmapped-resolver{,-tail}` from `pipeline_runs`, and this is a
**distribution, not two snapshots**:

| hour (UTC, 09-03) | 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 | 12 | 13 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| rows | 320 | 338 | 149 | 142 | 219 | 248 | 265 | 61 | 124 | 27 | 4 | 12 | 11 | 2 |

09-02 peaked at **1,187/h (06Z)** and **1,054/h (10Z)**. The last four hours total **29 rows** — about
**7/hour**. ⭐ **A ~150× decline, monotone over roughly six hours, so it is not a burst artifact of the
trailing window.**

At 7/hour the 42,090 actionable rows would take **~250 days**, not 25. ⚠ **And the two prior published
ETAs were both computed the same way and are both superseded**: the 04:45Z filing quoted *"~9.2 days to
clear"* off `outflow 4,672`, this cache says 25.1 off `1,718`. **`days_to_drain` is a trailing-24 h rate
presented as a forecast; on a decaying series it reads high and keeps reading high.**

## 3. ⭐ THE ROUTE'S OWN TELEMETRY ALREADY SAYS WHY, and it is not a failure

`extra` for the 13:16:14Z run — `ok: true`, `error` empty, `fatal: null`:

```
candidates 33 · needing_onchain 33 · onchain_attempted 33 · decode_attempted 33
onchain_nil 33 · onchain_resolved 0 · mappings_written 0
onchain_unproductive: TRUE          ← the route's own flag
window_reattempt 37
```

**Every on-chain lookup returned nil.** The 13:36 and 13:56 runs report `candidates: 0` — nothing even
offered. So the resolver is **healthy and out of tractable work**: it has cleared what this method can
clear, and the remainder is not resolvable by it.

⭐ **`onchain_unproductive: true` is a self-diagnosis the alert does not read.** The per-run `extra`
knows the pile is at its floor while the cached payload publishes a three-week countdown.

## 4. The arithmetic ties out, which is the control

Summing the table above from 06Z to 13Z gives **506 rows**. The actionable pile moved **42,590 (04:45Z)
→ 42,090 (13:29Z) = −500**. ⚠ The windows are not exactly aligned, so treat this as *the magnitudes
agree*, not as an exact identity — but it does establish that **the pile tracks `rows_written`**, so the
collapse in throughput IS the collapse in drain, not a measurement artifact.

## 5. What the fix looks like — and why it is not shipped here

The honest alert would **qualify or withhold `days_to_drain` when recent yield is ≈ 0**, the same rule
this repo applies to a failed read: do not publish a number that reads as progress when the underlying
process has stopped making any. The inputs already exist — `onchain_unproductive` per run, and a short-
window `rows_written` sum — but they are not in the cached payload.

⛔ **Not shipped because:** it is a change to `refresh_unmapped_backlog_growth`, i.e. a migration and a
`~10–20 s` user-facing `PGRST002` burst, **and** it is a semantics decision — is the right answer
`days_to_drain: null` with a `stalled: true`, or a severity bump from `info`? A stalled 42k backlog that
nothing can resolve may deserve more than `info`, and that is a product call.

## 6. ⚠ What NOT to conclude

- ⛔ **"The resolver is broken."** `ok: true`, no errors, `fatal: null`, runs firing 15–20×/hour. It is
  succeeding and finding nothing.
- ⛔ **"The backlog is growing."** It is not — inflow 42/24 h against any outflow. It is **flat at its
  floor**, which is a different and more permanent problem than growth.
- ⚠ **Do not quote ~250 days either.** It is the last four hours extrapolated; the honest statement is
  *"the current rate is ~7 rows/hour and the published ETA divides by a rate that no longer exists."*
- ⓘ `ufc_strike` in the same payload is **1,070 open, inflow 0, outflow 0, `days_to_drain: null`** —
  ⭐ **that is the shape a stalled backlog SHOULD report**, and it is right there in the same array.
