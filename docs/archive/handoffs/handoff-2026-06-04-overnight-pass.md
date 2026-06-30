# RPC nightly autonomous pass — 2026-06-04 (overnight)

**Mode:** GENUINE OVERNIGHT (local ~05:57 PDT, just inside the 00:00–06:00 window) + **NO-PUSH** (scheduled sandbox has no GitHub credentials — `git push --dry-run` → `could not read Username`; `rip-packs-city-bot` clone still not mounted). Repo: shared `rip-packs-city`. DB migration (Supabase connector) applied normally; all repo outputs written to disk **uncommitted/unpushed** (persist on Trevor's machine via the mount; will be picked up by the next push-capable run). No code commit / Vercel deploy this run.

**Lock:** took over the RELEASED + ~28.5h-stale marker from 2026-06-03T08:23Z; claimed active marker at run start; released at end (overwrite — unlink not permitted on this mount).

**Collision gate:** `origin/main` = `a50f3dd` (unchanged through the run). Local HEAD = `e425621` (1 ahead = today's 06:21Z daytime-monitor doc, committed locally + unpushed; origin/main is its ancestor, no divergence). No human pushes mid-run.

**Ship budget:** 1 of ≤4 used (MON1). One regression (R1) found and QUEUED (not auto-revertable in NO-PUSH; real fix is off-limits).

---

## TL;DR

- **Health: GREEN with one new regression queued.** Security 0/0/0; Vercel 20/20 READY 0 ERROR; FMV compounding healthy; sentinel/DB/editions all nominal.
- **SHIPPED (1, subagent-verified PASS):** `audit_20260604_watchlist_fmv_recalc_stall_coverage` (MON1) — added the primary FMV writer `fmv-recalc` to `pipeline_cadence_watchlist` @120m/high, closing the 2026-05-25 silent-stall blind spot.
- **NEW regression — R1 (QUEUED, MEDIUM, operator/CC):** `topshot-moments-hydrator` `moments_write` is intermittently blocked by the new `offers_moment_id_fkey` (ON DELETE NO ACTION) introduced by yesterday's TS on-chain offers ship. ~8 fails since 11:22Z. Deploy-attributable; not auto-revertable in NO-PUSH (and `git revert` wouldn't remove the migration-created FK anyway); the real fix is a destructive `ALTER ... DROP CONSTRAINT` or worker logic — both off-limits. Ready-to-run fix below.
- **Auto-reverted: 0.** Post-ship watch on every recent ship (offers indexers, FMV mis-key sweep, last night's C-PAYER/C-PIN) is GREEN — none of them caused R1's symptom to require a revert; R1 is a forward-fix, not a revert.

---

## Post-ship regression watch (done first) — GREEN, nothing reverted

| Recent ship | Target metric | Re-measured tonight | Verdict |
|---|---|---|---|
| `f3011d9` FMV mis-key sweep (F2/F3/F4/F5, 06-03) | TS HIGH+MED ↑, NO_DATA ↓ | TS HIGH+MED **1062** (932 baseline → 1025 @06:21Z → 1062), NO_DATA **4049** (4424 → 4151 → 4049). AllDay flat (267/523). No Sentry correlation. | ✅ compounding correctly |
| `cc8a3e7` AllDay offers indexer (06-04 03:35Z) | `edition_offers` populated, indexer healthy | `allday-offers-indexer` 27/28 ok/24h, last 18m ago; `edition_offers` 9,056 rows / 5,771 positive. | ✅ healthy |
| `91ac5e1` TS offers indexer (06-04 04:02Z) | `offers` table populated, indexer healthy | `topshot-offers-indexer` 31/32 ok/24h, last 13m ago; `offers` 644 total / 500 open / 331 editions (↑ from 418/361/228 @06:21Z). | ✅ healthy data — **BUT introduced R1's FK (see below)** |
| C-PAYER + C-PIN watchlist tuning (06-03 night) | `detect_stalled()` clears the payer false-positive | `cadence-payer-balance-check` & `pinnacle-metadata-backfill` both absent from `detect_stalled()`; only N1 present. | ✅ holding |
| Smoke blips `NEXTJS-4` + `NEXTJS-J` (06-04 ~04:00Z deploy-swap) | stay single-event | Both still **1 event / 1 user**, last seen ~9h ago (~04:00Z), no recurrence. Markable resolved after 24h quiet (~04:00Z 06-05). | ✅ transient, closed |

The single offers-indexer fails (1 each in 24h) are upstream-request-timeouts — the known transient class, not regressions.

---

## Section 2 health-drift triage

**Security 0/0/0.** 0 RLS-off public base tables; 0 anon/authenticated write grants on RLS-off base tables (`relkind in (r,p)` filter applied — without it, the ~47 views false-positive). No drift.

**Vercel:** 20/20 recent prod deploys READY, **0 ERROR**. Prod tip `a50f3dd` (offers scope/handoff doc). No new deploys (NO-PUSH).

**Sentry:** 2 unresolved — `NEXTJS-4` ("smoke: market API returns Top Shot listings") + `NEXTJS-J` ("smoke: pack-listings responds"), both `POST /api/smoke-test`, 1 event each, last seen ~04:00Z (the deploy-swap window), no recurrence. No new issues. The R1 hydrator failures are **not** in Sentry — the hydrator is a Cloudflare Worker logging to `pipeline_runs`, so R1 surfaces only there.

**`detect_stalled_pipelines()` = 1 entry (legitimate):** `snapshot-institutional-wallets` (N1) — silent ~31h (1871m vs 1800m), HIGH. Run history confirms the cron pattern: it fires at the 06:00Z daily slot, fails on cron-rush pool/upstream timeouts (06-03 06:00Z `wmc_load_page_3 exhausted retries: upstream connect error`), and self-recovers off-peak — but no run has fired since 06-03 06:00Z (06-04 06:00Z slot missed). This is a **real** miss + fail (not a Q9 false-positive), so the threshold stays as-is; **operator: re-fire the cron-job.org entry and consider moving its slot off the 06:00Z peak.** Low product impact (0–3 rows/run). Unrelated to any recent ship → not a regression. After MON1, `fmv-recalc` is correctly NOT listed (ran 5m ago ≪ 120m).

**Pipelines (24h):** the known transient cron-rush class (connection-pool / statement / upstream timeouts at the 00:00/06:00/12:00Z rushes), all self-recovering: `pinnacle-nft-resolver` ×4, `allday-listings-retry` ×2, `allday-unmapped-resolver` ×2, plus single transients on `wmc-fmv-populate`, `hybrid_custody_events`, `topshot-stub-resolver`, `evm-transfers-ingest`, `check-alerts`, `pack-pull-source-rip-id-backfill`, `allday-listings-indexer`, and the two offers indexers. `compute-topshot-pack-ev` ×5 = PEV1 (`time_budget_exceeded_after_fetch`, upstream TS-GQL latency; `topshot_pack_ev_targets` 0 packs >7d stale → no product impact). `topshot-moments-hydrator` = **R1 (new, see below)** + N2 (candidate-read statement timeout, once 12:22Z — do NOT revert the materialized-CTE fix).

**Overnight metric deltas vs `metrics-latest.json` (06-03 08:18Z baseline):**

| Metric | Baseline | Tonight | Note |
|---|---|---|---|
| TS FMV HIGH+MED | 932 | **1062** | ↑ F-series cleanup compounding |
| TS FMV NO_DATA | 4424 | **4049** | ↓ improving |
| AllDay FMV HIGH+MED | 273 | 267 | flat (within noise) |
| sentinel TS-UUID-48h | 43 | **19** | ↓ well under 250 ok |
| unmapped_sales (total) | 278 | 214 | ↓ |
| editions TS / AllDay / Golazos / UFC | 16344 / 6191 / 581 / 446 | 16355 / 6191 / 581 / 446 | TS +11 normal |
| DB size | 5999 MB | 5920 MB | stable |
| Vercel | 14/14 READY | 20/20 READY, 0 ERROR | green |

**Artifacts:** 14/14 present; daytime monitor validated all 14 data layers healthy at 06:21Z. Tonight's only change was an additive `pipeline_cadence_watchlist` INSERT — no schema/view/RPC change — so no artifact's backing query could have drifted; none flagged broken; **none repaired** (per the "don't regenerate working artifacts" rule). `rpc-pipeline-reliability` will simply now surface the hydrator's elevated fail-rate (correct behavior).

---

## SHIPPED (1) — subagent-verified PASS

### MON1 · `audit_20260604_watchlist_fmv_recalc_stall_coverage` · add `fmv-recalc` to `pipeline_cadence_watchlist` @120m/high

**Why:** `fmv-recalc` is the platform's **primary sales-path FMV writer** (`lib/fmv-confidence` 1.7.0) but was not in `pipeline_cadence_watchlist` — so `detect_stalled_pipelines()` was structurally blind to an `fmv-recalc` stall. That is exactly the **2026-05-25 silent-stall** failure mode (fmv-recalc stalled 22:03→14:53, ~17h, caught by smoke/manual not by absence-of-runs; resolved `dd84526`). Same coverage-gap class as Q10 (`topshot-listing-cache`) and P1 (`evm-transfers-ingest`). From the 2026-06-04T03:17Z monitor inbox.

**Premises verified before shipping:**
- `fmv-recalc` (exact name) NOT already watchlisted — the `%fmv%` rows are `apply-fmv-haircut`, `drain-fmv-cold-tail` (inactive), `populate-pinnacle-wmc-fmv`, and the unrelated daily `ultimate-fmv-recalc-v1`.
- Cadence regular & healthy: 157 runs/48h, avg gap 18m, **max gap 40m, 0 gaps over 120m, 0 fails/48h**, last ran 5–15m ago → 120m has a ~3× safety margin over the worst observed gap; will not false-positive, but catches a multi-hour stall.

**Applied SQL (idempotent):**
```sql
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('fmv-recalc', 120, 'high', '<note>', true)
ON CONFLICT (pipeline) DO NOTHING;
```

**Verification:** row present (120m/high/active); `detect_stalled_pipelines()` does NOT list `fmv-recalc` (only the pre-existing N1). **Independent fresh-subagent PASS** — re-derived cadence (157 runs/48h, max gap 40m, 0 gaps >120m, last run 5m ago), confirmed row + no false-positive.

**Revert:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='fmv-recalc';`

**Target metric (re-check next run):** `detect_stalled_pipelines()` continues to NOT list `fmv-recalc` under normal operation; a future multi-hour `fmv-recalc` stall now surfaces in `detect_stalled_pipelines()` instead of being invisible to it.

---

## NEW QUEUED — R1 (the headline; operator/CC)

### R1 · MEDIUM · `topshot-moments-hydrator` `moments_write` blocked by `offers_moment_id_fkey` (NEW regression, deploy-attributable to the 06-04 TS offers ship)

**Symptom:** `topshot-moments-hydrator` fails its `moments_write` step with
`update or delete on table "moments" violates foreign key constraint "offers_moment_id_fkey" on table "offers"`.

**Onset & frequency:** first appeared **2026-06-04 ~11:22Z** (clean before — OK runs at 11:12Z and earlier). Recurring intermittently since: FK fails at 11:22/11:32/11:42/11:52, 12:42/12:52, 13:02Z (~8 in 2h), interspersed with OK runs (12:32Z) and one N2 candidate-read timeout (12:22Z).

**Root cause:** yesterday's TS on-chain offers ship (`91ac5e1`, deployed 06-04 04:02Z) + its migration `audit_20260603_offers_onchain_idempotency_and_indexes` created the `offers` table with FK `offers.moment_id → moments.id` **ON DELETE NO ACTION / ON UPDATE NO ACTION** (verified via `pg_get_constraintdef`). The `topshot-moments-hydrator` Cloudflare Worker (`workers/topshot-moments-hydrator/`) upserts/dedups `moments` rows; when it deletes or re-keys a `moments` row now referenced by an `offers.moment_id`, NO ACTION blocks the entire `moments_write` step. **Footprint:** 62 offers reference 48 distinct moments (45 open), and `offers.moment_id` is **nullable**. As `offers` grows, the conflict probability rises.

**Impact:** MEDIUM. Intermittent — only batches that include a conflicting moment fail; non-conflicting batches succeed, so hydration still progresses. No user-facing outage; FMV / analytics / insights / concierge unaffected (FMV is edition-level via `fmv-recalc`). The risk is hydration-freshness degradation for newly-pulled moments, worsening as `offers` accumulates.

**Why not auto-fixed this run:** (a) NO-PUSH — can't `git revert` worker/route code or deploy; (b) `git revert 91ac5e1` would NOT remove the FK anyway (the FK is from the migration, not the route code); (c) the actual fix is either a **destructive `ALTER TABLE … DROP CONSTRAINT`** (OFF-LIMITS destructive SQL) or **`workers/topshot-moments-hydrator/` worker logic** (OFF-LIMITS ingest/hydrator-adjacent + needs push); (d) genuine design choice (SET NULL vs CASCADE vs worker re-point) warrants Trevor/CC sign-off. So this is a forward-fix to QUEUE, not an auto-revert.

**Recommended fix — Option A (DB, minimal, recommended): change the FK to `ON DELETE SET NULL ON UPDATE CASCADE`.** `offers.moment_id` is nullable, so SET NULL is supported and preserves the offer row (it keeps its edition-level data; only the dangling per-moment link clears when the hydrator deletes/re-keys the moment). The next offers-indexer tick re-attaches the moment if still applicable.
```sql
ALTER TABLE public.offers DROP CONSTRAINT offers_moment_id_fkey;
ALTER TABLE public.offers ADD CONSTRAINT offers_moment_id_fkey
  FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE SET NULL ON UPDATE CASCADE;
```
**Revert:** `ALTER TABLE public.offers DROP CONSTRAINT offers_moment_id_fkey; ALTER TABLE public.offers ADD CONSTRAINT offers_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id);`
**Verify post-apply:** `topshot-moments-hydrator` stops logging the `offers_moment_id_fkey` error; FK still present (orphan-safe).

- **Option B:** `ON DELETE CASCADE` — deletes the offer row when its moment is deleted (re-populated next offers-indexer tick); only if losing the offer record on a moment-delete is acceptable.
- **Option C (worker):** re-point `offers.moment_id` to the canonical moment (or skip moments with dependent offers) before the delete, in `workers/topshot-moments-hydrator/`.

**Note:** this is a NEW finding the daytime monitor's 06:21Z sweep could not have caught (FK errors started 11:22Z, ~5h later). The next daytime-monitor run (scans `ok=false`) will independently surface it.

---

## Carried-forward queue (unchanged; operator/CC or external)

- **M1** (operator) — reschedule `topshot-fmv-populate` off the :00 cron-rush peaks (cron-job.org). Supplementary GQL writer (not load-bearing; `fmv-recalc` covers FMV). ~75% fail at :00 on pool/statement timeout; its one off-peak run succeeded. Not watchlisted (correct — sparse cadence would false-positive).
- **PEV1** (operator/CC) — `compute-topshot-pack-ev` `time_budget_exceeded_after_fetch` (~5/24h, upstream TS-GQL latency). 0 packs >7d stale → no product impact. Optionally lower `batch_size`/per-node timeout or drop these from ok-flag alerting. Pack-EV route logic = off-limits.
- **N1** (operator) — `snapshot-institutional-wallets` cron re-fire + move off the 06:00Z peak (see triage above). Re-flagged legitimately tonight.
- **N2** (operator/CC) — `topshot-moments-hydrator` candidate-read statement timeout at cron rushes (do NOT revert the materialized-CTE fix). Needs `statement_timeout` bump / supporting index / further view-cost reduction. (Distinct from R1.)
- **N3** (operator) — payer wallet `0x73f55c4450b8d466` funding/cron-revival decision. Monitoring slice already shipped (C-PAYER). Re-activate when reviving a gas feature.
- **L1** (operator/CC) — `league-drift-detection` cron-wiring intent (one-shot vs recurring).
- **PIN1** (operator/CC) — `NEXTJS-15` pinnacle-listings-indexer Sentry gate counts `cadence_capped` deferrals toward the spike threshold (route capture logic). Aged out of unresolved set currently.
- **Q2** (operator, watch) — `compute-laliga-pack-ev` cadence (by-design Golazos).
- **Q5** (operator/CC) — smoke sales-lag threshold rebase to last-successful-run.
- **Q6** (low) — `evm-transfers-ingest` Base-429 backoff (ingest piece shipped `8605c43`; watchlist piece resolved via P1).
- **Q7** (INFRA, Trevor) — scheduled sandbox has no push creds + bot clone not mounted → DB + artifact + on-disk-docs only. **Confirmed again this run** (`git push --dry-run` → could not read Username). Durable fix = a sandbox-native clone with its own creds syncing via `origin`.
- **Q8** (operator/CC) — badge-sync `onConflict:id` vs `UNIQUE(external_id,collection_id)` row-grain (moot for offers via `edition_offers`).
- **F1 / F2-TierB** (operator/CC) — broader serial>circ mis-key batch + 65 residual Cosmic 8:62 Tier-B sales (need on-chain confirmation; F3 guard protects WAP meanwhile). Eyeball-note: 8:62 Giannis Cosmic (circ 49) resolves to FMV HIGH $2.43 off 14 serial≤49 sales — reads low for a circ-49 Cosmic; confirm those 14.

---

## Output checklist

- [x] DB migration `audit_20260604_watchlist_fmv_recalc_stall_coverage` applied + subagent-verified PASS.
- [x] This handoff written (on disk; **unpushed** — NO-PUSH).
- [x] CLAUDE.md "Recent sessions" prepended.
- [x] `docs/overnight/ledger.md` updated (MON1 shipped + R1 queued + N1 reconciled + carry forward).
- [x] `docs/overnight/metrics-latest.json` overwritten with tonight's metrics.
- [x] Inbox drained (4 files → `inbox/archive/`).
- [x] `.lock` released.
- Local git commit attempted best-effort; **not pushed** (no creds). All files persist on disk for the next push-capable session.
