# allday-pack-opens-backfill `cron_silent` watchlist arm is now a false positive — the finite walk finished and the arm can no longer tell "done" from "scheduler stopped"

- **When:** 2026-08-24 ~15:07Z (daytime monitor, first-tick-of-day sweep). PT-authored.
- **Source:** `rpc_ops_snapshot()` → `stalled_pipelines` + `pipeline_alerts` flag `allday-pack-opens-backfill` as `cron_silent` (last `pipeline_runs` row 2026-08-23T21:26Z, ~17.7h silent vs its 90-min threshold). Positive control: **NOT a spell** (`pg_stat_activity` io_wait=0, active=0/41 at sweep time).
- **Risk:** LOW / hygiene. No user-facing surface, no data at risk. The concern is *instrument degradation*, not an outage.

## What's actually happening
The pg_cron job (`rpc-allday-pack-opens-backfill`, jobid 55, `6,16,26,36,46,56 * * * *`) **IS firing and succeeding** — verified directly in `cron.job_run_details`: `status=succeeded, "1 row"` at 15:06, 14:56, 14:46, 14:36, 14:26Z (and continuously). `j.active=true`.

So the walk is healthy; it has simply reached `done:true`. The watchlist note itself predicted the floor would be hit ~2026-08-14 (SPORK_FLOOR raised to the mainnet24 root; pre-2023-11-08 AllDay opens are a permanent, disclosed coverage limit). Once `done:true`, the finite walk **stops writing a `pipeline_runs` row**, while pg_cron keeps ticking every 10 min.

## Why this is a finding and not just noise
The arm's own note says to KEEP THE ROW ACTIVE even after `done:true`, on the reasoning that *"the pg_cron job keeps firing, so silence here still means the SCHEDULER stopped, which is a real signal. Retire only if job 55 is unscheduled."* That reasoning no longer holds: the scheduler is **firing and succeeding** yet the pipeline is **silent**, so the arm now conflates "done-and-healthy" with "scheduler-stopped" — exactly the CLAUDE.md class *"a permanently-silent instrument is indistinguishable from a broken one at a glance."* It will re-raise on every sweep from here forward, training the reader to ignore it (and masking a genuine scheduler stop if one ever occurs).

## Suggested action (night pass / Trevor — do NOT act from this read)
Confirm the walk logged `done:true` (its last real `pipeline_runs` payload before it went silent), then make the arm done-aware rather than presence-of-run-aware: e.g. suppress `cron_silent` for this pipeline while `cron.job` jobid 55 `active=true` AND its last run `status=succeeded`, OR re-point the arm to watch `cron.job_run_details` for jobid 55 (scheduler liveness) instead of `pipeline_runs` (work liveness). Either restores the "scheduler stopped is a real signal" property the note wants without the standing false positive. This is a watchlist/telemetry tweak (a migration), shippable without a git push.

## Not re-filed (already tracked, confirmed still-open this sweep)
- Cross-collection `rpc-ccm-step2` stale (`cross_collection_ts_set_overlap_mat` last refreshed 2026-08-22 20:43Z; step2 failed again 2026-08-23 23:25Z on statement timeout while step1 succeeds) → **already ESCALATED** in `inbox/2026-08-21T2340Z-ESCALATION-the-cross-collection-mats-have-failed-every-day-since-08-18.md`.
- `public_board_empty_count` / `public_board_slow_count` both read 999 (sentinel) → board-watchdog batch-loss fragility, `inbox/2026-08-24T0225Z-the-board-watchdog-loses-every-probe-it-completed-when-any-one-times-out.md` (nightly de-escalated to hygiene).
- `fmv_sweep_wedge_hours` 5.98 BREACH → fmv-recalc saturation class (R46 / disk-IO budget), owned.
- `unmapped_resolution_backlog_max` 350 BREACH → owned honest-finding; the arm's own catches text says DO NOT raise `breach_at`.
- pg_cron statement/startup-timeout cluster (rpc-atlas-pack-ev, refresh-new-collectors, ccm-step2, thin-sale-ask-disclosure, refresh-challenge-costs, etc.) → saturation collateral, one root (SMALL-instance disk-IO budget), focus.md item 3: do not open new investigations.

---

## ⛔ REFUTED — 2026-08-24 ~15:45Z (08:45 PT), Claude Code on Trevor's Windows box. **The walk is NOT done, and suppressing the arm would silence a TRUE signal.**

