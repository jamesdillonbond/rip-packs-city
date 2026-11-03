# Inbox 2026-11-02T1900Z — Panini ingest throughput down + old catalogue starving (read-only diagnosis, needs Claude Code)

Source: scheduled Panini freshness check ~11:00 AM PT 11-02 plus a follow-up diagnosis pass. Nothing was changed (DB, repo, laptop, Task Scheduler, scheduled-check prompt). Full write-ups in the Rip Packs City project: `claude/panini-throughput-diagnosis-2026-11-02.md` and `…-addendum.md`.

## Verdict
Runner is firing and authenticated (7 walks/24h, fmv_yield 1.00, stalest-first order intact, known_complete true) but does far too little work per walk.
- Yesterday 11-01: 1,832 editions priced = 36% of trailing-7, 4.6% of the 40,154-edition catalogue, 28% of days 8-28 baseline (6,522/day).
- Daily editions priced: 10-22 7,774 · 10-23 8,146 · 10-24 7,513 · 10-25 8,078 · 10-26 6,984 · 10-27 8,905 · 10-28 6,105 · 10-29 1,517 · 10-30 970 · 10-31 3,108 · 11-01 1,832.
- Old catalogue starving (Escalation 5): 14,576 editions un-repriced 7+ days, oldest 251.5 h, median old age 143.8 h, 0 walked in last 24 h. A starvation, not unretired prices. At ~3k/day a full pass over 40k takes ~12-13 days, so it cannot clear by itself.

## Cause so far
1. 10-29 ~06:00 → 10-30 ~17:00 PT: laptop runner dark (known; see handoff-2026-10-30-flowty-retirement). Recovered.
2. 10-31 onward is NOT the outage. Walks run ~180-195 min but write only 400-720 editions (was 1,500+ through 10-27). Batches are 1 edition, ~38-40 s apart, 390 serials per card.
3. Measured s/edition by serials per edition (70 h): ≤30 → 9.6 s · 31-100 → 10.8 s · 101-250 → 17.4 s · 250+ → 28.9 s. Heavy print runs (250+) are ~23% of editions but ~31% of walk time. Serial paging explains ~1.5x, not the whole 2-3x. Even light cards cost ~10 s, which points at per-page latency (Panini or browser).
4. Not proven: why per-card time rose after 10-28. Ruled out: walk order, enumeration time, FMV write path, pricing quality (repeat HI/MED 55.4%, n=3,529; algo panini-1.4.0 alone).
5. Evidence needed: %USERPROFILE%\panini-run.log on the laptop (`walk done N/M in Xm`, `serial paging: cards_paged=… extra_pages=…`). It is outside the Cowork-connected folders.

## Proposed fixes (none applied)
A. Read the last 3 `walk done` / `serial paging` lines in panini-run.log to see whether paging or page latency dominates.
B. Lower `PANINI_SERIAL_PAGES` (default 12 extra pages, runner line ~590) to ~6 in the Task Scheduler environment, or page only cards whose serials are stale > 7 d. Edition price does not use serial pages. Kill switch =0. Trade-off: serial-grain freshness (sales_missed).
C. Close the idle gap: walks end ~60 min before the next starts. Budget defaults are 75 min full / 105 min walk-only with RUN_DEADLINE 110 min (runner lines ~906/911) and the task repeats every 2 h with IgnoreNew (panini-schedule-every-2h.ps1); the ~180 min walks are chained runs, so change PANINI_WALK_BUDGET_MIN / PANINI_RUN_BUDGET_MIN in the task environment, not the script default.
D. Optional code: an aged-priority line so editions > 7 d old go ahead of fresh stalest-first ties (walk-order merge in scripts/ingest-panini-runner.mjs ~483-511, app/api/cron/panini-ingest/route.ts ~276-323). Run __tests__/api-cron-panini-ingest-walk-order.test.ts and `node --check` before and after.
E. Check-spec: with a ~12-day pass the Escalation 5 `old_older_7d >= 5` rule fires daily by design; gate on age only (oldest > 216 h) in the scheduled check `trig_01K68ddYeWqUumNN2RavC4ht` (11 AM PT daily). Not edited from the cloud.
F. Laptop reliability: confirm panini-keep-awake.ps1 and the power plan; a second outage reproduces the dip.

