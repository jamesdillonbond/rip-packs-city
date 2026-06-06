# RPC nightly autonomous pass — handoff 2026-06-05

**Mode:** GENUINE OVERNIGHT (local 01:02 PDT, inside 00:00–06:00) + **NO-PUSH** (scheduled sandbox has no GitHub credentials — `git push --dry-run` → `could not read Username`; `rip-packs-city-bot` clone still not mounted). DB migrations (Supabase connector) + artifact checks apply normally; repo doc outputs written to disk **uncommitted/unpushed** (persist via the Windows mount). No code commit / Vercel deploy this run.

**Lock:** prior `.lock` was a RELEASED marker from 2026-06-04T13:19Z (~19h stale) → took over; wrote a fresh ACTIVE lock (runid 1282232661) at run start, released at end (overwrite — mount denies unlink).

**Repo state at start:** local HEAD == origin/main == `830bfdb` (0 ahead / 0 behind). Re-fetched before each ship — origin/main never advanced. Trevor's interactive session wound down ~06:31Z (last commit `830bfdb` rewards-referral); last DB migration 06:50Z. Collision gate clean all run.

**Outcome:** Platform GREEN. Shipped **2** additive/reversible DB migrations (AF1 view optimization + MON-WATCH watchlist), both independently subagent-verified PASS. Auto-reverted 0. Reconciled **R1 + SEC1-EXP as already-resolved** (Trevor/CC). One real escalation queued: **DUPE1** — the inert TS UUID-dupe re-mint crossed the sentinel CRITICAL floor (true positive; durable fix is off-limits worker code).

---

## 1. Post-ship regression watch (last 24–48h ships) — ALL GREEN, nothing reverted

| Shipped change | Target metric | Re-measured now | Verdict |
|---|---|---|---|
| **MON1** (06-04 night) `audit_20260604_watchlist_fmv_recalc_stall_coverage` | `detect_stalled_pipelines()` covers fmv-recalc, no false-positive | `detect_stalled_pipelines()` = `[]`; fmv-recalc not falsely listed | ✅ holding |
| **R1 fix** (06-04 14:47Z) `audit_20260604_offers_moment_fk_on_delete_set_null` | hydrator stops logging `offers_moment_id_fkey` violations | 17 FK fails/24h but **last at 14:42Z** (pre-fix); **0 since 14:47Z** | ✅ RESOLVED |
| **FMV cluster** A1/A2/F2/F4 (`1c5ccf5`,`bf4cbd5`,`b8a0a49`,`d881a75`,`fd61038`) | TS HIGH+MED ↑, NO_DATA ↓, no fmv-recalc hot-path regression | fmv-recalc **85 runs/24h, 0 fails**, fresh 19.8m; TS HIGH+MED **2944** (was 1062), AllDay **495** (was 267) | ✅ big win |
| **DQ1/DQ2 dedup** (06-05 02:40–03:10Z) `audit_20260605_dq1_*`,`_dq2_*` | TS edition dedup; FMV improvement | TS editions 16,355 → **11,498** (re-climbing, see DUPE1); FMV improved | ✅ intended |
| **pack-reality honesty** `8f3fff9` + `audit_20260605_pack_reality_top_ev_honesty_filter` | `topshot_pack_reality_top_ev` → honest packs only | view returns **3 rows**; code live (2 ERROR deploys were the transient build-infra blip, superseded by descendant READY deploys) | ✅ live |
| **rewards referral** `830bfdb` + 5 `rewards_*` migrations (06:45–06:50Z) | referral earn fires on minted path | current prod deploy READY; no Sentry fallout | ✅ |
| **share OG** `158409d`→`b3dae3db` | /share OG renders | NEXTJS-1G self-resolving (culprit route deleted) | ✅ |

**Vercel:** current prod `dpl_5HAtKDUS4PAjiQDJWgg7ysAxEHAn` = `830bfdb` READY. 18/20 recent READY; the 2 ERROR are both the **same** `8f3fff9` SHA (transient build-infra: build logs compiled clean then ERROR with no error text — the documented pattern) and were superseded by `c99cdf1`/`301bc56`/`830bfdb` which built the same tree clean. No real ERROR; nothing to revert.