⚠ **Acting on the suggested remedy would have been the harmful move.** This filing said to *"suppress `cron_silent` for this pipeline while jobid 55 `active=true` AND its last run `status=succeeded`."* **Both of those conditions hold right now, and the pipeline is still genuinely broken** — so that suppression would have hidden a real fault behind a green board. ✅ **The filing's own instruction — *"do NOT act from this read"* — is what made this catchable. It was right to say so.**

### The `done:true` state this filing rests on HAS NEVER BEEN RECORDED

`pipeline_runs` for `allday-pack-opens-backfill`, whole retention window:

| measure | value |
|---|---:|
| rows | **25** |
| rows carrying a **`done`** key in `extra` | **0** |
| `ok = true` | 7 |
| `ok = false` | **18** |
| oldest → newest | 2026-08-21 13:56Z → **2026-08-23 21:26Z** |

**There is no `done` field in this pipeline's `extra` at all** — the keys it actually writes are `partial`, `progress_blocks`, `scanned_floor`, `resolve_exhausted`, `skipped_permanent`, `spork_available`. ➡ **The premise "once `done:true`, the finite walk stops writing a row" describes a state this pipeline has never emitted.**

### And the walk is ~19.4 MILLION blocks from its floor

| | block |
|---|---:|
| `scanned_floor`, oldest row | 84,703,248 |
| `scanned_floor`, newest row | **84,662,756** |
| target `floor` | **65,264,619** |
| **remaining** | **19,398,137** |

Progress across the ~2.3-day window: **40,492 blocks**, i.e. ~17.5k/day. **At that rate the floor is ~1,100 days away.** ⚠ **This is a dated sample on a small window — the RATE is soft. The SIGN is not: the walk is descending and nowhere near finished.**

### The last two runs are FAILURES, not completions

Both `ok:false`, both `transient:true`, on upstream scan errors — `events 84662506-84662755 status 503` and the same range `status 0`. **A finished walk does not end on a 503.**

### What IS true, and what I did NOT establish

✅ **The scheduler is firing** — jobid 55 over 20 h: **117 `succeeded` / 3 `failed`** dispatches against a 6/hour schedule. **That part of the filing is correct.**
🚨 **And `pipeline_runs` has been silent for ~18.3 h through ~110 of those dispatches** (last row 08-23 21:26Z; measured 08-24 15:41Z). ➡ **So the arm is reporting something REAL: the callee is not writing a run row.**

⛔ **NOT ESTABLISHED — why.** `succeeded` in `cron.job_run_details` means the `net.http_get` was **dispatched** and says nothing about the callee (the documented split). I could not attribute responses to this job: **`net._http_response` carries no URL**, and `net.http_request_queue` drains, so the URL is gone by the time a response lands. The plausible shape — the function now returns before reaching `log_pipeline_run`, the same structural blindness `topshot-active-listings-ingest` has — **is a hypothesis I did not test. Do not repeat it as fact.**

### ➡ The corrected action

**Do NOT make the arm done-aware.** The remaining honest options are (a) find why the callee stops short of `log_pipeline_run` — needs the edge function's logs, not `pipeline_runs`, which is blind here by construction — or (b) re-point the arm at `cron.job_run_details` for **scheduler** liveness *and keep a separate arm on work liveness*, since those are two different questions and this filing's own reasoning shows why collapsing them loses information.

ⓘ **The generalisable bit:** *"the instrument is a false positive"* is the most expensive conclusion a monitor can reach, because the remedy is **suppression** — and a wrong suppression is silent by construction. **It deserves the same re-derivation as a positive finding, and this one did not survive it.**

---

## ✅ MECHANISM FOUND — 2026-08-24 ~15:50Z. The open question above ("why does the callee stop short of `log_pipeline_run`?") is answered, and the repo already has the rule it breaks.

⚠ **I said `pipeline_runs` was blind here by construction and the cause needed the function's own logs. It did — and they have it.** `function_logs` and `function_edge_logs` are queryable through the Supabase MCP's unified log stream; `net._http_response`'s missing URL was a dead end, not the only instrument.

### The measurement

`function_logs`, `function_id = 95b832c1-…` (`ingest-allday-pack-opens`):

| event | reason | count |
|---|---|---:|
| Boot | — | **186** |
| Shutdown | **`EarlyDrop`** | **185** |
| Shutdown | `TerminationRequested` | 2 |

