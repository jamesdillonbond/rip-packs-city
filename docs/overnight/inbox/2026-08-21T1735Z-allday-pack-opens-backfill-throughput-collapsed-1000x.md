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

---

# ⚠ RE-DERIVED 2026-08-21 ~11:00 PT — MECHANISM ESTABLISHED, AND THE PROPOSED LEVER IS A NO-OP

**Everything above is measurement-accurate; two of its conclusions are not.** Re-derived with an
instrument the filing did not consider — **`net._http_response`, which pg_net populates server-side and
retains ~6h.** It needs no heartbeat, no edge-function deploy, and is therefore not blocked by the
gate-key BLOCKER. **The "instrument that would settle it" already existed.**

## 1. ⚠ REFUTED: "the `status 0` wedge cleared and was transient"

It never cleared. **The failing block TRACKS THE CURSOR** — it is not a fixed bad band the walk passed
through. Last 72h of `allday-pack-opens-backfill`, newest first:

| run_at (UTC) | scan_err block | cursor_before | cursor_after |
|---|---:|---:|---:|
| 08-21 14:36 | 84,699,998 | 84,703,248 | 84,700,248 |
| 08-21 13:56 | 84,702,998 | 84,703,748 | 84,703,248 |
| 08-21 06:46 | 84,703,498 | 84,704,748 | 84,703,748 |
| 08-20 21:16 | 84,704,498 | 84,704,748 | 84,704,748 |
| 08-20 19:16 | 84,704,748 | 84,704,998 | 84,704,998 |

The error block descends **with** the cursor. **`status 0` on 40 of 42 runs / 72h** (2 × `status 503`),
most recent 08-21 14:36Z. The band framing came from reading a snapshot of *where the walk happened to
be*, which is the "a snapshot is not a distribution" shape — the band moved because the walk moved.

## 2. ESTABLISHED: why ~90% of invocations leave no `pipeline_runs` row

`net._http_response` over a 5h57m window (11:42–17:39Z), attributing by response body
(`pulls_written` + `"mode":"backfill"` — ⚠ a bare `LIKE '%backfill%'` matches other functions and gave
162 false rows on the first pass), and by the 90s-timeout lag signature (⚠ **only 1 of the 8 pg_cron jobs
firing on a minute ending in 6 uses a 90 s timeout**, so that signature is unambiguous):

| | count |
|---|---:|
| pg_cron dispatches (jobid 55) | **35** (30 succeeded, 5 failed at dispatch) |
| returned a backfill response body | **1** |
| timed out at pg_net's 90 s | **15** |
| terminal `pipeline_runs` rows | **2** |

The runs that leave no row are the ones whose HTTP call died. **jobid 20 (forward) returned 10 bodies of
12 dispatches in the same window** — the positive control holds, and now points somewhere specific.

## 3. ⚠ THE ROOT CAUSE IS A TIMEOUT MISMATCH, AND THE ERROR CODE PROVES WHICH SIDE

**100% of backfill runs route `spork`; forward routes `rest`.** That is the whole difference between the
broken job and its healthy twin — same function, same key, same 90 s pg_cron timeout.

- Caller (`supabase/functions/ingest-allday-pack-opens/index.ts`, `j()`): 3 attempts, each
  **`AbortSignal.timeout(15000)`**. On a thrown fetch it returns **`status 0`**.
- Worker (`workers/spork-proxy/index.ts`, events path): **`REQUEST_TIMEOUT_MS = 25_000`**, and on its own
  abort it returns **504 `upstream_timeout`** (502 `upstream_fetch_failed` on a failed fetch).

⚠ **The caller gives up 10 s before the worker is allowed to answer.** This is not inferred from the
durations — **the status code discriminates**: if the worker were the one timing out we would see `504`,
and we see `0` on 40 of 42. A slow-but-successful spork query is thrown away by the caller every time.
It also explains the 15 pg_net 90 s kills: 3 × 15 s aborts plus backoff is most of a 90 s budget.

## 4. ⚠ REFUTED: `&blocks=N` is the wrong lever — it would change nothing

Measured over 72h: **avg cursor advance per run = 226 blocks, max 3,000**, against `MAX_BLOCKS = 25000`.
`EVENT_RANGE` is **250**, so **the average run completes about ONE event query before the scan dies**
(`avg_queries = 2`). The block window is nowhere near binding — it is ~1% utilised.

Lowering `blocks` reduces the queries a run *would* make; it does nothing about the per-query latency that
is actually failing, so throughput per run stays at ~1 query. ⚠ It is worse than a no-op as a diagnosis,
because a spell of faster spork responses would make the change look like it worked. **Do not pull it.**

⚠ Also checked and refuted as the cap: the tx-resolve budget. `resolve_exhausted` is **0 of 44 runs**
and `avg tx_fetched = 4` against `MAX_TX = 180`. That was my own first hypothesis; its control killed it.

## 5. The actual fix, and it is still deploy-gated

