# `allday-pack-opens-backfill` throughput collapsed ~1,000× on 2026-08-11 — ETA to floor is now ~12 years

**Filed:** 2026-08-21 ~10:20 PT (17:20Z) · **Class:** CHARACTERISED, NOT FIXED (deploy blocked)
**Supersedes the open half of** the 2026-08-13 note *"jobid 55 is delivering only 11 of 144 expected
runs/24h (~92% loss) … cause not established — deliberately left as a characterised open question."*
Eight days on it is still ~90%, and this adds the numbers that were missing.

## The regression, from `pipeline_runs_daily` (retained indefinitely)

| day | runs | ok | rows_written |
|---|---:|---:|---:|
| 08-02 … 08-09 | **135–144** | ~100% | 69k–116k |
| 08-10 | 118 | 110 | 15,648 |
| **08-11** | **7** | 7 | 6,722 |
| 08-13 … 08-18 | 5–11 | mostly ok | 1.5k–2.5k |
| 08-19 | 15 | 6 | 123 |
| 08-20 | 26 | 5 | 23 |

**Runs/day fell 118 → 7 on 2026-08-11** against an unchanged 6-per-hour schedule (144/day).

## Cursor rate — measured as a FLOW, not a stock delta

`sum(cursor_before − cursor_after)` per day over the retained `pipeline_runs` window:
**08-19: 3,500 · 08-20: 1,500 · 08-21: 4,500 blocks/day.**

The watchlist note records ~850,000 blocks / 6h (≈3.4M/day) measured 2026-08-07, and predicted the floor
would be reached ~2026-08-14. Current cursor **84,700,248**, floor **65,264,619** → **19,435,629 blocks
remaining**. At the observed rate that is **~4,300 days (≈12 years)**, not 7 days ago.

## What is ruled out

- **pg_cron is fine.** `cron.job_run_details` for jobid 55: 135–141 `succeeded` per day, 3–9 `failed`.
  Dispatch is not the loss. (⚠ status here measures DISPATCH, not outcome — which is exactly why the
  terminal-row count below is the real signal.)
- **Not auth, and not the function.** Jobid 20 runs the SAME edge function, SAME gate key, SAME 90 s
  `net.http_get` timeout, in `forward` mode: **131 terminal rows / 72 h, p50 2.6 s**. That is the positive
  control — a shared-cause explanation has to survive the forward mode being healthy.
- **The `status 0` wedge cleared and was transient.** All 26 `status 0` + 2 `status 503` errors in the
  retained window fall in **84,704,498–84,709,748** (~5,250 blocks). The cursor is now *below* that band,
  so it walked through. ⚠ Block 84.7M sits in **mainnet24** (65,264,619–85,981,134), which the 2026-08-07
  probe measured healthy — this is NOT the pre-65M dead-spork band, and the recorded
  DO-NOT-SHIP decision for that band does not transfer here.
- **The cursor hold is correct throughout.** Every failed run logs `cursor_after == cursor_before`. No
  data loss; this is a throughput problem, not a correctness one.

## What is NOT established

**Why ~90% of invocations leave no `pipeline_runs` row.** 44 terminal rows / 72 h against ~432 dispatches.
Every code path in `supabase/functions/ingest-allday-pack-opens/index.ts` calls `logRun` — including the
tip-unreachable path, which was added on 2026-08-13 for exactly this class — with three exceptions that do
not apply here (`mode=probe`, first-init, and a 403 on the gate key).

Duration of the runs that DO log: **p50 46.8 s · avg 69.0 s · max 176.2 s**, with 18/44 over 50 s and
**11/44 over 85 s**. ⚠ That is a survivor-biased sample by construction — the runs that leave no row leave
no duration either — so it is suggestive of long runs being lost, and **not proof**. The 176 s run logged
fine, so the 90 s `net.http_get` timeout is not itself the cutoff.

**The instrument that would settle it does not exist here:** `ingest-allday-pack-opens` has no invocation
heartbeat. CLAUDE.md mandates one for exactly this shape, and the estate already runs the pattern
(`fmv-recalc-heartbeat`, `candy-listings-indexer-heartbeat`). With it, "no row" splits into *killed* vs
*never invoked* — a truth table instead of a silence.

## The lever, and why it was NOT pulled

`maxBlocks` is **settable per request**: `const maxBlocks = Number(url.searchParams.get("blocks") ?? MAX_BLOCKS)`
with `MAX_BLOCKS = 25000` (~100 event queries/run). So the window can be lowered by editing jobid 55's
`cron.schedule` command to add `&blocks=<N>` — **a DB change, no deploy, no gate-key exposure.**

⚠ **Not shipped, deliberately.** The window is only the right lever if the missing rows are long runs
being killed, and that is the exact thing not established above. Tuning a parameter against an unproven
mechanism is how a "fix" gets credited for a spell that ended on its own. Sequence it the other way:
heartbeat first, then size `blocks` from what the heartbeat shows.

## Blocked on

The heartbeat needs an edge-function deploy, and `ingest-allday-pack-opens` is one of the six functions in
the **2026-08-18 gate-key BLOCKER**: last deployed **2026-08-07T17:56Z** (re-verified today via
`list_edge_functions` — `updated_at` unchanged), deployed body carries a 27-char literal, repo body reads
`ALLDAY_PACK_OPENS_GATE_KEY`. **Deploying the repo copy would 403 both jobid 20 and 55.** The named remedy
is unchanged: complete the rotation as ONE window (secrets + deploy + repoint `?key=`).

## Severity

`medium`. No data loss and no user-facing surface is wrong — AllDay pack-open *history* simply stops
filling in. The watchlist row is already correct and should stay active.