🚨 **185 of 186 boots end in `EarlyDrop` — the isolate is dropped before it finishes.** That is why no `pipeline_runs` row is written: **the function does not survive long enough to reach its logging call.**

`function_edge_logs` for the same path, ~24 h:

| status | n | avg ms | max ms |
|---|---:|---:|---:|
| 200 | 51 | **12,751** | **124,361** |
| 502 | 2 | 80,784 | 86,601 |
| 504 | 1 | 150,189 | 150,189 |

**The caller's patience is `timeout_milliseconds = 90000` (90 s)**, read from `cron.job` jobid 55 — and the function's max execution is **124 s**, comfortably past it. `net._http_response` corroborates: **76 rows with `timed_out = true`** in a single 3-hour window.

⚠ **Note the shape of the population: ~54 function invocations against ~140 scheduled dispatches.** Most dispatches never produce a logged invocation at all.

### ⛔ What is established, and what is still inference

✅ **Established:** essentially every invocation ends in `EarlyDrop`; the function routinely runs longer than the 90 s caller timeout; pg_net records timeouts; no run row is written.
⚠ **NOT established:** the precise trigger for *each* `EarlyDrop`. **51 invocations returned HTTP 200 with a 12.7 s average — those did not time out**, yet the boots still end in `EarlyDrop`, which suggests work continuing *after* the response is sent and being dropped with the isolate. **That is a hypothesis. Do not record it as the mechanism without testing it.**

### 🚨 THE REPO ALREADY HAS THE RULE THIS BREAKS

CLAUDE.md, on fire-and-forget work: *"Any `after()` route needs an **invocation heartbeat written BEFORE the work** (separate `<pipeline>-heartbeat` name), because **`try/catch` CANNOT catch a `maxDuration` kill** — without it a killed tick is indistinguishable from a cron that never fired. Read kills by CORRELATION (heartbeat, no terminal row), never a `finally`."*

**That is exactly this failure, in an edge function instead of a Vercel route.** A heartbeat row written *before* the scan would make a killed tick visible as `heartbeat present, terminal row absent` — the correlation the rule prescribes — instead of the indistinguishable silence the `cron_silent` arm is currently reporting.

➡ **So the fix is NOT to teach the arm about `done:true`** (a state this pipeline has never emitted — see the refutation above). **It is to give the pipeline a heartbeat, per a rule this repo wrote for precisely this class**, and separately to decide whether a walk that needs >90 s per tick should be chunked to fit its caller's timeout.

---

## ⛔⛔ I RETRACT THE SECTION ABOVE — 2026-08-24 ~16:00Z, ~15 minutes after writing it. **`EarlyDrop` is the NORMAL shutdown reason for every edge function here and has ZERO discriminating power.**

**The claim I made and pushed:** *"185 of 186 boots end in `EarlyDrop` — the isolate is dropped before it finishes, and that is why no `pipeline_runs` row is written."* **That is wrong.**

### The control I should have run first

I found a striking positive and did not check whether it was universal. It is:

| function | boots | EarlyDrop | writes `pipeline_runs`? |
|---|---:|---:|---|
| `flowty-proxy` | 3,109 | **3,119** | serves the live app |
| `compute-topshot-pack-ev` | 242 | **240** | ✅ **415 rows in 24 h**, newest 15:49Z |
| `pinnacle-nft-resolver` | 297 | **296** | ✅ **289 rows in 24 h**, newest 15:48Z |
| `ingest-allday-pack-opens` | 186 | **185** | ✗ |

**Functions that `EarlyDrop` at ~99% write their run rows perfectly well.** ➡ **`EarlyDrop` is how the isolate is recycled after a request, not a fault.** It is the baseline for the entire project, so it cannot explain why one function differs.

⚠ **This is exactly the control CLAUDE.md demands and I skipped: *"a POSITIVE needs a no-change control."*** The signal was 99%, which felt conclusive — **and 99% is precisely what a baseline looks like.** A number that extreme should have prompted the control, not replaced it.

ⓘ **The runtime kill reasons that WOULD be meaningful are `WallClockTime`, `CPUTime` and `Memory`.** `ingest-allday-pack-opens` has **zero of all three** — so it is **not** being killed by the runtime. `compute-allday-pack-ev` does show **5 `WallClockTime`** kills, which is what a real kill looks like in this data.

### What still stands, and what is open again

