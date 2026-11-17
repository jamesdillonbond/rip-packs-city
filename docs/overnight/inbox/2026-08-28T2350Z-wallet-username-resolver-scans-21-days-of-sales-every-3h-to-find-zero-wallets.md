# `wallet-username-resolver` rebuilds a 21-day, ~118k-row candidate universe every 3 h to find **0–11** wallets, and dies at its own 60 s ceiling on 57% of ticks

**2026-08-28 23:50Z · Claude Code**

## The signature is unusually clean

Every failure is the SAME duration, to within 60 ms:

| started | ok | duration_ms | rows_found | resolved |
|---|---|---:|---:|---:|
| 21:08Z | ❌ | **60,131** | 0 | 0 |
| 18:08Z | ❌ | **60,170** | 0 | 0 |
| 15:08Z | ❌ | **60,139** | 0 | 0 |
| 12:08Z | ❌ | **60,191** | 0 | 0 |
| 09:08Z | ✅ | 40,972 | 1 | 1 |
| 06:08Z | ✅ | 13,733 | 11 | 6 |

⭐ **That flat ~60.1 s is not saturation noise — it is `wallet_usernames_unresolved`'s OWN
`statement_timeout=60s` in `proconfig`, firing exactly.** 48 h: **6 ok / 8 failed (57.1%)**.

🚨 **`rows_found = 0` on every failure means it dies in CANDIDATE SELECTION, before any resolution work
is attempted.** The successful runs found **1** and **11**. So the job is spending a minute of an
IO-budgeted instance to discover that there is almost nothing to do — **8 ticks/day × ~60 s of heavy
scan**, on the constraint CLAUDE.md names as binding.

## Where the cost is (plan only — deliberately not ANALYZEd, to add no load)

Total estimated cost **110,862**. The shape:

- 21 days of `sales` via `idx_sales_2026_pulse_window` (~58k rows) **cross-joined to buyer+seller →
  ~116,779 rows**
- plus two `pack_purchases` index-only scans (~29,182 and ~28,992)
- → `Partial HashAggregate` over a **Parallel Append of ~118,885 rows**
- → **only then** a `Hash Right Join` against `wallet_usernames` (8,794 rows, Seq Scan) that filters the
  whole thing down to an estimated 1,174 — and, measured, to **0–11**

⭐ **The whole 21-day candidate universe is materialized and aggregated BEFORE the anti-join throws
essentially all of it away.** That is the cost, and it recurs in full every three hours.

## The lever, and the reason it was NOT taken here

⛔ **Not shipped: the obvious fix is to narrow the 21-day window, and I could not establish what that
window is FOR.** It plausibly exists to serve the retry clause — `wu.username IS NULL AND
last_attempted_at < now() - interval '14 days'` — which can only re-surface an address that is STILL
inside the activity window. **If so, 21 days is load-bearing at 14+ and shortening it silently drops the
retry cohort.** That is a semantic question about intent, not a cost question, and guessing it is exactly
the "plausible mechanism is not a measurement" failure this repo keeps recording.

⛔ **Do NOT just raise the 60 s `statement_timeout`.** It would convert a fast failure into a slow one and
do MORE IO — the standing rule is cut work, never raise the bound. (It is also within ~2× of the ~120 s
gateway cap, so there is little room anyway.)

👉 **The lever that does not need the semantic answer: make the scan INCREMENTAL.** New addresses only
ever enter via recent activity, so the per-tick scan needs the window since the last successful run
(~3 h), with the full 21-day sweep kept for the retry cohort at a much lower cadence (say daily, in a
quiet slot). That splits one expensive query into a cheap frequent one and a rare expensive one, which is
the same *cut items per tick* shape CLAUDE.md prescribes.

## What is NOT established

⛔ **The user impact is LOW and should not be overstated** — `wallet_usernames` is display cosmetics, and
demand is WAU 2. **The argument for fixing this is IO waste, not user harm.** Anyone picking it up should
weigh it that way and not against a user-facing board.
⛔ **NOT measured: what the query actually costs in BUFFERS.** Only the planner's estimate is quoted
above; I did not ANALYZE it, precisely because doing so would run the 60 s scan I am complaining about.
**A cost estimate is not a measurement — take BUFFERS in a quiet window before sizing any fix.**
⛔ **NOT established: that 57.1% is stable.** n = 14 over 48 h, and the two successes are the two ticks
that happened to find work. The failure rate may simply track how empty the queue is.
