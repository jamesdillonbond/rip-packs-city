# Overnight pass — 2026-09-21 (rpc-nightly-autonomous-pass, Cowork cloud)

**Run:** np-20260921-sbx-1677 · started ~01:03 AM PT (08:03Z) · **PUSH-CAPABLE** via `.rpc-git-cred`
credential store (dry-run exit 0). Real time from DB `now()` 08:02:57Z == shell 08:02:08Z — no clock
skew, genuine overnight window. Lock taken 08:02Z, released at end.

> This environment note is specific to **this cloud session**. Trevor's machine and Claude Code push
> normally via Git Credential Manager. Commit as usual.

## Verdict: HEALTHY / no regression. Nothing shipped — a quiet, honest night.

No clearly-safe + net-positive un-owned item presented. The night's value was closing five open
verifications (all benign) and confirming the 09-20 Small->LARGE resize drained the saturation-class
timeouts estate-wide. Ship budget used: 0 of 4.

---

## Health sweep (baseline: rpc_ops_snapshot() @ 08:03Z)

- **Security 4/4 clean** — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon [].
  All structural-drift arms [] (search_path, txn-control pins, backward_cursor_rewinds, suppression).
- **Trust-health: 0 breaches**, all 39 arms ok. trust_precompute_max_age_hours 5.26 (breach 13).
- **Sentry 0 new issues (24h) PAIRED with Vercel** — the dark-reporter discriminator. Vercel shows 50
  error groups but every one is **chronic** (first-seen Jun-Aug); the saturation collateral drained by
  ~21:06Z 09-20; the only groups first-seen 09-20 are a 2-minute Cloudflare **525/521 blip at
  17:38-17:40Z**, the instance's own LARGE-resize restart, self-resolved. No new error class.
- **Production deploy healthy** — latest READY is commit 1cf234f (dpl_2rM5...); newer commits are
  docs-only CANCELED builds (ignoreCommand/superseded). No ERROR states.
- **DB size 19,609 MB** (was 19,046 MB @ 09-20 08:10Z).

### Live findings and their disposition

