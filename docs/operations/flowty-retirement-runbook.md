# Flowty retirement — pre-staged runbook

**Status: PRE-STAGED, NOT EXECUTED.** Flowty (Trevor, 09-25) will turn its API off "soon". Nothing priced depends on it any more (roadmap-status.md, Prioritized next actions §1, re-verified 10-03). This file is the whole teardown, ready to run in one pass on the day the lanes prove it is dark. Inventory read **2026-10-18 ~9:15 AM PT** (Claude Code cloud). Every count below is a dated sample, so re-derive it before acting.

Roadmap item: [sniper-and-deals.md](../strategy/features/sniper-and-deals.md) Now 1.

---

## 0. Is it dark? (run this first, every time)

Read 10-18 ~9:15 AM PT: **ALIVE ×3.** All three lanes ran 72 of 72 ok in 24 h, `page_errors` max 0, ≥ 100 rows written per run.

```sql
with r as (select pipeline, started_at,
  coalesce((extra->>'total_fetched')::int,0) fetched,
  coalesce((extra->>'page_errors')::int,0) page_errors,
  coalesce(error,'') ilike 'upstream returned an empty book%' empty_book,
  row_number() over (partition by pipeline order by started_at desc) rn
 from pipeline_runs where pipeline in ('topshot-listing-cache','allday-listing-cache','golazos-listing-cache')
  and started_at > now()-interval '6 hours')
select pipeline, max(started_at) last_tick,
 count(*) filter (where rn<=3 and fetched=0 and (page_errors>0 or empty_book)) last3_dark,
 count(*) filter (where fetched=0) zero_ticks_6h, count(*) ticks_6h,
 case when count(*) filter (where rn<=3 and fetched=0 and (page_errors>0 or empty_book))=3 then 'DARK'
      when count(*) filter (where fetched=0 or page_errors>0)>0 then 'FLAKY' else 'ALIVE' end verdict
from r group by 1;
```

- **Call it dark only when all three lanes read `DARK`**, which takes three consecutive ticks each. Use the lanes' own record, never one manual probe.
- Fields: `extra.total_fetched`, `page_errors`, `pages_fetched`, `sweep_complete`, `purge_skipped`, `written`.
  - Empty book: `error` starts "upstream returned an empty book" (`lib/pipeline/empty-book.ts`).
  - Non-2xx: counts into `page_errors` with error "sweep incomplete: N page fetch error(s)…".
- ⚠ **A hang to the 300 s `maxDuration` kill leaves only a `<lane>-heartbeat` row, with no terminal row.** It reads as silence, not as a failure. Also run `npm run pipelines:kills`.

## 1. The surface

**The three live lanes:**

| lane | route | scheduler | watchlist (`pipeline_cadence_watchlist`) |
|---|---|---|---|
| Top Shot | `app/api/topshot-listing-cache/route.ts` | `vercel.json` cron `15,35,55 * * * *` (the `.github/workflows/topshot-listing-cache.yml` is **dispatch-only**, not a scheduler) | `topshot-listing-cache` |
| All Day | `app/api/allday-listing-cache/route.ts` | cron-job.org "RPC All Day Listing Cache" `14,34,54` (`cron-schedule.md`) | `allday-listing-cache` |
| Golazos | `app/api/golazos-listing-cache/route.ts` | cron-job.org "RPC Golazos Listing Cache" `6,26,46` | `golazos-listing-cache` |

None has a pg_cron job. The `failure_rate` arm of `get_pipeline_alerts_core` also keys on these names, so a dark Flowty pages through both the watchlist and that arm.

**Two dormant Flowty lanes (0 runs in the ~73 h `pipeline_runs` window):**
- `app/api/listing-cache/route.ts` (logs `*-listing-cache-v2`). It is reached only by `fireNextPipelineStep("/api/listing-cache", chain)` in `app/api/fmv-recalc/route.ts` (3 call sites), and only with `?chain=true`.
- `app/api/ufc-listing-cache/route.ts`. Chained from `app/api/ufc-pipeline/route.ts`, whose cron-job.org job 7485721 is disabled. Its slot in `app/api/admin/pipeline-health/route.ts` goes with it.

