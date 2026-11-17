# Handoff → Claude Code — two queued items from the 2026-11-11 overnight pass

**From:** Cowork cloud overnight pass (2026-11-11 ~1:05 AM PT). **HEAD at write time:** `11fc1af8d` on `main` (pushed).
**Already shipped live by the overnight pass:** nothing (0-ship night) — docs only. Both items below were QUEUED because each is gated out of the autonomous ship rules (off-limits ingest route-logic / pinned health instrument). Neither is urgent; no data is at risk in either.

> **Push note (scope):** This blocker is specific to the Cowork cloud session's autonomy rules, not to pushing. Your machine pushes normally via Git Credential Manager / `gh auth setup-git`. ⛔ Never use a PAT in `remote.origin.pushurl` — that route is DEAD (burned + removed 2026-08-16). Commit directly to `main`, no branches, no PRs. On Windows commit via PowerShell `git` (Git Bash `git commit` can silently no-op); re-verify with `git rev-list --count origin/main..HEAD` (expect 0).

> **STATUS 2026-11-11 ~10:45 PM PT (Claude Code cloud): BOTH ITEMS CLOSED.** Item 1 — Step 0 done from the Postgres log (holder = `wmc-fmv-populate`'s candy step, every 5 min, not the census); Option A rejected (no clear slot exists); Option B shipped (`e30ecd445`) AND the lock source fixed (`20261111172832`, `populate_wmc_fmv_from_snapshots` locks only rows it writes). Verified: 5:10 PM PT run ok, 0 rejected writes, 0 lock timeouts, 0 retries needed. Item 2 — fixed at the record rather than the arm: a 508 the resume queue catches is `ok=true` / `deferred_to: resume_queue` (`b87f40e91`); the 11-10 pre-queue rows age out of the 3-day window ~11-13. Ledger 11-11 entries carry every revert path.

> **Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

---

## Item 1 (MED) — `candy-editions-ingest` fails every 01:10Z tick on a `wallet_moments_cache` lock timeout

**Symptom (verified from `pipeline_runs`, two days running):** the 01:10Z tick FAILS with `1 rejected write(s): wallet_moments_cache: canceling statement due to lock timeout`; the 04:10Z tick succeeds. 11-11: 01:10:49Z FAIL / 04:10:49Z OK. 11-10: 01:10:49Z FAIL / 04:10:49Z OK. Shows in `rpc_ops_snapshot().pipeline_alerts` as MEDIUM (`2/5 runs failed`). **No data is lost** — the 04:10Z run re-ingests. The cost is the flapping MEDIUM arm, which would also mask a genuinely-new candy-editions failure landing at 01:10Z.

**Where it is (verified by grep, files exist):**
- Schedule: `vercel.json` — it is a **Vercel cron**, not cron-job.org: `{ "path": "/api/ingest/candy-editions", "schedule": "10 1,4 * * *" }` (01:10 and 04:10 UTC only). *(The overnight handoff guessed cron-job.org — that was wrong; correcting it here.)*
- The failing write: `app/api/ingest/candy-editions/route.ts` ~lines 341-352 — the `wallet_moments_cache` upsert loop:
  ```ts
  const { data, error } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
    .select("moment_id")
  if (error) {
    console.log(`[${PIPELINE_NAME}] wmc upsert err: ${error.message}`)
    writeErrors.push(`wallet_moments_cache: ${error.message}`)   // -> ok=false
  } else { serialsWritten += data?.length ?? chunk.length }
  ```

**Step 0 — identify the 01:10Z lock holder (do this first; the overnight pass could not, next 01:10Z was ~16h out).** At the next 01:10Z (3:10 AM wall / 09:10Z) snapshot the blocker chain:
```sql
SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
       now()-a.query_start AS running_for,
       a.application_name, left(a.query,140) AS query,
       cardinality(pg_blocking_pids(a.pid)) AS blocked_by_n,
       pg_blocking_pids(a.pid) AS blockers
FROM pg_stat_activity a
WHERE a.datname = current_database()
  AND (a.query ILIKE '%wallet_moments_cache%' OR a.wait_event_type = 'Lock')
ORDER BY running_for DESC;
```
Likely candidates writing wmc near 01:10: the Candy census (`/api/ingest/candy-collections-census`, Vercel cron `57 * * * *` — a 00:57 tick can still be mid-walk at 01:10) and the pg_cron wmc writers near the hour (`rpc-wmc-fmv-populate-backstop` job 486 at :04, `rpc-backfill-wmc-fmv-confidence` job 302 at :07/:12). Both 01:10 and 04:10 sit 13 min after a census tick, so if the census is the holder the real difference is overnight batch load — confirm, don't assume, across ≥2 ticks (per the monitor's own caution).

**Fix — pick after Step 0 (both are yours; neither is Cowork-shippable):**