---

## 2. Health-drift triage + deltas (baseline = metrics-latest.json @ 2026-06-04T13:05Z)

- **Security: 0/0 base tables.** RLS-off public base tables = 0; anon/authenticated write-grant-on-RLS-off base tables = 0 (with the mandatory `relkind IN ('r','p')` filter — without it ~49 views false-positive, all confirmed views). **SEC1-EXP resolved** (see §4).
- **`detect_stalled_pipelines()` = `[]`** (N1 self-recovered; MON1 fmv-recalc correctly not listed; the two new MON-WATCH rows correctly not listed).
- **Pipelines:** fmv-recalc 85/24h 0 fails. `topshot-moments-hydrator` 135/24h, 19 fails — 17 = R1 FK (all pre-14:47Z fix), 2 = catalog_gap (set-257/258 new-set lag, self-healing). All other fails are the known transient cron-rush class.
- **Sentinel TS-UUID-48h = 2611 → CRITICAL** (≥2000 floor). All 2611 inert (`set_id_onchain IS NULL`, trigger-held). Mint rate ~400–520/hr (last 1h 517, prev 414, 3h-ago bucket 278). **DUPE1, queued §3** — true positive, durable fix off-limits.
- **FMV (latest-per-edition):** TS — HIGH 556 / MED 2388 / **HIGH+MED 2944** / LOW 4832 / ASK_ONLY 999 / SALES_ONLY 10 / STALE 159 / NO_DATA 2010. AllDay — HIGH 82 / MED 413 / **HIGH+MED 495** / LOW 4606 / ASK_ONLY 119 / STALE 448 / NO_DATA 523. Big improvement vs baseline (TS 1062→2944, AllDay 267→495) from the dedup + FMV cluster. **NO_DATA 1243 (06:15Z) → 2010 now** = the DUPE1 inert re-mint creating NO_DATA-confidence rows, not a pricing regression.
- **`v_fmv_sanity_flags` = 0** (no impossible-price flags).
- **editions:** TS 11,498 (deduped from 16,355; re-climbing from DUPE1), AllDay 6191, Golazos 581, UFC 446.
- **DB size:** 5978 MB (baseline 5920; +58, normal growth + dedup churn).
- **unmapped_sales:** 209 total (baseline 214; flat).
- **Sentry:** 8 unresolved. 7 are a transient `POST /api/smoke-test` cluster (first seen 2–4h ago, last ~1h ago, no recurrence) tied to the 06:00Z cron rush + the 06:00–06:31Z deploy swaps + the temporary `audit_dq*` RLS-off window. **NEXTJS-1C** ("public base tables: RLS on + no anon write") is the smoke echo of SEC1-EXP — it failed while the `audit_dq*` tables were RLS-off and is now fixed. The two highest-signal assertions verified green now (detect_stalled=[]; security 0/0). **NEXTJS-1G** (share-OG) self-resolving. Recommend marking all resolved after 24h quiet (~07:00Z 06-06).
- **Artifacts:** 16 total; only `rpc-tracked-fmv-confidence` was broken (AF1) — **repaired via the view fix** (§3). Others monitor-validated healthy; not regenerated.

---

## 3. Shipped this run (2 — both subagent-verified PASS)