**`flowty-proxy`** is a Supabase edge function, `supabase/functions/flowty-proxy/index.ts`. It has no Cloudflare worker. Callers and references:
- the four routes above (`FLOWTY_PROXY_URL` / `FLOWTY_PROXY_TOKEN`)
- `supabase/functions/_tests/harness.ts`
- `__tests__/edge-fn-drift-checker.test.ts`
- a comment in `.github/workflows/edge-fn-drift.yml`
- `.github/workflows/ci.yml` (`FLOWTY_PROXY_TOKEN: ci-placeholder`)
- the Vercel env var and its own edge secret

Already inert: `app/api/edition-floor/route.ts` `fetchFlowtyFloor` (returns null) and the Pinnacle sniper's Flowty leg (`lib/pinnacle/flowty.ts`, `pinnacleFlowty.ts`).

**Data, read 10-18:**
- `cached_listings` `source='flowty'`: Top Shot 100 · All Day 108 · Golazos 100. Each lane rewrites its book every tick.
- `cached_listings_v2` `source='flowty'`: 1,431 All Day rows, 8 still open, newest 2026-05-23. Its writer `sync_flowty_listings_to_v2` has no cron job.
- Frozen, nothing writes them: `flowty_transactions` 7,734 (last 05-23) · `flowty_loans` 5,325 · `flowty_loan_events` 13,885 (last 05-11).
- `flowty_archive.*` holds chain-verification data; its workflows read the chain, not the API. **Keep all of it.**
- The 48 h purge is `app/api/cron/purge-stale-listings/route.ts` (vercel `0 4 * * *` UTC). It deletes every `cached_listings` row older than 48 h, regardless of source. **Keep it.**

## 2. Readers that go EMPTY for All Day / Golazos when the Flowty rows go

All Day and Golazos v1 `cached_listings` rows are 100 % Flowty. Top Shot keeps its ~24k Atlas-fed `source='topshot'` rows.

| reader | effect on the day | replacement |
|---|---|---|
| `get_platform_stats` (DB) | All Day / Golazos listings → **0, a fabricated zero** | open `cached_listings_v2` rows |
| `get_cross_collection_deals` (DB; `/api/cross-collection-deals`, `send-digest`) | All Day / Golazos deals vanish | v2 book |
| `app/api/allday-pack-listings/route.ts` | empty | v2 |
| `app/api/market/route.ts` (v1 leg), `app/api/profile/market-pulse/route.ts`, `app/api/support-chat/route.ts` (3 sites), `app/api/support-chat/context/route.ts` (2) | empty for All Day / Golazos | v2 |
| `app/api/golazos-sniper-feed/route.ts` (reads `source='flowty'` explicitly; no in-app caller) | empty | **delete** |

