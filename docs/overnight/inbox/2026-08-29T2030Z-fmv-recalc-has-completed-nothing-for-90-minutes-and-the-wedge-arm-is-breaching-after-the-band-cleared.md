# `fmv-recalc` has completed NOTHING for 90 minutes and `fmv_sweep_wedge_hours` is breaching — and it kept killing AFTER the IO band cleared

**2026-08-29 13:3x PT / 20:3xZ · Claude Code (Trevor's box)**
**Found by a closing health sweep, not by looking for it. FILED, NOT ACTED ON — this is the documented `fmv-recalc` item and it is Trevor's/the roadmap's, not a thing to change at this hour.**

---

## The measurement

| instrument | reading | threshold |
|---|---:|---:|
| `fmv_sweep_wedge_hours` (trust arm) | **4.30 h and rising** | BREACH at 3 |
| last terminal `fmv-recalc` row | **2026-08-29 18:48:06Z** | — |
| last `fmv-recalc-heartbeat` | 2026-08-29 20:15:46Z | — |
| **terminal rows, last 90 min** | **0** | — |
| **heartbeats, last 90 min** | **8** | — |
| 24 h totals | 146 heartbeats / **59 terminal** (59.6% killed) / 25,515 rows written | documented 64–73% |

**Every heartbeat carries `{"phase":"started","offset":0,...}` — the sweep starts at page 0 on every
invocation.**

## ⚠ What this is NOT — the two ways to over-read it, both refuted here

1. ⛔ **It is not a kill-streak alarm.** This repo's own rule is *"alert on
   `hours_since_last_completion`, NOT kill count/streak — fmv-recalc: 38-kill streak, healthy."*
   **8 consecutive kills against a documented 64–73% base rate is P ≈ 0.7⁸ ≈ 6% — unremarkable.**
   The streak is not the finding and must not be quoted as one.
2. ⛔ **It is not "the pipeline is broken".** `fmv-recalc` was **re-characterised 2026-08-17 as
   wasteful, NOT broken**, and it still wrote **25,515 rows in 24 h**. The 59.6% kill rate measured
   here sits inside the documented 64–73% band. **Nothing here contradicts that characterisation.**

## ⭐ What IS worth a row, and it is one specific thing

**The band cleared and it kept killing.** Today's daytime IO band was exceptionally severe
(`io_wait 40 / active 41 of 51` at 18:06Z, ~4–5× the previous day). Band collateral would be the
obvious explanation — **except the band was measured back to `io_wait 0 / active 1 of 42` by ~19:16Z
and `1 / 2 of 42` at 20:04Z, and there have still been ZERO terminal rows since 18:48Z.**

👉 **So "it is just the band" is not sufficient for the last ~70 minutes of it.** That is the only
claim this filing makes.

⚠ **And the two arms are measuring different things — do not conflate them.** `hours_since_last
completion` is **1.63 h**; `fmv_sweep_wedge_hours` is **4.30 h**, because it counts time since the
cursor last *ADVANCED*, not since a run last finished. **A run can complete and advance nothing.**
The gap between 1.63 and 4.30 is itself the signal: runs were completing between 16:10Z and 18:48Z
**without moving the cursor.**

## ⛔ NOT established

- **Why it is killing now.** No route-level diagnosis was attempted; the band explanation is
  *insufficient*, not *excluded* (a spell can leave a cold pool behind it).
- **Whether the catalogue is actually going stale.** `*_fmv_stale_hours` arms are all green — but the
  wedge arm's own text says that family **structurally cannot see a sweep outage**, because other
  writers (cold-tail, thin-sales-guard, ask_only) keep touching `computed_at`. **So green there is not
  evidence of health, and I am not treating it as either direction.**
- **Whether 4.30 h is abnormal.** The arm's calibration window (which INCLUDES the 2026-08-05
  incident) records gap p50 0.20 h, p95 0.55 h, **max 6.00 h**. **4.30 h is a genuine breach and still
  below the historical max** — elevated, not unprecedented.
- ⚠ **n is one afternoon.** A 90-minute completion gap on a pipeline that completes ~59×/24 h
  (~1 per 24 min) is roughly 4× its mean interval. **That classifies; it does not rate.**

## 👉 Falsifier, cheap and dated

**Re-read `fmv_sweep_wedge_hours` and `max(started_at) WHERE pipeline='fmv-recalc'` on the next
monitor tick.**
- **Cursor advances and a terminal row appears ⇒ this was a long tail of the 08-29 band; close it.**
- **Still zero terminal rows several hours into a quiet instance ⇒ it is NOT the band, and the
  route-level kill cause becomes worth chasing** — at which point the relevant prior is the
  documented `after()`-kill class (heartbeat present, terminal row absent, `try/catch` cannot catch a
  `maxDuration` kill), and `npm run pipelines:kills` classifies it rather than re-deriving by hand.

⛔ **Do NOT raise `max_duration_s` on this in response to the arm.** The documented characterisation
is that the job is *wasteful*, so a longer budget buys a longer failure; and the 08-27 finding stands
that a function's declared timeout is inert on the pg_cron path anyway.