### AF1 — optimize `v_tracked_wallet_fmv_confidence` (fixes the broken `rpc-tracked-fmv-confidence` artifact)
- **Migration:** `audit_20260605_v_tracked_wallet_fmv_confidence_lateral`.
- **Problem:** the `latest` CTE joined ALL of partitioned `fmv_snapshots` (full history) to the held-edition set then sorted the whole thing for a `DISTINCT ON` → the view timed out (57014), so the artifact rendered "Error loading data: …statement timeout". No production route reads this view (grep-confirmed; internal analysis dashboard only).
- **Fix:** replaced the `latest` CTE with a per-held-edition `LEFT JOIN LATERAL (SELECT confidence FROM fmv_snapshots WHERE edition_id = h.edition_id ORDER BY computed_at DESC LIMIT 1)`. Semantically identical (latest snapshot per held edition_id; LEFT-join preserves the NO_SNAPSHOT bucket). Preserved `WITH (security_invoker = on)`; `CREATE OR REPLACE VIEW` preserved grants (postgres + service_role only, **no anon**).
- **Verification (subagent PASS):** query returns promptly, 20 rows across all 4 collections (TS HIGH 555 / MED 2391); `EXPLAIN` shows per-partition `Index Scan using fmv_snapshots_<yr>_edition_id_computed_at_idx` under a Nested Loop + Limit 1 (no Seq Scan + whole-table Sort); reloptions `security_invoker=on`, no anon/auth grants. The artifact's embedded query is unchanged and correct — it now works on open; **no `update_artifact` needed**.
- **Revert:**
```sql
CREATE OR REPLACE VIEW public.v_tracked_wallet_fmv_confidence WITH (security_invoker = on) AS
 WITH tracked AS (SELECT DISTINCT seeded_wallets.wallet_address FROM seeded_wallets WHERE seeded_wallets.is_active),
 held AS (SELECT DISTINCT e.id AS edition_id, e.collection_id FROM wallet_moments_cache wmc JOIN tracked t ON t.wallet_address = wmc.wallet_address JOIN editions e ON e.external_id::text = wmc.edition_key AND e.collection_id = wmc.collection_id),
 latest AS (SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.confidence FROM fmv_snapshots fs JOIN held h_1 ON h_1.edition_id = fs.edition_id ORDER BY fs.edition_id, fs.computed_at DESC)
 SELECT c.slug AS collection, COALESCE(l.confidence::text,'NO_SNAPSHOT') AS confidence, count(*)::integer AS held_editions FROM held h JOIN collections c ON c.id = h.collection_id LEFT JOIN latest l ON l.edition_id = h.edition_id GROUP BY c.slug, COALESCE(l.confidence::text,'NO_SNAPSHOT');
```
- **Target metric (re-check tomorrow):** the `rpc-tracked-fmv-confidence` artifact opens without a 57014 timeout; the view query returns < statement_timeout.