✅ **STANDS — the `done:true` refutation** in the section above it. That rests on `pipeline_runs` content (25 rows, zero `done` keys, 18 failures, ~19.4M blocks from the floor) and is untouched by this retraction. **Do not suppress the arm.**
✅ **STANDS — the timing facts:** 51× 200 at avg 12.7 s / max 124.4 s against a **90 s** caller timeout; **76 `timed_out`** in a 3 h window; **~54 logged invocations against ~140 dispatches.**
⛔ **OPEN AGAIN — why no run row.** ⚠ And the sharper form of the question, which the control surfaced: **51 invocations returned HTTP 200 and still produced no `pipeline_runs` row.** A 200 is not a kill. **Something in the function returns success without logging** — an early exit, a lock, a nothing-to-do path, or a failing `log_pipeline_run`. **That is where the next session should look, and it is a code read, not a log query.**

⚠ **Corrected in the same place it was claimed**, and in known-issues #29. **The heartbeat recommendation is NOT withdrawn** — it remains the right instrument for distinguishing a killed tick from a cron that never fired — **but it is no longer supported by an EarlyDrop argument, and the actual cause here is still unknown.**

---

## ✅ RESOLVED — 2026-08-24 ~16:10Z. **The two modes share one function, and only BACKFILL is silent. That asymmetry is the whole answer.**

⚠ **I had been treating "the function" as one population. It serves TWO pipelines**, and separating them makes every earlier confusion evaporate:

| pipeline | rows / 24 h | all ok? | newest |
|---|---:|---|---|
| `allday-pack-opens-**forward**` | **46** | **46/46 ok** | **2026-08-24 15:39:08Z** — minutes ago |
| `allday-pack-opens-**backfill**` | 5 | 1/5 | 2026-08-23 21:26Z |

**Same edge function. Same `logRun`. Same table. Forward writes; backfill does not.**

### What this KILLS — including my own second hypothesis

⛔ **`logRun` is not broken, and the unchecked-error shape is not the cause.** I had flagged that `logRun` does `await supabase.from("pipeline_runs").insert({…})` **without checking the returned `error`** — a genuine instance of this repo's documented top defect (supabase-js *returns* errors rather than throwing, so a failed insert is silently a success). ⚠ **But it cannot explain THIS**, because the identical call writes 46 forward rows a day. **A defect that is real and is not the cause of the thing you are investigating is still worth fixing — but it must not be reported as the cause.**
⛔ **`EarlyDrop` — already retracted above; it is the project-wide baseline.**
⛔ **`done:true` — the code DOES emit it (line 507, `if (cur <= floor)`), which is why my refutation was right for the right reason: `cur` = 84,662,756 against `floor` = 65,264,619, so that branch is ~19.4M blocks away. The state is real and unreachable, not absent.**

### The supported explanation

**Forward scans a small tip window and finishes fast, so it responds and logs.** **Backfill scans large historical ranges** — observed execution up to **124.4 s** against the caller's **`timeout_milliseconds = 90000`**, with **76 `timed_out = true`** in a single 3-hour window and only **~54 logged invocations against ~140 dispatches**. **A request the caller abandons at 90 s never reaches `logRun`**, and `pipeline_runs` is blind to it *by construction* — which is precisely why the `cron_silent` arm sees silence while `cron.job_run_details` sees success.

⚠ **CONFIDENCE, stated honestly:** the **asymmetry is measured** and the **timing is measured**. *"Every missing backfill row is a caller timeout"* is **well-supported but not proven** — I have not matched individual dispatches to individual invocations, and `net._http_response` cannot do it (no URL).

### ➡ What to do, unchanged in substance and now correctly supported

1. **The heartbeat** — CLAUDE.md's own rule for this class: *"an invocation heartbeat written BEFORE the work … read kills by CORRELATION (heartbeat, no terminal row)."* This makes an abandoned backfill tick **visible** instead of silent. **The recommendation never depended on the EarlyDrop argument; it depends on the timeout, which is measured.**
2. **Chunk the backfill so a tick fits inside 90 s** — or raise the caller's timeout deliberately. A walk that needs >90 s per tick against a 90 s caller cannot make progress *and* report it.
3. ✅ **Fix `logRun`'s unchecked insert error anyway** — separately, and labelled as hygiene rather than as this bug's cause.
4. ⛔ **Still do not suppress the `cron_silent` arm.** It has been correct throughout.
