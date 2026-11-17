> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# A post-ship baseline taken *after* the apply is still not a clean A/B — the warm-up buckets are

**Filed:** 2026-09-01 06:35Z (2026-08-31 23:35 PT), cloud pass, no desktop bridge.
**Read at:** origin/main `8d99f051` (2026-09-01 05:54:15Z).
**Instrument:** `public.ops_pgss_delta` / `public.audit_20260830_pgss_snap`, per-snapshot buckets,
diffed on `(userid, dbid, toplevel, queryid)`.

⚠ **Scope:** this session cannot push (no `mcp__remote-devices__*` tools, cloud git proxy 403). That is
a fact about the session. **Commit this file normally.**

## The finding

The 2026-08-31 top-consumer-drain entry books its post-ship numbers against *"a clean 05:21:48Z
baseline taken after every change, so no window straddles a deploy."* That precaution is correct and
it is **not sufficient**.

`refresh_wmc_fmv_drift_active`, applied 04:04:45Z, per snapshot bucket, **total buffers touched per
call** (`shared_blks_read + shared_blks_hit`):

| bucket | calls | total buffers/call | disk reads/call | ms/call |
|---|---|---|---|---|
| … 14 h of PRE buckets | 141 | 31,426 – 53,025 | 18,819 – 34,834 | 15,771 – 18,997 |
| **04:29:57Z** (first post-apply) | 5 | **194,683** | 22,190 | 15,133 |
| **05:02:15Z** | 6 | **143,862** | 11,850 | 8,788 |
| 05:21:48Z | 2 | 45,965 | 5,254 | 4,298 |
| 06:05:00Z | 7 | 67,274 | 7,051 | 4,937 |
| 06:23:53Z | 4 | 53,543 | 4,653 | 4,189 |

The first two post-apply buckets are the **cold-cache warm-up**: the new plan's working set is not in
shared buffers yet, so buffer traffic per call is 3–4× the settled figure while the disk-read and
wall-clock numbers are already improving. Aggregate them with the settled buckets under one PRE/POST
split and you get:

> total buffers/call 45,626 → **104,479 — a 2.29× regression**

**which is false.** I computed exactly that number before splitting per bucket, and it would have gone
into the ledger as a regression on a change that is in fact a clean win. Settled (13 calls, 05:21Z
onward): **~5.3× fewer disk reads, ~3.6× faster, total buffers roughly flat.**

## The rule

**A post-ship A/B must drop the warm-up buckets, not merely start after the apply.** Two independent
signals identify them without guessing: total buffers per call is far above *both* the pre- and the
later post- range, while disk reads per call have already fallen. When only two or three post buckets
exist, say so and re-read later rather than pooling.

## The second half — the metric label

The same entry's table column reads `blocks`; its arithmetic line correctly says **disk reads**. The
two are not interchangeable, and the standing rule (*"A/B on TOTAL BUFFERS TOUCHED — a plan change
cannot be faked by a warm cache"*) names the other one. Where it matters:

- `get_allday_unresolved_pulls`: 63×/93× on disk reads, **15.0×** on total buffers (128,717 → 8,588).
  Real by either measure. ✅
- `analytics_smoke_run`: **1.84× on disk reads, 1.04× on total buffers** (802,000 → 769,000 per call).
  The one clock-gated leg was ranked at *"41% of the suite's cost"* on disk reads; on total buffers it
  is **3.6%**. The suite is still **~769,000 buffers and ~24 s per call at ~50 calls/day ≈ 38M
  buffers/day** — the instance's **#2 non-tooling consumer**, behind only `refresh_wmc_fmv_changed`.

⭐ **So the next lever on `analytics_smoke_run` is the other 61 FROM clauses, ranked on total buffers.**
Ranking them on disk reads is what made a 3.6% leg look like 41%.

⛔ **Not attempted this pass**, and the reason is worth recording: the function was anchor-spliced 70
minutes earlier by the concurrent session using `pg_get_functiondef()`. A second splice of a 21 KB body
from a session that cannot push would leave the repo file describing neither version.

## Falsifier

If the 08:13Z full-sweep tick and three further bounded ticks put `analytics_smoke_run` under ~400,000
total buffers per call, this filing's "4% of the function" is wrong and the leg was larger than the
two post-fix ticks show. Re-read `ops_pgss_delta` on queryid `8379160562588901637`.
