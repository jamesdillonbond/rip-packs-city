# Daytime monitor candidates — 2026-09-14T18:16Z (11:16 AM PT)

Source: `rpc-daytime-monitor` midday tick. READ-ONLY sweep. Bash/sandbox shell is down (Sept-8 Windows-update mount failure, 7th day), so this file is **written to the mount, push unavailable** — night pass picks it up locally.

Context flag: the box was at **io_wait 14–17 / active 12–18** across three controls this run, **no wallet-backfill wave** (0 runs/30 min), timeout-fails **15/6h** (below the ~41/6h #42 baseline). Not an acute spell, but **not a quiet window either** — so per §1c the two items below are filed as **SYMPTOMS to re-measure in a genuinely quiet window**, not as causal conclusions.

---

## 1. SYMPTOM — `rpc_ops_snapshot()` still CANCELS (>50 s budget) under only mild elevated IO, despite the precompute fix — bears on #121 step 3

- **Observed:** `SELECT rpc_ops_snapshot()` was **cancelled by statement timeout** three times this run, at io_wait 14–17 / active 12–18. Today's steer recorded the precompute (jobid 506) taking it from *cancelled-at-50 s → 9.13 s* **quiet-to-quiet**, and predicted *~15–20 s cold*. It did not land in 15–20 s here; it exceeded the budget entirely.
- **Read:** consistent with the steer's own open exit — the `DISTINCT ON` trust-health leg was **moved off the read path, not reduced**, and `v_rpc_trust_health` itself **also timed out** this run (I could not confirm the trust legs, so trust health is UNMEASURED this tick, not "7/7"). So the snapshot's residual cost is the trust-health scan, and under even modest concurrent IO it re-crosses the ceiling.
- **Risk:** low/none to prod. The risk is to the monitors: a pass that reads a snapshot timeout as a spell tell will mis-diagnose (the very failure mode today's doctrine steer was written to prevent).
- **Suggested action (quiet-window RE-MEASURE, not a conclusion):** #121 step 3 exactly — re-measure the snapshot COLD and truly quiet (io_wait ≤ 2), and decide whether the trust-health `DISTINCT ON` over the 965 MB partition needs its own precompute the way FMV just got one. Do **not** conclude the precompute "didn't help" from this reading — the FMV leg now reads a precompute table and is cheap; the residual is elsewhere.

## 2. SYMPTOM — Top Shot sniper `ts_listings` feed ~19 min stale while `rpc-ts-listings-atlas-sync` times out (#42 consequence not explicitly tracked)

- **Observed:** `max(ts_listings.ingested_at)` = 17:57Z, 0 rows in the last 15 min, at 18:16Z ⇒ **~19 min stale**. The 2-min rebuild `rpc-ts-listings-atlas-sync` is **failing 47/506 in-window** (last 18:06Z), all `canceling statement due to statement timeout` on its `CREATE TEMP TABLE _tsl_want … DISTINCT ON (nft_id)` — the documented #42 flip to statement-timeout.
- **Read:** the job still succeeds ~90.7% of ticks (459/506), so 19 min is most likely a **failure cluster during this elevated-IO window**, i.e. #42 spell-collateral — NOT a dead lane. But the **user-facing consequence** (the serial-grain sniper shows asks up to ~N min stale when the rebuild clusters-fail) is not something the current alerts surface — `atlas-market-upstream-403` watches the firehose freshness (fresh: drain 18:09Z), not `ts_listings` rebuild freshness.
- **Risk:** low-medium, user-facing (sniper ask staleness), intermittent.
- **Suggested action (quiet-window RE-MEASURE):** confirm whether `ts_listings` staleness is bounded (does it recover to <5 min within one quiet tick?). If it clusters past ~15–20 min repeatedly, that argues for the same temp-table cost work #42 already flags for `rpc-ts-listings-atlas-sync` (the DISTINCT-ON build is the timeout site), and possibly a freshness arm on `ts_listings.ingested_at`. Do not re-file #42 itself — this is the consequence, filed so the sniper impact is visible.

---

*Not new / already owned (logged so the night pass doesn't re-derive): `topshot-active-listings-ingest` cron_silent 1017 min = residential box dark ~17 h (expected, medium/no-page, self-documenting); `rpc-allday-unmapped-atlas-resolver` timeouts = #42; `snapshot-institutional-wallets` 3/6 high = #42/#73/#84 denom-6 (focus: do not re-file); `pack_distributions` stale = #94; both Atlas-403 rows info + fresh.*
