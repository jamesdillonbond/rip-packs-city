# The backstop fired, got a 202, and produced nothing — and two of the three monitor items dissolve under measurement — 2026-09-12T04:00Z

Filed by Claude Code on Trevor's box (interactive, 2026-09-11 20:5x PT). Drains the three items in
`2026-09-12T0309Z-daytime-monitor.md`. The instance was **quiet** throughout (the 20:49 PT control run
below completed in 58.6 s), so these are readings, not spell artifacts.

**Headline: all three suggested actions were wrong, and in three different ways.** One was
unreachable-by-policy and unnecessary, one rested on a "transient" claim the 45-day distribution
refutes, and one was already fixed in shipped code. The findings underneath them are real.

---

## 1 · HIGH — the monitor said "check the cron-job.org console". The heartbeat already answers it, and the answer is worse

⛔ **The console is off-limits** (its bearer has leaked twice) — and it is also not needed. This route
writes a heartbeat *before* the work precisely so "never fired" can be told from "fired and died".

**`cron_heartbeats` for 09-11 reads `edge_runwork_start` at 05:15:xx PT.** So something fired, and the
edge function got as far as `runWork()`. ⭐ **That timestamp is 12:15:15Z, which matches the GHA
backstop's fire exactly** (`gh run list`: 2026-09-11T12:15:15Z, conclusion **success**).

**What the backstop actually got back** — from its own step log:

```
snapshot-institutional-wallets status: 202
{"accepted":true,"edge_status":200,"edge_body":{"ok":true,"message":"queued",
 "started_at":"2026-09-11T12:15:24.277Z","function_version":2,
 "note":"Real results will appear in pipeline_runs within ~10-30s."},"attempts":1}
```

🚨 **They never appeared.** No `pipeline_runs` row for 09-11, and — the reading that actually matters —
**no rows in the OUTCOME table**:

| `wallet_holdings_snapshot.snapshot_at` | 09-04 | 09-05 | 09-06 | 09-07 | 09-08 | 09-09 | 09-10 | **09-11** |
|---|---|---|---|---|---|---|---|---|
| rows | 3 | 3 | 3 | 3 | 3 | 3 | 3 | **0** |

⛔ **The 09-11 gap is PERMANENT.** `snapshot_at` is the UTC date *at run time*, so a holdings snapshot
for a past day cannot be taken later. Re-firing does not recover it — it only produces today's.

⭐ **POSITIVE CONTROL, because "it failed" is not a diagnosis.** I dispatched this same workflow at
**20:49 PT on a quiet instance**: `ok=true, rows_written=3, elapsed_ms=58639, pages_walked=257`, and
3 rows landed at `snapshot_at = 2026-09-12`. **The path is sound.** ⚠ This corrected my own working
hypothesis — I had inferred from three fires with zero run rows that the backstop was structurally
broken. It is not.

**So why did the 12:15Z fire die silently?** Healthy runs take **58.6 s / 67.4 s / 71.6 s** walking 257
pages of `wallet_moments_cache`. The work happens in `EdgeRuntime.waitUntil(...)`, and **a wall-clock
kill of that task cannot be caught by the function's `try/catch` OR its `.catch()`** — every terminal
path in the function writes a `pipeline_runs` row (success, no-wallets, `skipped_in_progress`, even
`panicked`), so *zero rows* means the isolate was killed before any of them ran. 12:15Z sits inside
the morning IO-saturation window the monitor documents on the same day (pg_cron timeouts at 08:30Z,
08:55Z, 09:45Z, 12:20Z). A 58–72 s walk has little margin to the wall when the instance is starved.

🚨 **AND THE SCHEDULE IS NOT WHAT THE FILE SAYS.** Nominal `29 7 * * *`; observed, 8 consecutive fires:
**11:18 · 11:41 · 12:10 · 12:11 · 12:15 · 12:16 · 12:23 · 13:34 Z** — **+3h49m to +6h05m late**. The
workflow's own STALE-RATIONALE note reasons from the nominal cron and concludes the backstop "LEADS
the primary by ~2h38m". It does not: it **trails** the 10:07Z primary by ~2h and lands in the spell.
**Corrected in the file this turn, with the measurements inline.**

⛔ **Not re-timed, and the reason is a number:** the observed delay spread is **over two hours wide**,
so no nominal minute maps to a predictable fire time. Re-timing would be a guess dressed as a fix.

⭐ **What did NOT fail: detection.** The pipeline watchlist flagged the silence as `high` on its own.
Nothing here needs a new instrument. **Impact is small and should be stated as such — 3 rows/day for
2 wallets** — which is why this is filed rather than hot-fixed on a Friday night.