### MON-WATCH — watchlist `offers-sweep` + `allday-fmv-populate` @120m/medium
- **Migration:** `audit_20260605_watchlist_offers_sweep_and_allday_fmv` (idempotent INSERT … ON CONFLICT DO NOTHING).
- **Why:** closes the `detect_stalled_pipelines()` blind spot on two load-bearing writers (same class as MON1/Q10/P1). `offers-sweep` = the GQL `edition_offers.highest_offer` authority (TS Best-offer cell + `/insights/offer-spread`). `allday-fmv-populate` = primary AllDay FMV writer (`allday-gql-v1`); fmv-recalc Step 5b is only a partial backstop → `medium` not `high`. Neither was previously watchlisted (the existing `topshot-offers-indexer`/`allday-offers-indexer` rows are the distinct on-chain indexers).
- **Premise (verified 48h, mine + subagent):** offers-sweep 140 runs / 0 fails / **40m max gap**; allday-fmv-populate 136 / 0 / **40m** → 120m = ~3× margin (catches a multi-hour stall, no cron-rush false-positive — the Q9 lesson).
- **Verification (subagent PASS):** both rows present @120m/medium/active; `detect_stalled_pipelines()` = `[]` (neither newly listed); cadence sanity max_gap 40m, ran <3m ago.
- **Revert:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('offers-sweep','allday-fmv-populate');`
- **Target metric:** a future multi-hour stall of either surfaces in `detect_stalled_pipelines()` instead of being invisible; neither false-positives under normal cadence.

---

## 4. Reconciled as already-resolved (ledger lagged)

- **R1 (hydrator FK) — RESOLVED 06-04 14:47Z** by `audit_20260604_offers_moment_fk_on_delete_set_null` (the exact Option-A fix queued in the R1 entry: recreate `offers_moment_id_fkey` ON DELETE SET NULL). 0 FK violations since (last was 14:42Z). Moved to Resolved in ledger.
- **SEC1 / SEC1-EXP — RESOLVED 06-05 06:26Z** by `audit_20260605_harden_dq_scratch_tables_rls`. The 3 `audit_dq*` dedup scratch tables (`audit_dq1_dupe_map`, `audit_dq2_merge_map`, `audit_dq2_uuid_resolve`) now have RLS enabled; both security checks back to 0/0. No night-pass action needed. Moved to Resolved.

---

## 5. Queued — needs operator / Claude Code (NO-PUSH can't push code; off-limits can't auto-ship)

- **DUPE1 (NEW · LOW-MED data / MED ops-noise · operator/CC).** Inert TS UUID-dupe re-mint at ~400–520/hr; sentinel TS-UUID-48h = **2611 (CRITICAL, ≥2000)** and climbing. All rows inert (`set_id_onchain IS NULL`, kept inert by `editions_block_topshot_uuid_dupe_trg`) — **no canonical corruption, no outage; FMV/insights/analytics unaffected.** Costs: (a) sentinel CRITICAL alert noise (true positive — do NOT raise the threshold), (b) tonight's DQ1/DQ2 dedup drain is undone in real time. Durable fix is **route/worker code (off-limits + NO-PUSH):** `seed_topshot_editions` / `buildEditionKey` must prefer the on-chain int-pair over the UUID fallback when minting from `compute-topshot-pack-ev` (CLAUDE.md "Open/deferred" Item B2; full code-side fix in `docs/handoff-2026-05-30-overnight-pass.md`). No DB migration fixes the source; bulk-deleting the inert rows is destructive + a treadmill (off-limits). **Re-run a canonical-merge dedup only AFTER the writer fix lands, else it just re-treadmills.**
- **N1 (operator).** `snapshot-institutional-wallets` external cron — currently recovered (`detect_stalled` = []). Re-fire if it re-stalls; consider moving its 06:00Z slot off the cron-rush peak.
- **N2 (operator/CC).** Hydrator `v_moments_needing_hydration` candidate-read statement-timeout at cron rushes; do NOT revert the materialized-CTE fix; deeper fix = bump statement_timeout / add index / reduce view cost.
- **N3 (operator).** Payer wallet `0x73f55c4450b8d466` funding/cron-revival decision (storefront-cleanup driver deleted; monitoring slice already deactivated).
- **L1 (operator/CC).** `league-drift-detection` cron-wiring intent confirmation.
- **PIN1 (operator/CC).** `NEXTJS-15` pinnacle-listings-indexer counts `cadence_capped` deferrals toward the spike threshold — exclude them in the route capture logic.
- **Q2 (operator, watch).** `compute-laliga-pack-ev` cadence (by-design Golazos).
- **Q5 (operator/CC).** Smoke sales-lag threshold rebase to last-successful-run (folds into the transient smoke-cluster noise above).
- **Q6 (low).** evm Base-429 backoff — ingest piece shipped; watchlist piece resolved via P1.
- **Q7 (INFRA, Trevor).** Scheduled sandbox has no push creds + bot clone not mounted → DB + artifact + on-disk-docs only. **Confirmed again this run.** Durable fix = sandbox-native clone syncing via origin with GitHub creds.
- **Q8 (operator/CC).** badge-sync `onConflict:id` vs `UNIQUE(external_id,collection_id)` row-grain (moot for offers via `edition_offers`).
- **F1/F2-TierB (operator/CC).** Broader serial>circ mis-key batch + 65 residual Cosmic `8:62` Tier-B sales (need on-chain confirmation; F3 guard protects WAP).

---

## 6. Sentry housekeeping (operator, after 24h quiet)
Mark resolved if no recurrence: the `POST /api/smoke-test` cluster (NEXTJS-1E/1C/12/A/4/14/13 — transient deploy-swap + cron-rush + closed RLS-off window) and NEXTJS-1G (share-OG, culprit route deleted). All verified non-recurring as of ~08:1xZ.

---
*All outputs this run written to disk uncommitted (NO-PUSH). Lock released.*
