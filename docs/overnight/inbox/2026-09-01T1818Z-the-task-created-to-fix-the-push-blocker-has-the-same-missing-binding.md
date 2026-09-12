> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T1818Z — the task created to fix the push blocker has the same missing binding, and the reindex verify has flipped back to `ok:false`

**Pass:** cloud, fired 18:18:43Z by `trig_018AyNcnbCZuYb1Ztts6rbBR`. DB now 18:19:23Z = 11:19 PT. Repo `origin/main` 355b01d1 read 18:22Z. Health GREEN. 1 metadata-only migration.

> ⚠ NO-PUSH is specific to **this cloud session** (proxy: *"not in this session's authorized repository set"*). Trevor's machine and Claude Code push normally. Commit as usual.

---

## 1. The supersession did not take (⛔ needs Trevor, and it is the root cause of every stranded artefact)

`trig_018AyNcnbCZuYb1Ztts6rbBR` — named *"device-bound v2, folder-attached"*, prompt asserting *"✅ THIS TASK IS DEVICE-BOUND AND CAN PUSH"* — reports `derived_state.folders_state = FOLDERS_STATE_NONE` and `created_via = meta_mcp`: **byte-identical binding state to `trig_01AZzLzkTPp5xbSjK1EFmeCw`, the task it was created to replace for exactly that defect.** No `mcp__remote-devices__*` tool was present in this session and the push was refused.

- ⛔ **A third MCP-created task will not fix it.** Re-create from the Claude **desktop app on the machine**, and confirm the approval card offers a device/folder binding *before* approving. A binding cannot be added after creation.
- ⚠ **The old task is still enabled**, next fire 18:58Z, last run **FAILED** 16:58:27Z after 13 s. Delete it. Not done here — destructive account change, and the prompt authorised reporting.

## 2. Parity is RED, by NAME, for ~7 hours

`20260901110757`, `20260901112618`, `20260901113812` (the 10:58Z pass's seeded-wallet reconciler) + `20260901183010` (this pass). Recover with `node scripts/recover-fileless-migrations.mjs --window 1` — byte-exact from prod. ⛔ Never retype; md5s are in the handoff.

## 3. Open thread 14 must be RE-OPENED

`run_wmc_reindex_verify()` at 18:31Z → **`ok:false`**, three of four targets below the 60 % floor (45.21 / 48.02 / 51.75 / 76.36), total **1,025.9 MB vs 629.7 MB post-wave** — **+396.2 MB in 38.4 h ≈ 10.3 MB/h**. `invalid_left: []`, so bloat only.

⭐ **Not a vacuum problem** (`n_dead_tup` 26,492 on 2.51 M live; 680 autovacuums; last 17:29Z). It is **write amplification**: `n_tup_upd` 47.03 M vs `n_tup_hot_upd` 2.12 M = **4.52 % HOT**, with **18 indexes / 1,553 MB on a 940 MB heap**. The churning columns are all indexed, so `fillfactor` cannot recover HOT either.

👉 **The lever is fewer indexes.** Two are provably redundant — `idx_wmc_cohort_cover` (295.9 MB, 12,042 scans) is a strict prefix with identical INCLUDE of `idx_wmc_wallet_coll_ek_fmv` (246 MB, 2,158,096 scans); `idx_wmc_collection_id` (43 MB, 8,080 scans) is a strict prefix of two others. **338 MB.** Held for a 02:00–04:00Z pass: `DROP INDEX` takes ACCESS EXCLUSIVE on a table taking 47 M updates and this was the 11:30 PT peak write band. Use `DROP INDEX CONCURRENTLY` via `execute_sql` (it cannot run inside `apply_migration`'s transaction), and name `idx_wmc_cohort_cover`'s reader first (`ccm-step1`/`ccm-step2`, jobids 60/4, both in the 23Z band).

## 4. Shipped — `20260901183010`, metadata only

`v_pipeline_failure_rates` is a **three-calendar-day** window (`day >= CURRENT_DATE - 2`), not the "trailing 48 h" the repo keeps calling it, so a failure leaves it at a UTC midnight between 48 h and 72 h later. Guarded `COMMENT ON VIEW` now says so, with the measured `fmv-backfill` instance (5/17 = 29.4 %, all five failures on 08-30, all predating `20260831045517`, 11 consecutive ok since).
**Falsifiable prediction: that alert clears at 2026-09-02 00:00 UTC.** Still armed at 00:30Z ⇒ this reading is wrong.
**Revert:** `COMMENT ON VIEW public.v_pipeline_failure_rates IS NULL;`

## 5. Answered from the 08-29 entry

`get_lock_check_batch` post-reindex: **21,618 blocks/call, 18,032 ms/call** over 10 calls — unchanged, and its index `idx_wmc_lock_wallet_coll` was **never** in the wave's target list (confirmed against the verify function 18:31Z). Its alert nevertheless recovered: **6/6 ok** in 3 h vs **27/96 = 28.1 %** failing on 08-29. Two independent facts; do not conflate.

## 6. Small things worth not re-deriving

- ✅ Open thread 15's "scheduling the pgss snapshot is queued for Trevor" is **stale** — it is `cron.job` jobid **427**, `5 */2`, postgres, active. Strike the line.
- ⚠ Vercel `get_runtime_logs` with a `level` filter **times out at 25 m / 60 m / 3 h**. `group_by` is fast. 24 error-level lines in 3 h could not be read.
- Dead host probed again: **530, 530**, positive control **200**. EXIT not met, class stays paused.
- Rank 1 in the pgss diff is `query_sql` (803,507 blocks / 130 calls) — the pass's own MCP channel, not production.
