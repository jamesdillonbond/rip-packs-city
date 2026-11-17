# Overnight pass — 2026-10-13 (~1:15 AM PT)

⚠ **ROUTED 3+ NIGHTS (first-line):** **#58 `OPENSEA_API_KEY`** — the oldest routed item, ~19 nights, **Trevor-shelved 09-23**. One env var in Vercel (all envs) + redeploy closes the candy-opensea *and* Panini halves. No code lever; not neglect, a held decision.

> ⚠ **Scope line (environment):** This pass ran as a **cloud nightly** session. Push worked via the device-VM clone + the mount's `.rpc-git-cred` (dry-run `git push` exit 0). Any "push unavailable" note in a *past* handoff is specific to the cloud session that hit it — **Trevor's machine and Claude Code push normally via Git Credential Manager; commit these files as usual.**

**Verdict: GREEN · 0 shipped · idle: routed-to-trevor / routed-to-claude-code · oldest routed: #58 OPENSEA_API_KEY ~19 nights.** A genuinely quiet, healthy night — every instrument clean, every anomaly known/by-design, nothing novel and low-risk to execute. Docs-only output (handoff + ledger + metrics), committed and pushed.

---

## Mode & gates
- **Real time:** DB `now()` 08:07Z and shell `date` 08:07Z **agree** → no clock skew this run. 08:07Z = **1:07 AM PT** → genuine overnight window, normal-shipping mode.
- **Lock:** prior `.lock` was 528 min old (held 2026-10-12 23:19Z) → STALE, took over (run `7dffcc37`). Released at end.
- **FREEZE:** none.
- **Push:** capable (device-VM clone + `.rpc-git-cred`, `git push --dry-run` exit 0). `add_repo` cloud-direct path absent this session; used the VM path.
- **Capability:** cloud `bash`/git/df green (31 GB free); `device_bash` + `device_list_dir` both alive; Supabase + Vercel MCP up; Sentry still dark (quota off since 08-18, #34 — health read from Vercel + DB + beacon, never a Sentry zero).

## Reviewed
- **Inbox:** no filing newer than `2026-10-11T0200Z`; all were already drained by the 10-12 pass (INDEX append-only, left untouched). Nothing to fold in.
- **Ready-queue** (`node scripts/report-ready-queue.mjs`): 6 items from the 10-12 handoff, 3 flagged still-open — all Trevor/operator/Claude-Code owned (see "Carried queue" below).
- **Artifacts:** none flagged broken/stale by the monitor; no schema change since the last pass broke one. No repair needed.
- **Post-ship watch (10-12 batch — ~a dozen code commits + the `14f793e` rpcWithRetry fix + the axe/contrast/edition-description/security/CI work): CLEAN.**
  - Latest **READY** prod deploy = `053657f43` (carries every 10-12 app fix). The two later commits `a3754eea` (CI shards) and `be1f0bcc` (ledger) are docs/CI-only → correctly CANCELED by `ignoreCommand` (CLAUDE.md: a docs-only push never rebuilds; a push can create no deploy). Expected, not stuck in ERROR.
  - Vercel 24h = **9 error groups, all chronic/by-design**: ipfs-media 12s timeout ×10 (chronic 09-03), candy-opensea `OPENSEA_API_KEY` ×8/8/4 (#58), pack_market >5s ×1 (chronic 08-23), collection-snapshot `RPC_READ_TIMEOUT` 8s ×1 (chronic 09-11), one Supabase-502 Cloudflare blip (market-cap tile, 09:58Z 10-12), Panini collector-walk 57014 per-walk-cap timeout ×1 (by design). **No new group traces to the 10-12 batch.**
  - **`[edition] get_edition_detail error undefined`** group: last occurrence **2026-10-12 14:24Z** = the *original* 7:24 AM PT trigger that prompted the `14f793e` message-guarantee fix. **No recurrence after the fix deployed** → fix holding. (Re-check tomorrow: this group stays flat; a post-14f793e occurrence would carry a real message now.)

## Health-drift findings + deltas
**GREEN on every instrument** (`rpc_ops_snapshot()` 08:10Z):
- Security: `invariants` / `anon_write_holes` / `rls_off_base_tables` / `secdef_anon_violations` all `[]`.
- Structural: `function_search_path_drift`, `procedure_txn_control_pins`, `procedure_search_path_unpinned`, `cross_collection_mat_staleness`, `backward_cursor_rewinds`, `wmc_null_edition_key`, `suppression_parked_claim_drift` all `[]`.
- Trust: **0 breaches, 38/38 arms ok.** precompute_max_age 5.37 h (breach 13); unmapped_resolution_backlog_max 6 (breach 100); `public_board_slow/empty` 0.
- Pipelines: `stalled_pipelines []` — **the TS active-listings feeder box recovered** since last night (was silent 1,320 min on 10-12; now not stalled). Sentinels `ts_uuid_editions_48h` 0, `ts_uuid_dupes_24h` 0. timeout-blind 0. zero-yield 0.
- Alerts (all known): candy-opensea 3 lanes 100% fail = **#58**; `panini-collector-walk` 8/22 = per-walk 10-min cap (by design, `walkOrder` rotates start); five Atlas `*-upstream-403` lanes INFO (Cloudflare challenges 5–15% base, nothing lost, re-walked next tick; last clean drains fresh).
- `suppression_count_predicate_drift`: `topshot-misattrib-drain` observed **877** > 500 — known #101, **draining** (1,485 → 987 → 877). Falls below 500 in ~2 d at this rate. No action.
- **Accuracy gate (`fmv_sales_backtest` 7 d):** Top Shot published ALL **13.0%** median abs err, ratio **1.000** (HIGH 9.5% / 83.5% within 25%); All Day published ALL **21.1%**, ratio **1.000** (HIGH 13.3%). No estimator drift (both ALL ratios at 1.0). The All Day `STALE` n=11 ratio 6.0 and `ASK_ONLY` n=67 ratio 1.8 are the known tiny worst-buckets, within design.

**Deltas vs 10-12 metrics:**
- db_size 36,440 → **37,128 MB (+688)** — Panini catalog walks (+204 editions to 27,716) + `flowty_archive` scratch growth. Not alarming (37 GB).
- FMV HIGH+MED: topshot 8,207 → **8,193** (−14), panini 6,424 → **6,535** (+111), pinnacle 868 → **892** (+24), nfl_all_day 1,663 → **1,622** (−41), candy 68 → **72** (+4), golazos 7 → **6** (−1), ufc 0.
- Trust breaches 0 → 0. misattrib #101 987 → 877. precompute 5.42 → 5.37 h.

**One watch (not an action):** `candy_sales_stale_hours` 28.8 (breach 30) — candy is a 125-edition low-volume collection and Magic Eden (its primary sales source) is not in any stalled/failing list, so 28.8 h between candy sales reads as genuine low volume, not a stall. The OpenSea candy-sales half is down under #58 but is additive. Watch for a breach ≥ 30 that persists.

## Shipped
None. Nothing novel and low-risk was open; the carried queue is entirely Trevor/operator/Claude-Code owned.

## Carried queue (needs a non-night-pass owner)
1. **[P-med, Trevor, ~19 nights] #58 `OPENSEA_API_KEY`** — candy-opensea listings/offers/sales indexers (and the Panini half) 100% fail on the missing env var. One env var in Vercel (all envs) + redeploy. Shelved by Trevor 09-23. Candy stays green via Magic Eden; OpenSea is additive.
2. **[P-low, Trevor] topshot-active-listings-ingest feeder** — residential Windows feeder box dark stalls the TS live-listings/ask feed (visibility-only; FMV itself fresh). **Recovered this pass** (`stalled_pipelines []`), so not currently stale — carry only as a known recurring-when-box-off item. No code fix; box availability / a second feeder.
3. **[P-low, operator-blocked since 08-22] #23 / #25 edge-fn drift** — 25 edge functions not running `main`; three daily drift detectors unsurfaced. Needs the operator-driven GHA deploy path. (Ledger hint: likely closed — the 10-12 scheduled `edge-fn-drift` run read `proven_drifted 0` / `content_drifted 0`; left carried pending Trevor's confirmation it can be retired.)
4. **[operator-gated, Trevor] `drop_scratch` residue** — `flowty_archive.scratch_*` (~185 MB, Trevor's data). The drop SQL (`scripts/flow-wallet-walk/drop_scratch.sql`) needs the dashboard SQL editor (MCP write-hold + destructive). Items 1+2 (dedupe + drop) already ran 10-10; the remainder is Trevor's call.

## Verified closed this pass (dropped from carry)
- **`topshot_offers_history_backfill` cursor_stalled** (was routed to Claude Code, ~2 nights): **not live** — absent from `get_pipeline_alerts()` / the 08:10Z snapshot; the completed one-time backfill (`done=true`) was already retired by bounded suppressions `20261011144350` (10-11). False positive, no action. Re-open only if the cursor MOVES (re-dispatch).

## Failed / blocked / reverted
None. No shipping attempted → no verification failure, no hard-stop.

---
*Lock `7dffcc37` released. Ledger + metrics-latest.json updated and pushed (device-VM clone + `.rpc-git-cred`). Handoff mirrored to the claude.ai Project.*