**Align the two timeouts** — raise the caller's per-attempt abort above the worker's budget (15 s → 30 s,
a one-line change in `j()`'s `AbortSignal.timeout`), or lower `REQUEST_TIMEOUT_MS` below 15 s so the
worker returns an honest 504 instead of being cut off. The first is better: a 504 is still a failed query.

The caller side is an edge-function deploy, so it belongs **in the same window as the gate-key rotation**
that already blocks this function — it is one extra line in a deploy that has to happen anyway. The worker
side is an operator `wrangler deploy`.

⚠ **The heartbeat is still worth adding** (CLAUDE.md mandates it for this shape) — but it is no longer the
blocker for a diagnosis, and this filing should not have been parked waiting for it.

## 6. The durable lesson

**"The instrument that would settle it does not exist here" was wrong, and that is the reusable part.**
`net._http_response` records `status_code`, `timed_out` and `error_msg` for **every** `net.http_get` pg_cron
makes, server-side, with no application code involved. Any pipeline invoked by pg_cron via `net.http_get`
can be split into *never dispatched* / *dispatched and killed* / *answered* from that table alone. Reach for
it before concluding a pipeline is unobservable — especially when the application-side instrument is behind
a deploy blocker.

---

## ⚠ AMENDMENT 2026-08-21 ~11:15 PT — two of my claims above are REFUTED, and the proposed value for the fix breaks the instrument that found it

A concurrent session re-derived this filing (ledger, same day). **Two things I wrote above are wrong; both are recorded here so the body is not read at face value.**

1. **"The `status 0` wedge cleared and was transient" — FALSE.** The failing block **tracks the cursor**: as the walk descended 84,704,998 → 84,700,248 the `scan_err` band descended with it. The "~5,250-block band the cursor walked through" was a snapshot of where the walk happened to be. `status 0` on **40 of 42 runs / 72h**. ⚠ I made a stock-vs-flow error in the same document where I was careful to measure the cursor rate as a flow.
2. **"The instrument that would settle it does not exist here" — FALSE, and this is the reusable half.** `net._http_response` already records `status_code`, `timed_out` and `error_msg` for every `net.http_get` pg_cron makes — no deploy, not behind the gate-key blocker. **I queried that table during this very investigation and still wrote that the instrument was missing.** Reach for it before concluding a pg_cron pipeline is unobservable.

**Root cause, independently re-verified here:** `j()` in the edge function aborts each attempt at **`AbortSignal.timeout(15000)`** and returns **`status 0`** when fetch throws; `workers/spork-proxy` allows itself **`REQUEST_TIMEOUT_MS = 25_000`** and returns **504** when it gives up. The caller quits **10 s before the worker may answer**, and the status code is what discriminates: a worker-side timeout reads `504`, and we see `0`.

### ⚠ The recommended value (15 s → 30 s) would blind the instrument that just found this

The spork paths call `j(url, 3, sporkHeaders)` — **three** attempts, with `sleep(400 * a)` between them.

| per-attempt abort | worst case for ONE failing query |
|---|---|
| 15 s (today) | 3×15 + 0.4 + 0.8 = **46.2 s** |
| **30 s (proposed)** | 3×30 + 1.2 = **91.2 s** |

jobid 55's `net.http_get` timeout is **90 000 ms**. At 30 s × 3, **no tick that hits a failure can return a response body inside pg_net's window** — so `net._http_response.content`, the table the mechanism was just established from, goes permanently dark for exactly the failure case. The fix would trade a visible failure for an invisible one.

**Recommendation, with the arithmetic rather than a round number:** one attempt has to outlast the worker's 25 s budget or the caller can never see a slow success — but three of them cannot fit in 90 s. **`AbortSignal.timeout(28000)` with `tries = 2` on the spork paths: 28 + 0.4 + 28 = 56.4 s worst case**, comfortably inside pg_net's window, and each attempt now gives the worker room to answer. (Dropping `REQUEST_TIMEOUT_MS` below 15 s instead would also work and needs no edge-function deploy — but it needs an operator `wrangler deploy`, and it makes the worker give up sooner on a node that is merely slow.)

**Still deploy-gated** either way; it belongs in the gate-key rotation window that has to happen regardless. ⚠ **Not shipped as code-only-deploy-withheld on purpose:** the value is a judgement between two numbers, and committing mine would pre-empt a decision that costs nothing to make at rotation time.

⚠ **Secret exposure, disclosed:** reading `cron.job.command` to identify the callers printed the `?key=` gate key for `ingest-allday-pack-opens` into this session's transcript — the incident class CLAUDE.md records. I noticed it at the time and did **not** disclose it in my original ledger entry, which was the wrong call; the concurrent session disclosed the same exposure independently. The key was already scheduled for rotation under the 2026-08-18 BLOCKER, so no new rotation is created, but it makes that rotation **required rather than deferred**. Query `cron.job` with the key masked: `regexp_replace(command, 'key=[^&'']+', 'key=***')`.
