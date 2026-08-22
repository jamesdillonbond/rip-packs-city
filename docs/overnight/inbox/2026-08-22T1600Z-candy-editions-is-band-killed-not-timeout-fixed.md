# `candy-editions-ingest` — the 08-04 timeout fix SHIPPED and it is silent again for the same reason at a higher ceiling

**Filed 2026-08-22 ~09:00 PT (16:00Z), Claude Code interactive, triaging a live sentinel WARN. MEASURED.
Two fixes SHIPPED this turn (see the ledger); this one is deliberately NOT shipped — see §5.**

---

## 1. Why this is not the item the watchlist note says it is

The watchlist row still carries the 2026-08-03/04 diagnosis: *"this arm was NOT silent, it was being
KILLED … route maxDuration=300 vs a Vercel Pro ceiling of 800. Fix handed off."*

⚠ **That fix SHIPPED.** `app/api/ingest/candy-editions/route.ts:45` carries `export const maxDuration =
800`, verified in the tree today, and the handoff's own header records it as Item 1 shipped and verified.
**The arm is stalled anyway.** Reading the note as "known, fixed, ignore" is the trap — it is the same
failure mode at a ceiling 2.7× higher, and the note has been appended with a dated correction so the
next responder does not re-derive this.

## 2. The measurement

Last successful run **2026-08-19 08:40:27Z**. Missed: **08-20, 08-21, 08-22** — and **08-16, 08-17,
08-18** before that. `duration_ms_max` per run, with the control that matters in the same row:

| day | duration | rows_written |
|---|---:|---:|
| 07-30 | 68.5s | 28,483 |
| 07-31 | 61.4s | 28,483 |
| 08-01 | 71.4s | 28,483 |
| 08-02 | 197.4s | 28,483 |
| 08-05 | 280.6s | 28,483 |
| 08-07 | 81.2s | 28,483 |
| 08-10 | 216.9s | 28,483 |
| 08-11 | **475.0s** | 28,483 |
| 08-12 | 73.4s | 28,483 |
| 08-14 | **461.6s** | 28,483 |
| 08-15 | **507.6s** | 28,483 |
| 08-19 | **479.7s** | 28,483 |

🚨 **`rows_written` is byte-identical at 28,483 on EVERY run, so the WORK IS CONSTANT and every bit of
the 8× duration spread is contention.** That control is what makes this readable — without it, a
61s→508s climb would read as data growth, and the fix would wrongly be "chunk the payload".

**Max successful run 507.6s against the 800s ceiling — 1.6× headroom on a series whose own spread is
8×.** The missing days are the ones that crossed it.

## 3. Why it presents as silence and not as failure

⚠ **A killed run leaves NO `pipeline_runs` row at all** — the route logs only on completion. So the
outage renders as absence, never as `ok = false`. This is the same class as the `after()` kill CLAUDE.md
records, and it is why `detect_stalled_pipelines()` returns `silent_minutes = NULL` here rather than a
number.

⚠ **That NULL used to render in the alert as the literal string `silent nullm`** — the arm's most severe
reading, displayed as what looks like a cosmetic template bug. **Fixed this turn** (see the ledger); it
now states the case instead. That fix is what made this item legible enough to triage at all.

## 4. The cause is the SCHEDULE, and the ceiling is not available as a lever

The cron fires at **08:40Z**, squarely inside the measured **01:00–19:00Z disk-IO degraded band** where
the estate runs 3–18× slower. The intermittency matches: a ~70s baseline survives a 3× band, and dies
at 8×+.

⛔ **Raising the timeout is not available and is not the lever anyway.** 800 is the **Vercel Pro hard
cap** — above it the deploy goes to ERROR *invisibly*. CLAUDE.md is explicit: cut work, or move out of
the band; never raise a timeout, never upgrade the tier.

## 5. ⚠ Why I did NOT ship a fix, stated rather than quietly skipped

Two candidate levers, both real, neither taken:

- **(a) Move the Vercel cron into the healthy 20:00–00:00Z window.** One line in `vercel.json`. ⚠ **But
  it needs a stagger check I did not do:** there are **36** Vercel crons, the repo has an explicit
  stagger discipline, and that same window already has **two migrations scheduled tonight (20:15Z,
  21:15Z)** plus the proposed 23:10Z/23:25Z moves for jobids 60/4 from the cross-collection escalation.
  Dropping an ~8-minute job into that window unexamined trades one contention problem for another.
- **(b) The `paginateGroup` chunking**, Item 2 of `docs/handoff-2026-08-04-candy-editions-timeout.md`,
  still deliberately unshipped. This is the CLAUDE.md-endorsed lever (cut items per tick) — **but it is
  ingest-route logic, which is on the off-limits list for autonomous shipping.**

**Recommendation: (a), after a stagger pass over all 36 crons.** It is reversible, touches no logic, and
addresses the actual cause. (b) is the durable fix and should follow.

## 6. ✅ CONFIRMED DIRECTLY — this is an observation, not an inference

The paragraph that stood here said "killed at the wall" was **inferred** from the absence of a completion
row, and named the check that would settle it. **That check was then run, and it confirms the reading.**
`get_runtime_errors` on `/api/ingest/candy-editions`, 3-day window:

```
Vercel Runtime Timeout Error: Task timed out after 800 seconds
count=3   routes=/api/ingest/candy-editions
last=2026-08-22T08:40:05.000Z
```

**Three kills in three days, and the last is stamped 08:40:05Z — the cron minute exactly.** The count
matches the three missing days (08-20, 08-21, 08-22) one for one. So the route is reaching the **800 s**
wall, not failing to fire.

⚠ **One caveat kept, because CLAUDE.md records it:** `get_runtime_errors`' `routes=` filter is SMEARED,
so the route attribution alone would not be trustworthy. It is trustworthy *here* because two
independent things corroborate it — the error text names the 800 s ceiling this route uniquely carries,
and the kill count equals the missed-day count exactly.

## 7. What this still does NOT say

It does not establish that the **band** is the cause of the slowdown — only that the route is being killed
at 800 s while doing constant work. The band is the best-supported explanation (8× spread on identical
input, schedule inside the measured window) but it is not proven here, and a per-run buffer comparison
would be needed to close that. **The recommended fix does not depend on it:** moving out of 01:00–19:00Z
is correct if the band is the cause, and harmless if the true cause is some other daytime contention.