**Open and genuinely Trevor's:** why the cron-job.org primary (10:07Z) did not fire on 09-11 at all.
That is a console question and the console is off-limits to me.

---

## 2 · MEDIUM — "upstream timeout is transient; a re-fire likely succeeds" is refuted by the 45-day distribution

`pipeline_runs` retains ~73 h, so the monitor could only see one failure. **`pipeline_runs_daily` is
indefinite**, and it tells a different story — `match-topshot-players`, last 45 days:

- **11 of 37 non-gated runs failed = 30%**, every one `rpc_failed: upstream request timeout`.
- ⛔ **Eight CONSECUTIVE failures, 08-14 → 08-21.** That is not a transient upstream.
- Failure durations cluster at **125.3–126.2 s**. Successes run **12.8 s → 120.4 s**.

⭐ **THE SHAPE: the success band's upper tail is ON THE WALL.** The Supabase gateway caps at ~120 s;
the job's best observed *success* is **120,444 ms**. Whether a run succeeds is decided by how loaded
the instance is that minute, not by the upstream. ⚠ And per CLAUDE.md, `upstream request timeout` is
the **gateway**, not Postgres's `statement_timeout` — the two produce the same ~2-minute number and
mean different things.

⚠ **This got worse when the pipeline was gated to weekly** (09-04 onward: `gated: true`, 0.4–1.2 s
ticks). A 30%-per-run failure rate with **no retry and a 7-day gap** means roughly **one week in three
gets no player matching at all**, and 09-11 was one of them — the exact tick ledger #54 recorded as
owed.

⛔ **I could not re-fire it:** it is an edge function with no pg_cron job and no workflow, so the only
trigger is the cron-job.org console (off-limits) or its gate key (a secret). Stated rather than
quietly skipped.

**The real fix is not a re-fire** — it is the same one that worked for `rpc-topshot-onchain-rekey`:
bound the work per invocation so it finishes well under the gateway cap, instead of a single RPC that
straddles it.

---

## 3 · LOW — the empty board is honest, already explained in shipped code, and my explanation for it was wrong

Live read, `/api/public/insights/pack-reality?limit=5`:

```
HTTP 200 · top_ev: 0 · meta.errors: 0
ranker_staleness: {"stale_count":3,"newest_qualifying_snapshot":"2026-08-28T16:25:16Z"}
```

⭐ **`meta.errors: 0` settles the honesty question** — the read succeeded, so this is a genuine empty,
not a failure rendered as one. And the page already implements the **third state**: its own comments
name the trap ("*an empty ranker had exactly two renderings — read failed, or 'No +EV packs right
now.' The second is a claim about the MARKET*"), and `ranker_staleness` is non-null **only** when the
read succeeded, the board is empty, and packs would qualify but for staleness. **No action: the
honesty machinery the monitor was worried about is present and working.**

⚠ **My first explanation was wrong and the correction is the useful part.** I found
`compute-topshot-pack-ev` last ran **08-30** and the newest qualifying snapshot is **08-28**, and
inferred the ranker had been starved by a dead lane. **Checked instead of shipped** — the MV gates on
`pev.snapshotted_at >= now() - '48:00:00'` against `pack_ev_latest`, and Top Shot's newest
`snapshotted_at` there is **09-11 20:25 PT, 20 minutes old**, with **149 rows fresh inside 48 h**. The
Atlas lane (`topshot-atlas-pack-ev`, 451 runs / 25,707 rows through 09-11) replaced the old one and is
current.

**So the board is empty for the boring reason:** of 1,210 Top Shot rows, only **58** are positive-EV,
and exactly **3** pass every criterion except freshness — which is precisely the `stale_count: 3` the
API reports. Those 3 are stale packs, not a broken pipeline.

⚠ **One thing worth knowing, filed not fixed:** `rpc_ops_snapshot` reports
`public_board_empty_count = 0` — this MV is **not** on the monitored-empty list. So a public board can
sit empty indefinitely, honestly, with **nothing counting it**. That is the correct behaviour for
today's genuinely-empty state and the wrong behaviour if it ever empties for a bad reason.

---

## What changed on disk this turn

- `.github/workflows/snapshot-institutional-wallets-backstop.yml` — STALE-RATIONALE note corrected
  with the measured fire times, the 202-then-nothing sequence, and the positive control. **Comment
  only; the `cron:` is untouched** and the file still parses (`js-yaml`, schedule unchanged).
- Nothing else. No migration, no DB mutation, no schedule change.