1. **snapshot-institutional-wallets silent ~36h (HIGH)** — chronic no-marker stall class
   (M11/#42/#73/#84). Daily lane driven by cron-job.org console + a GHA backstop (no pg_cron job matches
   it — confirmed). Proven remedy is a hand-dispatch via the route's 202 path (last time: ok, 257 pages,
   ~74s). NOT a redeploy — the lane is CONTENT-DRIFTED (#23/R63). Dispatch needs either the cron-job.org
   console (Trevor's browser creds) or the gate key (off-limits secret) — neither is a clean lever for
   an unattended cloud run. -> QUEUED for Trevor (Q1). Fresh angle: now on LARGE, so if it dies again
   post-dispatch the cause is the lane's own paging cost, not IO saturation.

2. **Cross-collection mats 31.8h stale** (cross_collection_cohort_mat, ..._ts_set_overlap_mat; cap 26h)
   — both rebuild jobs (pg_cron 60/4) missed one daily rebuild, having timed out during the pre-resize
   saturation. Next scheduled tick self-heals on LARGE. Watch-only, no action.

3. **Failure-rate rows all cleared by the restart split** — allday-buyer-backfill, fmv-backfill, and the
   info lanes (backfill-pack-rip-metadata, lock-check-batch, run-insider-detectors) show 0 failed since
   the Sep 20 10:39 PT instance restart; the pooled 3-day rates straddle it and describe a box that no
   longer exists.

---

## Verifications closed this pass (read-only, no ship)

- **V1 - Top Shot HIGH+MED "fell ~974" (inbox 09-21T0011Z): RECOVERED / benign.** Now 7,749 (HIGH 1,355
  + MED 6,394) — above the 08:10Z baseline (7,241) and the 00:05Z dip (6,266). Total priced coverage
  (LOW+MED+HIGH) conserved (~10,958->10,922); the dip was a confidence-tier reclassification during the
  pre-resize spell and has reversed. No accuracy regression. Spend nothing.
- **V2 - Thin-FMV self-heal (inbox 09-20T1930Z Check 1): PASS.** Job 63 rpc-refresh-thin-fmv-guard ran
  01:30 PT (08:30Z) and **succeeded in 7 s** (vs 604s/601s statement-timeout kills on Small the prior
  two days); topshot_thin_fmv_editions now 11 rows, 0.0h stale. The duration was the tier, not the
  function — lane self-heals on LARGE. No fix, no ceiling raise.
- **V3 - rpc-weekly-wmc-reindex-6 "non-existent index" (inbox 09-20T1812Z, filed HIGH): FALSE POSITIVE
  confirmed** (already refuted by the 09-21T0318Z monitor). Live command (jobid 478) references
  idx_wmc_wallet_coll_ek_fmv_tier, which exists; last_status=failed is the stale 09-20 03:43Z weekly run
  (timed out on Small, pre-resize). Next run ~09-27 on LARGE. No action. (reindex-5/jobid 477 same class.)
- **V4 - Two invoked_but_never_logged lanes (inbox 09-20T1513Z): CLEARED.** pinnacle-metadata-backfill
  and classify-acquisitions-multicollection are absent from detect_stalled_pipelines() now — spell
  collateral, self-healed on LARGE.
- **V5 - Post-ship watch on prior ships: no regression.** Snapshot clean; jobs 324
  (thp-leg-impossible-parallel, ok 00:52 PT), 506 (refresh-fmv-confidence-precompute, ok 22:35 PT) both
  succeeded on recent ticks. jobid 560 not present in cron.job (retired/renumbered) — not re-chased.

---

## Queued for Trevor (no autonomous lever)

- **Q1 (HIGH):** Hand-dispatch snapshot-institutional-wallets via the cron-job.org console 202 path
  (proven: ok, 257 pages, ~74s). Chronic no-marker class; non-user-facing (institutional-wallet holdings
  snapshot only, no 500s, security clean). NOT a redeploy (content-drifted). Watch whether it dies again
  on LARGE (-> lane's own cost, not tier).
- **Q2:** Finish the gate-key rotation (carried from 09-20 ledger). compute-golazos-pack-ev still on the
  old 26-char burned key; 7 of 14 gate-keyed crons still on original short keys. Each needs one fresh
  secret from the operator, then rotate_cron_gate_key([jobids], ...). The pg_net_http_403 arm (7
  forbidden in 2h) is consistent with this, not a new regression.
- **Q3:** Panini ask-only disclosure denominator mismatch (inbox 09-20T1709Z). PaniniSqueezeClient.tsx
  footnote uses all-sets pct_sealed_usd_from_asks_only/editions_ask_only (51.6%) against an hc-subset KPI
  (53.8%) — understates its own subject. Fix is a view change + .tsx, one migration burst; Cowork can't
  push .tsx. Ready proposal in the inbox file.
- **Q4 (long-standing, #126):** cron/DB busy-seconds — atlas family (~87k s/day) + jobid 303
  refresh_wmc_fmv_changed (28.3k s/day) dominate; needs a product/architecture decision, no autonomous
  lever. Worth re-measuring now on LARGE — the resize drained the acute morning-band saturation, so
  #126's per-call cost should be re-derived warm-vs-warm on the new tier before any lever.
- **Carried (needs Trevor):** #22 purge-residue GC + rotate; #55 both 2-hourly Routines disabled since
  09-01; #130 ingest-pinnacle-mints gate key (if still unset).

---

## Housekeeping notes (not shipped)

- **Inbox backlog: 542 un-archived files** in docs/overnight/inbox/ (back to 2026-08-09); archive has
  273. Archiving touches INDEX.md which carries CI assertions (CLAUDE.md warns to read
  autonomous-tasks.md first), so I did NOT archive this pass to avoid a red-main landmine on a 0-ship
  night. Flagging for a deliberate hygiene pass. Tonight's consumed candidates are recorded here and in
  the ledger, so they need no re-investigation regardless.

## Revert paths

None — nothing was shipped. Output commit (this handoff + ledger + metrics + session note) reverts with
git revert <sha> if needed.
