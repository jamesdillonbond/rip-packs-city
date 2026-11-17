# pg_cron jobid 16 is 403ing 100% of its dispatches — real misconfiguration, LOW data impact, but it makes a brand-new CRITICAL arm permanently red

Claude Code, interactive, 2026-08-12 ~06:54 PT (1354Z). **Read-only diagnosis. NOT fixed — the remedy needs the deployed gate secret, which is operator-gated.**

## What fired

`check_edge_fn_http_failures()` — the arm shipped 2026-08-11 for exactly this class — returned **critical**: *"24 pg_net-dispatched edge-function call(s) returned HTTP 403 in the last 02:00:00 … Sample body: `{"error":"forbidden"}`"*.

Found while confirming deep-audit D15; `detect_stalled_pipelines()` was showing `allday-pack-opens-backfill` silent 112 min with **jobid 55 dispatching 12/12 successfully**, which is the documented D2 tell: **scheduler green + pipeline silent is an AUTH hypothesis before an upstream one.**

## Attribution — jobid 16, established without echoing any key

`net._http_response` retains ~1.6h and cannot be joined back to a URL (`net.http_request_queue` is pruned on completion), so the caller was identified by **timing correlation**:

- The 403s land at minutes **3, 8, 13, 18, 23, 28, 33, 38, 43, 48, 53, 58** — every 5 minutes, 2 per bucket.
- **jobid 16 `rpc-backfill-pack-pool`** has schedule `3,8,13,18,23,28,33,38,43,48,53,58 * * * *` and **24 dispatches in 2h — exactly the 24 × 403.** It is the only job present in all 12 buckets.
- jobid 15 (same function, `15 8 * * *`) contributed 0 dispatches in the window.

So jobid 16 is failing **100%** of its dispatches: **288/day**.

## ⚠ Impact is LOW — and I nearly filed this as a live outage before checking

Two corrections I had to make to my own reasoning, both worth recording:

1. **`backfill-topshot-pack-supply` never calls `logPipelineRun`.** So its total absence from `pipeline_runs_daily` (zero rows across the rollup's entire history since 07-29) is **by design, not evidence of an outage**. Do not read that silence as a 2-week failure — I initially did.
2. **`pack_drop_pool` is FRESH** — 152,968 rows, newest `last_refreshed_at` seconds old, 64,933 refreshed in 24h. The pack-EV surfaces are **not** starved. That freshness comes from a **different** writer: `pool_source='gql'` (2,618 rows in the last 2h, written by the `compute-*-pack-ev` functions).

The 403ing function's own contribution is `pool_source='gql_historical'`, which has written **63 rows in the last 10 days — all in one burst at 2026-08-12 03:33:08Z**, and nothing since. So its output was already near-inert before this, and the 403s appear to have begun after that 03:33Z write (unprovable directly: `net._http_response` only retains ~1.6h).

**Net: a genuinely broken job wasting 288 dispatches/day, on a lane whose data is covered by another writer.**

## 🔴 The second-order problem: a brand-new critical arm is now permanently red

`check_edge_fn_http_failures()` is wired into `get_pipeline_alerts()` — the live Telegram/email path — at **`critical`**. As long as jobid 16 stays misconfigured it will fire **every single evaluation, forever**, for something with no user-facing data impact.

This repo has repeatedly recorded what that does: the `ufc_fmv_stale_hours` arm went permanently red and "trains the operator to skim past every arm on the board", and the D2 outage itself was dismissed five times behind a stale annotation. **A critical arm that is always on is worse than no arm** — and this one was built *last night* specifically to catch the next D2.

So this needs closing quickly, one way or the other, on that ground alone — independently of the modest data impact.

## Options (operator's call — deliberately not taken)

1. **Complete the rotation for jobid 16** as part of the one-window fix CLAUDE.md already records as owed (set the 8 `*_GATE_KEY` secrets → deploy the env-var functions → repoint every pg_cron `?key=` together). ⚠ Any subset reproduces the 08-11 half-rotation outage.
2. ~~**Retire jobid 16** if `gql_historical` is superseded by the `gql` writer — 63 rows in 10 days is close to inert.~~ 🔴 **RETRACTED — I checked this an hour later and the premise is FALSE. Do not retire it.**
   - **545 of 4,639 dists (11.7%) are covered ONLY by `gql_historical`** — measured `count(*) FILTER (WHERE hist>0 AND gql=0 AND atlas=0)` = **545**, and the overlap with `gql`/`atlas` is **exactly 0**. It is the sole pool source for those dists, not a duplicate of the `gql` writer.
   - **`pool_source='gql_historical'` is SEMANTICALLY LOAD-BEARING**, not just provenance. `v_pack_remaining_basis` branches on it to emit `'original_supply_mislabelled'`, `false`, and *"weights are original mint share, not remaining"* — i.e. it is the flag that stops pack-EV presenting an ORIGINAL-mint-share pool as a REMAINING-supply pool. Retiring the writer that maintains that basis degrades a correctness disclosure.
   - ⚠ **My reasoning was the error, not just the answer: low write volume on a BACKFILL means "finished or blocked", never "redundant".** And because the function 403s, we cannot currently tell which — **you cannot safely retire a backfill whose remaining work you are unable to measure.** That is itself an argument for fixing first.

   👉 **Recommendation is therefore option 1 — complete the rotation. Not a judgement call any more.**
3. **Interim, if neither happens today:** consider whether `check_edge_fn_http_failures()` should degrade a *known, ticketed* 4xx source to `warn` so the arm keeps its signal for the NEXT incident. ⚠ Do this only with an explicit expiry — a permanent suppression here would recreate exactly the D2 dismissal-by-annotation failure this arm exists to prevent.

## Not verified

- Whether the 403 began exactly at 03:33Z (retention is ~1.6h; only bounded as "after the 03:33Z write").
- Which specific secret/key is mismatched. **Not probed on purpose:** reading the deployed source to compare would echo the live gate literal into the transcript — the documented `get_edge_function` hazard. The md5-fingerprint method is the sanctioned way if someone needs to confirm equality.