**Triage of the table (re-read 10-18 ~9:35 AM PT):**
- `get_platform_stats` has **no in-repo caller**: only `app/api/platform-stats/route.ts`, which nothing in the repo fetches (an external caller can't be ruled out from a sandbox). It **already understates today**: `listing_count` reads All Day **108**, Golazos **100**, which is Flowty's v1 book. The verified-open `cached_listings_v2` storefront book is All Day ~15,236 (`direct_v2` 10,936 + `storefront_v2` 4,300, `verified_at` < 6 h) and Golazos 4,286. Its Top Shot and Pinnacle arms count EDITIONS with a live ask, not listings. A repoint should count `DISTINCT edition_id` over verified-open v2 rows, so all collections mean the same thing.
- `get_collection_stats(p_slug)` (the collection overview's RPC) also returns `listing_count` from v1 — Golazos **100** on 10-18 — but no component renders `listing_count` (typed only in `CollectionOverviewClient.tsx`). Its overview deals read `allday_edition_floor_ask` for All Day; Golazos falls to the generic branch, which has no HIGH/MEDIUM editions, so its list is already honestly empty.
- `app/api/market/route.ts` reads v1 only as a FALLBACK when its modern path returns 0 rows, so on the day it falls back to an honest empty book, not to a stale one.
- `get_cross_collection_deals` is read by `/api/cross-collection-deals` (only `lib/insights/mv-freshness.ts` names it in-repo) and by `send-digest`. Digests are off (C2), so the user-facing loss is small.

Already on the replacement: the All Day market (`get_allday_market_*`, v2 with `source <> 'flowty'`) and the Golazos ask (`refresh_golazos_ask_fmv_from_listings`).

Other DB readers of v1 to check once: `analytics_listings_summary`, `get_relative_deals`, `get_tier_pricing_benchmarks`, `get_collection_stats`, `search_catalog_all`, `mcp_find_set_completion`, `collection_readiness`, `fmv_from_cached_listings` (≤ 2 h bound, safe), `update_badge_low_ask_from_cached_listings` (no caller).

## 3. Teardown, in order (revert in brackets)

0. **Can ship before the day.** Point the §2 readers at `cached_listings_v2` for All Day and Golazos, so the day changes nothing a user sees. ✅ **Scope DECIDED 10-18 ~12:35 PM PT (Claude Code cloud, under Trevor's "make decisions"):** step 0 is the readers a user sees: the concierge's v1 reads (`app/api/support-chat/route.ts` ×3, `support-chat/context/route.ts` ×2), `app/api/profile/market-pulse/route.ts` and `app/api/allday-pack-listings/route.ts`. `get_platform_stats` and `get_collection_stats` drop out of step 0, because no rendered surface reads their `listing_count` (triage above); they move with step 3. Left for a dedicated pass rather than an end-of-block rush: v1 and v2 differ in shape, and the shutdown date is still open. [revert: `CREATE OR REPLACE` from each function's prior migration body; revert the code commit by its message] **Progress 10-18 ~1:57 PM PT (Claude Code cloud):** ✅ `search_across_collections` now reads All Day / Golazos from the edition floor views (`lib/concierge/search-edition-floors.ts`), and UFC answers market-closed. **Re-scoped by caller census:** `support-chat/context/route.ts` ×2 sit behind `includeMarketStatus=true`, which NO caller passes, and `app/api/profile/market-pulse` has NO in-app caller — both unreachable, so not step 0. `allday-pack-listings` writes `pack_listings_cache`, whose only reader is the admin `data_coverage_dashboard` view — not user-facing, so it moves to step 3. **Remaining in step 0:** `search_catalog_deals` and the `search_live_deals` fallback (`support-chat/route.ts`), both still v1 for All Day/Golazos. ✅ **~2:10 PM PT:** `search_catalog_deals` done — All Day reads `get_allday_market_editions_v3`, Golazos reads the new `get_golazos_catalog_deals` (`20261018205915`), both scoped to the resolved person's labels. ✅ **~2:17 PM PT: step 0 COMPLETE** — the `search_live_deals` v1 fallback reads the same index (below-FMV rows only). No user-reachable reader of v1 `cached_listings` remains for All Day / Golazos; the unreachable ones (context route behind `includeMarketStatus`, `/api/profile/market-pulse`) and `allday-pack-listings` (admin-only reader) go with step 3.
1. **Schedulers.**
   - Remove the `topshot-listing-cache` entry from `vercel.json`.
   - Delete `.github/workflows/topshot-listing-cache.yml` (dispatch-only).
   - **Disable**, don't delete, the two cron-job.org jobs. Use the Common tab only (rpc-cron-ops). Confirm "Inactive" on the jobs LIST page, and update `docs/operations/cron-schedule.md` in the same pass.

   [revert: restore the entry and the workflow; re-enable the console rows]
2. **Code (one commit, ledger committed FIRST so the code commit is the tip).**
   - Delete the five listing-cache routes, `golazos-sniper-feed`, and `ufc-pipeline`.
   - Delete the three `fmv-recalc` chain calls to `/api/listing-cache` and the `pipeline-health` UFC slot.
   - Remove `FLOWTY_PROXY_TOKEN` from `ci.yml` and the harness entry.
   - Tests:
     - delete `api-{topshot,allday,golazos}-listing-cache(-deep)`, `api-listing-cache(-deep)`, `api-ufc-listing-cache(-deep)`, `api-golazos-sniper-feed(-deep)` and `api-ufc-pipeline`
     - re-pin `edge-fn-drift-checker`, `api-fmv-recalc-deep-loop` (it asserts the chain), `after-route-heartbeat-ratchet`, `heartbeat-marker-precedes-the-terminal-row`, `unbounded-fetch-in-after-routes-ratchet`, `anon-public-pages-do-not-307-their-own-feed` and `invariants-postgrest-cap`
     - check the fixtures in `api-smoke-test-*`, `api-support-chat-tools-populated`, `sniper-helpers`, `component-SniperClient`, `component-SupportChat`, `component-ErrorTriageClient`, `helpers/delete-recorder.ts` and `api-cron-purge-stale-listings`
   - Run `npm run preflight`; a red `lint:ratchet` or tree-walk guard is likely on the first pass.

   [revert: `git revert` the commit by its message]
3. **Watchlist.**
   `UPDATE pipeline_cadence_watchlist SET is_active=false, notes=coalesce(notes,'')||' [RETIRED <date>: Flowty API dark]' WHERE pipeline IN ('topshot-listing-cache','allday-listing-cache','golazos-listing-cache');`
   [revert: `SET is_active=true` for the same three]
4. **Data (deliberate, with a backup).** Take counts first (expect about 100 / 108 / 100 by collection):
   `CREATE TABLE audit_<date>_flowty_cached_listings_backup AS SELECT * FROM cached_listings WHERE source='flowty';`
   then `DELETE FROM cached_listings WHERE source='flowty';`.
   Optionally, after a backup the same way, `DELETE FROM cached_listings_v2 WHERE source='flowty' AND completed_at IS NULL;` (8 rows).
   [revert: `INSERT INTO cached_listings SELECT * FROM audit_<date>_flowty_cached_listings_backup;`]
5. **Edge function.**
   - Retire `flowty-proxy`: deploy the house 410-stub (`verify_jwt:true`), or delete the function.
   - Remove its directory and its drift-checker entry.
   - Unset the Vercel env var `FLOWTY_PROXY_TOKEN` and the edge secret.

   [revert: restore the directory, then dispatch `edge-fn-deploy.yml` with `function=flowty-proxy`]
6. **Optional, a product decision.** Drop the frozen `flowty_transactions`, `flowty_loans` and `flowty_loan_events`. They are historical data, not API-fed. Leave `sync_flowty_listings_to_v2` and `update_badge_low_ask_from_cached_listings`, or drop them as functions with no caller.
   - ↳ **Dead Flowty-era objects found 10-18 ~2:27 PM PT (Claude Code cloud; caller census: app, lib, scripts, GHA, `supabase/functions`, `cron.job`, `pg_proc` bodies, pgss).** `cart_eligible_listings` is a view over `cached_listings WHERE source = 'flowty'` (the removed cart's book); its only reader, `build_deal_alerts_for_subscriber`, has NO caller (the live alerts are `dispatch_due_deal_alerts` → `cross_collection_deals_board` / `edition_current_ask`, neither touching v1 or Flowty). `get_cross_collection_deals` (v1) is called only by `/api/cross-collection-deals`, which nothing in the app fetches, and by `send-digest`, which nothing schedules (digests blocked on C2); pgss shows 0 calls. All three can be dropped with step 2 or left; none affects a user on the day.

**Exit:** none of the three lanes is scheduled; the watchlist reads them inactive; `cached_listings` holds 0 `source='flowty'` rows; every §2 reader renders All Day and Golazos from v2 (rendered DOM, not HTTP 200); `edge-fn-drift` is green. **Falsifier:** a `*-listing-cache` row in `pipeline_runs` after the day, or an All Day / Golazos listings count of 0 on any surface.
