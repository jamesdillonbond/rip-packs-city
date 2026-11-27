# pg_net_http_401 — 2× HTTP 401 on flowscan `/flow/v1/transaction/:token`, not attributable to the three Atlas lanes

**Filed:** 2026-11-27T22:13Z (rpc-daytime-monitor, read-only daytime sweep; quiet window — positive control `io_wait=1 / active=1`, NOT a saturation spell, so this is a real read, not a spell symptom)

**Priority:** LOW (nil blast radius)

**Source:** `SELECT rpc_ops_snapshot()` → `pipeline_alerts` row `pg_net_http_401` (the arm's static severity is `critical`). Endpoint per `public.pg_net_request_log` (#241): `GET api.mainnet.flowscan.flow.com/flow/v1/transaction/:token`. 2 pg_net-dispatched calls returned HTTP 401 in the trailing 2h window; body empty. The arm states it is NOT attributable (by request_id join) to the Atlas editions walk, the Atlas market feed, or the pack-pull chain hydrator.

**What it is / is not:**
- NOT a data-freshness problem. Every Flow-sourced trust/freshness metric is `ok` and fresh in the same snapshot: `topshot_fmv_stale_hours` 0.3, `candy_sales_stale_hours` 0.9, `fmv_stale_touch_hours` 0.3, `stalled_pipelines` `[]`, `pg_cron` failures `[]`. So whatever is 401ing is losing nothing downstream.
- Distinct from today's already-fixed `dapper-pack-pulls-upstream-400` (the `collect_wallet_pack_pulls` / `kind='editions'` >100-ids bug fixed 12:10 PM PT by `20261127201001`; its last 400 dispatched 20:09Z and zero since — that HIGH is decaying, not this).
- Flowscan is a public explorer API, so a 401 there reads as an auth/route condition, not an outage of our pipeline.

**Two readings (per the arm's own text) — attribute, do not conclude:**
1. **Edge-fn misconfiguration** (stale `?key=` gate, rotated secret, bad route). `pg_cron` would still log `succeeded` because dispatch worked and the fn writes no `pipeline_runs` row, so a silence-based check misreads it as a completed no-op. Check whether any `supabase/functions/*` or dispatcher calls `flowscan.flow.com/flow/v1/transaction`, and if so verify its gate key against the current secret.
2. **Self-inflicted probe** — a session/probe that hit that endpoint without recording its request_id in a lane's request table. Per the arm, recording the probe (`error '__probe__ <what>'`, `offset_at -1`, `drained_at now()`) clears the row.

**Suggested action (night pass / CC):** locate the caller of `flowscan.flow.com/flow/v1/transaction`, decide which of the two readings holds, and either fix the gate/route (reading 1) or record the probe id (reading 2). Read-only sensing only from here.

**Risk read:** trivial. 2 calls, empty body, nil downstream impact. Worth attributing only so the `critical`-labelled arm stops reading red on an unattributed 401.
