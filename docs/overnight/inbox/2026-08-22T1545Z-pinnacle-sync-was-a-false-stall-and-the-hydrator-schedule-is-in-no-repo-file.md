# `pinnacle-sync` was a FALSE stall — the arm watched a self-report while the outcome had no arm at all. Plus: the hydrator's schedule is declared nowhere in the repo

**Filed 2026-08-22 ~08:45 PT (15:45Z), Claude Code interactive, continuing sentinel triage. MEASURED.
§1 is SHIPPED (DB state, see the ledger). §2 is NOT shipped and needs Cloudflare access I do not have.**

---

## 1. ✅ SHIPPED — `pinnacle-sync` re-pointed to `pinnacle-fmv-recalc`

### The alert was wrong, and the controls say so plainly

The board read `pinnacle-sync silent 3194m (>1560m)`. Taken at the same instant:

- `pinnacle_catalog`: **2,482 of 2,564 renders priced**, newest `fmv_computed_at`
  **2026-08-22T10:07:12.9Z — 5.5 h old.**
- `pinnacle-fmv-recalc`: ran **that morning**, `ok`, **2,248 rows** — and has run on **25 of the last
  25 days**, never missing one.

**Pinnacle FMV was entirely healthy.** The stall was in the instrument.

### Why it misreads — and the route says it itself

`/api/cron/pinnacle-sync` does exactly one thing:
`supabaseAdmin.rpc("pinnacle_fmv_recalc_render_all")`. Its own comment: *"This route still owns only the
render-FMV recompute."* That function **logs its own row under a different pipeline name**
(`pinnacle-fmv-recalc`). The route's completion row comes from `logRun()`, whose `catch` block is
**empty on purpose** — *"best-effort observability — never let logging fail the run"*.

🚨 **So the watched row is a best-effort log line, and the work is not at risk when it goes missing:**
once the RPC is dispatched, Postgres runs it to completion whether or not the Lambda survives. Measured
over the retained window: `pinnacle-sync` wrote a `phase:"complete"` row on **2 of 10 days**, while the
work happened on **25 of 25**.

⚠ **This is CLAUDE.md's own rule landing on a live arm: measure the OUTCOME, not the self-report.** The
outcome pipeline had **no watchlist arm at all** (checked: 16 pinnacle arms, none of them this one),
while the unreliable self-report had one.

### ⚠ The route's documented 2-state table is incomplete — a third state it does not model

The route's comment promises:

> `marker only, no phase:"complete" row` → after() was dropped
> `no marker at all` → route never reached (cron down / auth)

There is a **third** state: **`after()` ran to completion and `logRun`'s RPC was swallowed by its own
empty catch** — entirely plausible at 10:07Z, inside the measured 01:00–19:00Z disk-IO band. The DB
cannot distinguish (2) from (3), so *"after() was dropped"* **must not be asserted as fact from a
missing row alone**. I nearly did exactly that before taking the control.

### What shipped, and what it costs

- **Added** `pinnacle-fmv-recalc` @ **1560 min**, medium. Sized from 25 days of `pipeline_runs_daily`
  (retained indefinitely): runs every day, 1–2×, **longest observed gap exactly 24 h**. 1560 = 26 h,
  2 h margin, fires on the first genuinely missed day — the same convention the old row used.
- **Deactivated** `pinnacle-sync` (`is_active = false`), notes rewritten with the full reasoning.

⚠ **What is no longer watched, stated rather than glossed:** *"the 10:07Z cron-job.org caller
specifically stopped."* If it dies, the **22:37Z pg_cron backstop** still recomputes FMV daily, so that
failure is invisible to users by design — but the new arm would stay green at 1 run/day and **would not
tell you**. A `pinnacle-sync-heartbeat` arm would cover the invocation half; **deliberately not added,
because no `-heartbeat` arm exists anywhere in that table** and inventing a convention was out of scope.

**Controls after the change:** `pinnacle-sync` gone from `detect_stalled_pipelines()`; new arm active and
reading **334 min against its 1560 threshold** (so it is live and *can* fire, not green by
construction); active-arm count **unchanged at 83**; and the other four arms **still fire** — nothing
real was silenced.

---

## 2. ⚠ NOT SHIPPED — `topshot-moments-hydrator`: the schedule exists nowhere in the repo

Still stalled at filing: last run **2026-08-22 07:22Z**, ~**499 min** against a 30 min threshold. Not a
data problem — it is **healthy when it runs** (8–49 runs/day, all `ok`, 6,986–13,956 rows/day).

**It is a Cloudflare Worker** (`workers/topshot-moments-hydrator/`), not Vercel or pg_cron — confirmed by
enumerating all four caller sources: absent from `vercel.json`, from `cron.job` (zero matches), from GHA,
and it has no `app/api` route.

🚨 **Its `wrangler.toml` contains no `[triggers]` / `crons` block.** So the schedule that demonstrably
drives it is **declared in no file in this repo** — presumably set in the Cloudflare dashboard.

**Evidence it really is a ~10-minute cron:** every observed `started_at` minute is **≡ 2 (mod 10)** —
00:32, 00:42, 03:52, 05:02, 07:22, and the daily last-runs at 23:52 / 21:22. That is a `*/10` schedule,
i.e. ~144 ticks/day.

⚠ **But only 24–49 runs LOG per day, out of ~144 ticks — roughly a quarter.** Every logged run reports
`rows_found: 300` (a full budget), so it is not "no work to do". **What the other ~100 ticks do is
unmeasured**, and I could not determine it from here.

**The control that makes the config point worth raising:** of 17 workers, **exactly one
(`sales-counterparty-backfill`) declares `crons = ["*/5 * * * *"]` in-repo.** Most of the other 16 are
HTTP proxies that correctly have no cron — but this one and `pack-events-ingest` are scheduled ingest
workers. So the mechanism *is* used in this repo; this worker just doesn't use it.

⚠ **Latent hazard, and it is the reason to act rather than note:** `wrangler deploy` reconciles cron
triggers **from config**, so deploying this worker from the repo with no `[triggers]` block would
**remove a dashboard-set cron and silently kill the pipeline.** Same family as the 2026-08-21 "two
wrangler configs deployed to one worker" incident.

**Operator asks (I have no Cloudflare access):**
1. Check the Cloudflare dashboard for this worker's cron trigger; if one exists, **codify it in
   `wrangler.toml`** so a deploy cannot delete it.
2. Read the worker's Cloudflare logs for 08-22 after 07:22Z — that is the only place the current stall's
   cause is visible.
3. While there, answer the ~144-vs-~35 tick question; a worker failing 3 of 4 invocations without
   logging is its own finding.

## 3. Not touched, and why

`classify-acquisitions-multicollection` (215 vs 180) and `allday-pack-opens-backfill` (145 vs 90) are
**marginal band overruns that drifted upward during this session** (192→215 and 122→145 within the
hour). Widening a threshold to hide the disk-IO band is the move CLAUDE.md forbids, so both were left
firing. `candy-editions-ingest` is covered by the 16:00Z filing.