## Success test
Query 4/4b: pct_of_baseline > 55 and old_max_age_h falling toward < 168 within ~2 weeks; expect ~6-7k editions/day after B+C.

## Disposition — 2026-11-03 ~8:00 AM PT (Claude Code cloud): fix D is NOT needed; this is throughput only

Re-derived live before acting on the "optional code" fix:
- **Aged priority already exists and is working.** `app/api/cron/panini-ingest/route.ts` serves editions not walked for 5 d in `priority_pskus` (`PANINI_AGED_PRIORITY_DAYS`, cap 300/run) and puts ≥ 6 d ones BEFORE the held/aged interleave (`PANINI_AGED_CRITICAL_DAYS`, 10-10). Fix D as written would duplicate it.
- **The live age histogram shows stalest-first draining the oldest day first:** `panini_editions.last_seen_at` by PT day — 10-23 880 · 10-24 4,126 · 10-25 4,424 · 10-26 3,693 · 10-27 7,640 · 10-28 6,105 · 10-29 1,517 · 10-30 970 · 10-31 3,108 · 11-01 1,832 · 11-02 3,925 · 11-03 (to 8 AM) 1,936. The 10-23 bucket is the remnant of a ~4k day (the walk is eating it); no older day survives. "0 old editions walked in 24 h" does not match this — 4,493 editions were walked in 24 h and the oldest buckets are the ones shrinking.
- **Scope is not the cause:** all 40,156 editions belong to `walk_cards = true` products.
- **The arithmetic:** holding the whole catalogue under 7 d needs ≥ 40,156 ÷ 7 ≈ **5,740 editions/day**; recent days did 970–3,925. Whatever the walk order, `> 7 d` grows while throughput is below that line. So the levers are **B (`PANINI_SERIAL_PAGES`) and C (walk/run budget) in the laptop's Task Scheduler environment, plus F (keep-awake)** — Trevor's machine, not the repo. **A (`panini-run.log`) still decides between B and C.**
- **E (check spec)** stands: with throughput under 5.7k/day, `old_older_7d >= 5` fires daily by construction.

No repo change. Status: **QUEUED for Trevor (laptop env)**, code side closed.

---

## 🔎 2026-11-03 ~9:15–9:40 AM PT (Cowork cloud + laptop) — evidence A read; the unproven cause found and fixed

`panini-run.log` (511 walks) answers item A: per-card time tracks **`tab_missed`**, not serial paging. ~6 s/card on walks where the sales tab opened (10-21..10-27), 13–25 s/card where `tab_missed` dominated (most walks since 10-28). The ops capture (11-03 11:00–17:00Z) shows why: 696 of 1,440 TOP-SALES reads came back HTTP 200 with `data: null` — on editions that do have sales (10/10 sampled hold 4–40 `panini_sales` rows) — while RECENT reads were empty only 6 of 727. The runner waited for RECORDS, so each such card spent ~5 s + a second ~5 s on the third locator, then skipped RECENT.

Fixed in `bfe6467` (wait ends on a RESPONSE; an empty TOP answer still reads RECENT; log adds `tab_empty=` / `responses=`), copied in place to the laptop (sha256 `c34b1909…`). Levers B and C were NOT applied — re-judge them after the fix's first day. Verification of the 10:00 AM PT run is scheduled for 11:55 AM PT.

**~10:20 AM PT addendum:** the 10:00 AM run — the first on `bfe6467` — never reached its card walk: the laptop slept ~7 min during enumeration (`WATCHDOG slept: phase=enum … clock jumped 7m`) and the CDP reconnect timed out (`rc=1` at 10:18). This happened even though `panini-keep-awake.ps1` holds a wake request for the run, which makes it the fourth `WATCHDOG slept` in the log. Sleep mid-run is a second, independent loss of walk time, still Trevor's (power settings / an always-on box). Verification moved to the 12:00 PM run (check scheduled 12:45 PM PT).
