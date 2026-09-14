# Daytime monitor — 2026-09-14T06:12Z (2026-09-13 ~11:12 PM PT)

> ⛔ **ITS LEAD IS CLOSED. Filed to the mount under NO-PUSH and committed after the fact, 2026-09-14 ~08:05 AM PT.** This sweep leads on `topshot_impossible_parallel_serials` climbing **5 → 29 → 35**, concludes a live producer, and asks the night pass to prioritise the #82 writer fix over re-measuring. **That is exactly what happened.** #82 was repaired the same morning — both inflow write points guarded FIRST, then **37 sales + 643 wmc rows** re-keyed to base — and the metric **reads 0** (precompute `computed_at` 2026-09-14 07:14 AM PT, re-read live at commit time). **Do not re-open #82 from this file.**
>
> ⚠ **Two things here are still live.** (1) The metric is **parallel-scoped** and blind to **1,727 base-edition** `sales` rows carrying a serial their own edition cannot contain — that is **#116, still open — though its diagnosis was settled hours later: three authorities agree the circulation is correct, so the `sales` SERIAL is the wrong value; the writer behind it is still untraced**. (2) The low-priority suggestion below — confirm `/insights/pack-reality` renders an honest empty state rather than a "0 / broken" conclusion — **was actioned within the hour and became #118.** The surface is exemplary (four distinct states, wiring verified end to end) and is NOT a regression, but the check found the honesty defect pointing the **mirror** direction: the staleness state has no availability predicate, so it can tell users our prices are behind on packs that are simply no longer on sale. Everything else is a 06:12Z snapshot; re-derive before quoting.

Read-only sweep. **1 trust BREACH (known/#82, Trevor-gated) — but with a new, cheap datapoint that answers focus's owed question.** Everything else healthy. Late-night tick, so the 8am first-tick extras (1a) were skipped.

Environment note: **sandbox bash/clone is down** (the Sept-8 Windows-update mount failure — `Plan9 share "c" not mounted`), so the git-clone inbox path was unavailable. **Inbox written to mount, push unavailable.** All reads/validation done via the Supabase MCP + file tools, which are unaffected. Concurrency lock is RELEASED (nightly `np-20260913-a801`, ~22h ago), so this write does not race a run.

---

## LEAD — #82 mis-key detector is a LIVE producer, not a settled incident (KNOWN item, repair Trevor-gated — filed as signal, NOT an auto-ship candidate)

- **Source:** `rpc_ops_snapshot()` trust_health / `v_rpc_trust_health` metric `topshot_impossible_parallel_serials` = **35** (breach_at 3, status BREACH). Precompute row fresh (`rpc_trust_health_precompute.computed_at` 2026-09-14 00:48Z), so this is a genuine measured 35, **not** the 999 stale-sentinel.
- **The new datapoint:** same detector across three sample points — **5 (09-11) → 29 (nightly `.lock` note, ~09-13 08:2xZ) → 35 (now, 09-14 06:06Z).** Same metric, same precompute definition, so the three are directly comparable. **A monotonically climbing count is a LIVE producer** — this answers focus.md "STILL OWED #1" (re-read the daily rate to tell a live producer from a settled burst): it is live. The missing-case in the writer (`edIdToExt.get(editionId)` returning undefined — the one silent-exit `if` already narrowed in #82) is **still firing**, ~+6 impossible rows in ~22h.
- **Risk read:** read-only observation. The rows are inert to users (guarded at all 4 writers; the detector pages, it does not corrupt a surface), which is why nothing user-facing degraded.
- **Suggested action (NOT low-risk auto-ship — this is Trevor-gated per the nightly note "repair Trevor-gated"):** the night pass should treat the live-producer confirmation as license to prioritize the #82 writer fix (the single `if` in the Top Shot sales→edition redirect path) over re-measuring whether it's live — that question is now answered. Replay the route against a captured tick as #82 already specifies. Do **not** re-file the daily-rate re-derivation as open; it's answered.

## Everything else — healthy

- **Security:** 4/4 clean (invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`).
- **Stalled pipelines:** none (`detect_stalled_pipelines()` → `[]`).
- **pg_cron failures (`check_pgcron_recent_failures()`) — all explained, none a live finding:**
  - `rpc-reconcile-saved-wallet-stats` — `invalid transaction termination ... at COMMIT` at 05:44Z is a **stale pre-fix run**. It was caused by migration `20260914053000` pinning `search_path` on two transaction-controlling PROCEDUREs (a SET clause forces an implicit tx block, forbidding COMMIT); **already reverted at 05:46Z** (latest Vercel deploy READY, commit `fix(db): revert the search_path pin on the two procedures`). Clears on the 06:44Z tick. Prior ticks 00:44–04:44Z all `CALL` ok.
  - `rpc-serial-fmv-power-model-weekly` / `rpc-serial-fmv-jersey-weekly` / `rpc-topshot-onchain-rekey` — statement timeouts at 11:33–11:50Z on **09-13** (~18h stale), weekly/occasional cadence, saturation-collateral class. Not recent.
- **pipeline_alerts (all medium/info, timeout-class):** `fmv-backfill` 30.8%, `lock-check-batch` 35.8%, `price-snapshots` 46.7%, `run-insider-detectors` 35.4% — all `statement timeout` / `upstream request timeout`, the documented instance-saturation collateral class (#42/#73/#84/M11). **Positive control taken (`pg_stat_activity`: io_wait 1, active 0–1) — NOT in a spell right now**, so these accumulated during earlier spells, not a live event. `pack_distributions` data_stale 11d and the unmapped-backlog rows are the known by-design info items.
- **Vercel:** latest deploy READY (the reconcile revert); no ERROR/CANCELED/BUILDING state in the last 20 deployments.
- **Artifacts:** validated the merged `rpc-live-health` payload query — runs clean, every key returns sensible, fresh data (FMV / Pack-EV / edition-offers writes all within minutes; FMV latest 06:08Z). Did not individually re-run all 11 payloads this tick; core schema health is confirmed clean by the snapshot + this validation.
  - ⚠ Low-priority note (NOT led as breakage): `topshot_pack_reality_top_ev` returns **0 rows**, but it is a **plain VIEW** (relkind `v`) over a fresh `pack_ev_latest` (4,642 rows, last write 06:07Z), so this is a **legitimate empty state** (no Top Shot packs currently meeting the board's +EV/availability filter), not a stale/broken board — consistent with trust `public_board_empty_count=0`. Suggested (low): the surface-QA pass confirm `/insights/pack-reality` renders an honest empty state, not a "0 / broken" conclusion.
- **Sentry:** skipped — browser SDK off / events dropped per #34 (no-spend decision).

## Headline numbers (from `rpc_ops_snapshot()`)
- FMV HIGH+MED: TS **7,987** (1,357H / 6,630M), All Day **1,875** (115H / 1,760M), Golazos 4, UFC 0 (Pinnacle tracked separately). 
- Editions: TS 14,015 · NFL 6,190 · Golazos 575 · UFC 518 · Candy MLB 125.
- DB size: **30,492 MB** (~30.5 GB). TS edition-writer leak 48h: **0**. `ts_uuid_dupes_created_24h`: 0 (ok).