- **Option A (lowest-risk, preferred if a clear slot exists): stagger the Vercel cron off :10.** Edit `vercel.json` to e.g. `"schedule": "20 1,4 * * *"` (or whatever Step 0 shows is clear — keep it off the census's :57 tail and off the pg_cron :04/:07/:12 wmc writers). This is a `vercel.json` change → needs a push + deploy to take effect (Vercel reads crons from the deployed config), which is exactly why it is a Claude Code item. **Revert:** restore `"10 1,4 * * *"`.
- **Option B (if no clear slot): a bounded retry on the wmc upsert.** Wrap the chunk upsert so a `lock timeout` (SQLSTATE `55P03` / message `canceling statement due to lock timeout`) retries 2-3× with a short backoff before it is recorded as a `writeError`. This is ingest route-logic (the autonomous pass treats this class as off-limits because of its invisible-failure history — hence the handoff), so pair it with a test and verify `ok` on the next 01:10Z tick. Note it is a PostgREST `.upsert()`, so `SKIP LOCKED` does not apply directly; the lever is retry/backoff, or raising the write's `lock_timeout` for this statement. **Revert:** `git revert` the commit.

**Verify:** `npx tsc --noEmit` clean; deploy READY; the next 01:10Z `candy-editions-ingest` run is `ok=true` with 0 `wallet_moments_cache` rejected writes (and the MEDIUM arm drops off `rpc_ops_snapshot().pipeline_alerts` once the window of failures ages out).

---

## Item 2 (LOW / cosmetic) — `wallet-backfill-continuation` reads HIGH on the already-recovered #245 lane

**Symptom:** `rpc_ops_snapshot().pipeline_alerts` carries HIGH `wallet-backfill-continuation` "5/5 runs failed (100.0%) over the last 3 calendar days … HTTP 508". **The lane is already fixed:** all 5 failures (newest 2026-11-10 22:11Z) pre-date the #245 fix `987f45865` (~2:25 PM PT 11-10, closed in the ledger); `wallet-backfill-resume` has been 100% green every 10 min since (queue draining, picked 0). No data at risk — pure instrument noise.

**Correction to the overnight handoff's framing (verified against the migration):** there is **no per-lane annotation to copy.** The streak-split is already automatic, from `supabase/migrations/20260923231922_audit_20260923_failure_rate_arm_also_splits_at_the_last_failure.sql` → view `public.v_pipeline_failure_rates` (sole reader: `get_pipeline_alerts_core()`). A lane is `cleared_by_streak` only when **≥20 runs have landed since its last failure, all ok, and that failure is ≥12 h old.** `backfill-pack-rip-metadata` cleared *automatically* because it fires hourly and accrued 25/25 ok. `wallet-backfill-continuation` fires only when a big wallet needs continuation, so it cannot reach 20 runs — and the migration says this is **deliberate**: "A daily lane can never reach 20 in the window, so it stays loud — the conservative direction."

**Recommended: no code change — it self-clears.** The pooled arm's window is `day >= CURRENT_DATE - 2`. The failures are all dated 11-10, so once 11-10 leaves that 3-day window (≈ 11-13, absent any new continuation failure) the `HAVING sum(runs) >= 5` no longer holds and the alert disappears on its own. It also clears earlier if the lane next fires and succeeds. Re-raise only if a **new** continuation 508 lands **and** `wallet-backfill-resume` stops draining (picked > 0 persisting).

**Only if Trevor wants confirmed-fixed rare lanes to clear faster (a design decision, not a bug fix):** add a small manual override — e.g. a `pipeline_alert_cleared_after(pipeline, cleared_after, reason)` table that `v_pipeline_failure_rates` LEFT JOINs to suppress a lane's pooled row for failures older than `cleared_after`, re-arming automatically on any failure newer than it. This touches the pinned health view + `get_pipeline_alerts_core()` (CREATE OR REPLACE VIEW appends columns only — 42P16; re-pin, preflight incl. the DB-invariant suite). **This is why the overnight pass did not ship it:** it is a suppression of a real-if-stale alert on a pinned instrument ("remove the failure mode; do not soften the detector"), and the alert is self-limiting anyway. Recommend declining unless the rare-lane false-HIGH becomes a recurring cost.

**Revert (if the override is built):** per the `20260923231922` pattern — `DROP VIEW public.v_pipeline_failure_rates` then re-create from the prior file in one txn, drop the override table, re-splice the arm.

---

## Guardrails (repeat every handoff)
- Direct-to-`main`, no branches, no PRs. If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via PowerShell `git` on Windows; re-verify `git rev-list --count origin/main..HEAD` == 0.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** — higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes.
- Commit the ledger entry BEFORE the code so the code commit is the deploying tip (a docs-only tip suppresses the Vercel build).

## Expected end state
- **Item 1:** one commit on `main` (vercel.json stagger, or the retry-wrapped route), deploy READY, the next 01:10Z `candy-editions-ingest` run `ok=true` / 0 wmc rejected writes.
- **Item 2:** no change recommended — the HIGH self-clears by ~11-13; a manual-override design is optional and declinable.
