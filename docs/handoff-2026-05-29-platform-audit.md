# Claude Code handoff — 2026-05-29 platform audit

Owner: Trevor. Companion to the Cowork live dashboard `rpc-live-health` artifact. This handoff captures findings and the code-side work this Cowork pass could not ship (it has DB + edge-function but not route-code write access).

## Headline state (verified live, 2026-05-30 02:10 UTC)

- **Website healthy.** `/api/health` returns 200 in ~555ms. Root + collection routes return 307 (correct — auth redirect to `/login`). Last successful production deploy 2026-05-27 23:58 UTC (commit `962f324`, FMV Items 4+5).
- **Pipelines 99%+ green over 24h.** 4,989 runs, 24 failures. The only meaningful failure is `topshot-fmv-populate` at 0/1 — false-alarm `ok=false` flag (see #1 below).
- **One real Telegram alert:** `snapshot-institutional-wallets` silent for ~47h since 2026-05-28 02:47 UTC (max-silent-minutes = 1,800 = 30h). Either the daily cron-job.org entry stopped firing or the edge function bails before logging.
- **FMV catch-up working as designed.** Since the 2026-05-28 Items 4+5 deploy: 3,004 AllDay editions written by fmv-recalc `1.7.0` in last 24h vs 2,617 by `allday-fmv-populate` (`allday-gql-v1`). Allday-gql-v1 winners 3,786 → 1,805 in ~46h. On track to hit ~0 in another ~2 days.
- **LOW→STALE gate verified.** TS LOW-zero-60d-sales = 0 (was 828). AllDay LOW-zero-60d-sales = 0 (was 1,827). Post-deploy fresh STALE writes tagged `1.7.0`: 845.
- **TS UUID-edition writer is still leaking — but inert.** 5,067 UUID-keyed TS edition rows created in last 48h; 0 of them have populated on-chain IDs. The 2026-05-28 trigger upgrade (`BEFORE INSERT OR UPDATE`) is correctly null-ing on-chain IDs on the writer's follow-up UPDATE, making the rows inert. But the GQL ingest writer is still hitting the UUID fallback path despite the 2026-05-28 fix that was supposed to prefer `${set.flowId}:${play.flowID}`. ~73k inert rows/month of accumulating bloat. Needs source-side fix.

## Items to ship

### 1. `topshot-fmv-populate` false-positive `ok=false`

**File:** `app/api/topshot-fmv-populate/route.ts` (or wherever it logs pipeline_runs).

**Symptom:** Latest 3 runs all log `ok=false` while `extra` shows `sweep_complete: true, terminated_reason: "feed_exhausted", upserted: 0, gql_error: null`. The 2026-05-28 02:45 run with `upserted: 304` logged `ok=true`, so the failure flag fires on the upserted=0 path.

**Cause:** The route likely flags `ok = upserted > 0`. That's wrong: when the marketplace feed has nothing new to upsert (steady state), the sweep is a success, not a failure.

**Patch:** Set `ok = sweep_complete === true && gql_error == null` (or similar — `upserted=0` should not flag fail when the sweep completed cleanly). Update the call to `log_pipeline_run` so steady-state `upserted: 0` runs land as `ok=true`.

**Verify:** After deploy, the next sweep with `upserted: 0` should write `ok=true`.

### 2. TS GQL editions writer — UUID fallback path still hot

**File:** `app/api/ingest/route.ts` — specifically the `buildEditionKey` + `upsertEdition` paths that the 2026-05-28 fix touched.

**Symptom:**

```sql
SELECT COUNT(*) FROM editions
WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND external_id !~ '^[0-9]+:[0-9]+$'
  AND created_at >= NOW() - INTERVAL '48 hours';
-- 5,067 (all with NULL on-chain IDs after trigger nulled them)
```

The 2026-05-28 fix said the GQL query was updated to request `set.flowId` and `play.flowID`, with `buildEditionKey` preferring `${set.flowId}:${play.flowID}` (integer pair) and falling back to `${set.id}:${play.id}` (UUID) only defensively. Currently the fallback is firing for every TS ingest call.

**Likely causes** (investigate, then patch):
- The Top Shot consumer GQL response sometimes omits `set.flowId` / `play.flowID` for moments not yet published in the consumer schema. If so, the writer needs to enrich those rows by calling Cadence `TopShot.getPlayMetaData(playID:UInt32)` + `getSetSeries(setID:UInt32)` against the integer IDs the on-chain Withdraw/Deposit event gives us — NOT fall back to UUIDs.
- The GQL query might not actually be asking for the right field names. Verify the deployed query string matches the schema. The relevant GQL field on the Top Shot consumer schema is sometimes `.flowID` (uppercase D) not `.flowId`; mismatched casing returns `null`.

**Recommended path:** Add a one-line diagnostic write to `pipeline_runs.extra` from the writer — counter for `int_pair_keys_written` vs `uuid_fallback_keys_written`. The current state is invisible to logs because the trigger silently nulls them. After the diagnostic ships, root cause is one query away.

**Once fixed:** Re-merge the ~5k current inert UUID rows in the same shape as `audit_20260528_merge_topshot_uuid_dupes_post_writer_fix` — but adapted because these have NULL on-chain IDs (so they need to be DELETEd outright, not repointed; verify no FK dependents first).

### 3. `snapshot-institutional-wallets` silent >47h

The cron should run daily (`30 1 * * *` or similar). Last successful run 2026-05-28 02:47 UTC. The edge function has run successfully many times — the cron-job.org entry has either been disabled, missed runs, or the function is timing out before logging.

**Diagnose:**

1. Check cron-job.org dashboard for the `snapshot-institutional-wallets` entry — `failed_executions` count, last error, last attempt.
2. If cron is firing, query `pipeline_runs` for unsuccessful attempts since 2026-05-28: `SELECT * FROM pipeline_runs WHERE pipeline = 'snapshot-institutional-wallets' AND started_at >= '2026-05-28' ORDER BY started_at DESC;` (already done — only the 02:47 success exists; no failed rows means cron isn't firing OR the function isn't reaching `log_pipeline_run`).
3. Manually trigger via curl with `Authorization: Bearer $INGEST_SECRET_TOKEN`. If it succeeds, the issue is cron-job.org config drift.

**Optional improvement:** Wrap the edge function's main work in a try/catch that always writes a `pipeline_runs` row even on early bail, so a silent failure surfaces as `ok=false` rather than as a 47h-of-silence alert.

### 4. (Optional) Diagnostic: surface inert-row count to `/api/sentinel`

Add a column to the sentinel response: `editions_inert_uuid_keyed_48h` (the count from #2). Trevor can then watch the leak rate drop without manually running the query. Single SQL addition to `app/api/sentinel/route.ts` — no logic change.

## What this Cowork pass shipped

- Built a live Cowork artifact `rpc-live-health` that re-queries Supabase on every open: 24h pipeline success, FMV confidence per collection, AllDay catch-up bar chart, per-collection freshness, open alerts, and the inert-row counter from #2.
- Verified the 2026-05-28 FMV Items 4+5 deploy is actually running and producing the expected confidence shifts.
- Decomposed the still-firing pipeline alert and traced the inert-row symptom to its source.

## Tests to run before this handoff is "done"

After the route-code fixes land:

1. **`/api/topshot-fmv-populate` (or wherever it logs):**
   `SELECT pipeline, ok, extra->>'upserted' FROM pipeline_runs WHERE pipeline='topshot-fmv-populate' ORDER BY started_at DESC LIMIT 3;` — should show `ok=true` for steady-state `upserted: 0` runs.
2. **TS edition writer leak:**
   `SELECT COUNT(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id !~ '^[0-9]+:[0-9]+$' AND created_at >= NOW() - INTERVAL '1 hour';` — should drop toward 0.
3. **Institutional snapshot:**
   `SELECT pipeline, started_at, ok, extra->>'wallets_processed' FROM pipeline_runs WHERE pipeline='snapshot-institutional-wallets' ORDER BY started_at DESC LIMIT 3;` — should show a fresh row within 24h of the fix.

## Append to CLAUDE.md after shipping

Under "## Recent sessions" at top:

```markdown
### May 29, 2026 — Cowork platform audit + handoff: topshot-fmv-populate flag, TS UUID writer leak, institutional cron silent

Cowork-side platform audit. No code shipped this pass (Cowork can't push routes); findings + handoff in `docs/handoff-2026-05-29-platform-audit.md` and the new live artifact `rpc-live-health`.

Verified:
- FMV Items 4+5 deploy from 2026-05-28 is working — 845 fresh STALE writes tagged 1.7.0; TS + AllDay LOW-zero-60d-sales = 0; AllDay 1.7.0 catch-up moving at ~32/hr.
- Platform health 99%+ green; only meaningful failure is `topshot-fmv-populate` false-alarm.

Open:
- `topshot-fmv-populate` flags `ok=false` on steady-state `upserted: 0` sweeps. Route-level fix.
- TS GQL editions writer still hits UUID fallback (5,067 inert UUID rows in 48h; trigger nulls their on-chain IDs so no canonical corruption). Source-side fix in `app/api/ingest/route.ts` `buildEditionKey`.
- `snapshot-institutional-wallets` silent ~47h; cron-job.org or edge-function issue. Worth a try-catch + `pipeline_runs` write on early bail.
```
