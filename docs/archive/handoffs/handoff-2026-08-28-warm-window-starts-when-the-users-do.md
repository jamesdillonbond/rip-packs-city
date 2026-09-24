# Handoff — the buffer warmer reopens at the same minute the first users arrive

**One character in `vercel.json`.** Measured, not proposed.

⚠ **SCOPE OF THE NO-PUSH NOTE:** the session that measured this is a Cowork **cloud** session and
cannot push (git proxy: *"not in this session's authorized repository set"*). **That is a fact about
that session.** Trevor's machine and Claude Code push normally via the PAT in
`remote.origin.pushurl` — **commit this as usual.**

## Context

Already shipped live by Cowork (DB only, no push needed): `audit_20260828_underpriced_board_cost` +
pg_cron `rpc-audit-underpriced-board-cost` (`*/10`, self-unschedules 2026-08-30) — the instrument
that produced the numbers below. Known-issues **#39** and the 2026-08-28 ledger entry carry the full
account. HEAD at time of writing: `209b6a2`.

## The change

**File:** `vercel.json` — the `/api/cron/warm` entry (line ~21).

```diff
       "path": "/api/cron/warm",
-      "schedule": "*/10 14-23,0-5 * * *"
+      "schedule": "*/10 13-23,0-5 * * *"
```

⚠ **Verify the file still has exactly one `/api/cron/warm` entry before editing** — `vercel.json`
holds ~36 cron entries and the count is documented as having been quoted stale once.
`grep -n '"/api/cron/warm"' -A2 vercel.json`.

## Why — measured over 9 hours, 55 samples

| interval (UTC) | calls | mean ms | |
|---|--:|--:|---|
| 05:10 – 06:00 | 9 | **291 – 689** | inside the window — **the warmer works** |
| **12:20** | 1 | **5,516** | inside the 8-hour hole |
| 14:00 | 2 | **2,131** | window reopens = **07:00 PT** |
| 14:10 | 1 | **4,153** | still re-warming |

- The window `*/10 14-23,0-5` leaves hours **6–13 UTC = 23:00–06:00 PT** unwarmed.
- ⭐ **It reopens at 14:00Z = 07:00 PT — the same moment the first Pacific users arrive — so the
  first users of the day pay for the re-warm rather than benefit from it.**
- Starting at **13 UTC (06:00 PT)** gives the buffers one hour of warming before the first user.

**Cost:** 6 extra ticks/day × ~400 ms ≈ **2.4 s/day** of DB time on an IO-bound instance. The route's
`maxDuration` is 30 s and its three warm targets already fit; this adds no work per tick, only ticks.

## Verification

- `npx tsc --noEmit` clean (it is a JSON edit; the guard that matters is the deploy).
- Vercel deploy reaches **READY**, and the crons list shows `*/10 13-23,0-5` for `/api/cron/warm`.
- **The real check is the next morning:** the first calls at/after 14:00Z should be **sub-second**,
  not 2–4 s. Read it with the instrument while it lives (retires 2026-08-30):

```sql
SELECT to_char(at,'HH24:MI') AS t,
       calls - lag(calls) OVER (ORDER BY at) AS d_calls,
       round((total_ms - lag(total_ms) OVER (ORDER BY at))::numeric
             / nullif(calls - lag(calls) OVER (ORDER BY at),0)) AS mean_ms
FROM public.audit_20260828_underpriced_board_cost ORDER BY at;
```

## Revert

Restore `"*/10 14-23,0-5 * * *"`. No data, no schema, no other surface touched.

## What this is NOT

⛔ **Not the escalation #39 reserves.** That entry says: *"If cold 503s persist, that is the next
step"* — meaning the snapshot cache. **This is cheaper and addresses a different thing: the warmer
is working, its window just starts too late.** If means stay above ~1 s **deep inside** the window on
2026-08-29 (not merely at the reopen), the snapshot cache is still the answer and this change does
not pre-empt it.

⚠ **n is small — 3 calls in the hole, 3 at the reopen.** This is a shape, not a distribution. The
change is justified by the *mechanism* (an 8-hour cold gap ending exactly at the traffic ramp), which
does not depend on n, and by its near-zero cost. **Do not quote the 5,516 ms as a typical figure.**

⚠ **Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual
file shape.**

**Expected end state:** one commit on `main`, deploy READY, and the first board calls of the Pacific
morning sub-second instead of multi-second.
