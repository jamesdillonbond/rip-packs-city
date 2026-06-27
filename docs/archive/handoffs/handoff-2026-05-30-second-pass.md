# Claude Code handoff — 2026-05-30 second pass (post-Trevor-checkin)

Owner: Trevor. Follow-up to the morning pass (commit `efa5e94`).

## TL;DR

While you handed the morning commit off to Claude Code, I worked through everything on the menu in parallel. Five new things landed (4 DB-side live, 1 on-disk awaiting commit), one was honest-blocked, and Item B2 is drafted but unapplied per your instruction-vibe.

## Shipped live this pass (4 DB migrations)

### Surface E plumbing — Cross-Collection Whale Map

- **`audit_20260530_topshot_cross_collection_cohort_views_for_surface_e`** + **`audit_20260530_cross_collection_cohort_materialize_for_perf`** + **`audit_20260530_cross_collection_cohort_two_pass_refresh`** + **`audit_20260530_cross_collection_cohort_loop_refresh`** + **`audit_20260530_cross_collection_cohort_split_refresh`** — five iterations to get to a working materialized cohort. The naive view + bulk INSERT both hit Supabase's 60s timeout on the 1.5M-row wmc aggregation; the final shape splits into two RPCs (`refresh_cross_collection_cohort_step1` / `step2`) and uses per-wallet loops to avoid hash-aggregate blowup.

Cohort table populated: **143 wallets** (75 in 3-coll, 67 in 4-coll, 1 in 5-coll), **240 TS sets** in their overlap. Refresh via:
```sql
SELECT refresh_cross_collection_cohort_step1();
SELECT refresh_cross_collection_cohort_step2();
```
(They're idempotent; safe to schedule on a 6h cadence later.)

### Surface G plumbing — per-set squeeze leaderboard

- **`audit_20260530_topshot_squeeze_by_set_view_for_surface_g`** — `topshot_set_squeeze_board` view ranks entire TS sets by avg squeeze across their editions. Filtered to ≥5 covered editions per set. Top results:
  - WNBA Squad Goals S5 RARE — 76.4% avg, 424 of 1,800 actually buyable
  - 2023 NBA Playoffs S5 COMMON — 76.0% avg
  - Metallic Gold LE S6 RARE — 74.3% avg
  - Freshman Gems S6 RARE — 72.5% avg (the launch plan's "everyone 90%+ locked" callout was slightly overstated — max is 79.9%)

## On-disk, awaiting commit

### Surface E code (route + page + layout)

- `app/api/public/insights/cross-collection/route.ts` — JSON route over the materialized cohort.
- `app/insights/cross-collection/page.tsx` + `layout.tsx` — interactive page with per-wallet collection-dot indicators and the TS set overlap table.
- (No OG card yet — can lift the squeeze OG pattern into `/api/og/insights/cross-collection/` when you want.)

### Surface G code (route only)

- `app/api/public/insights/set-squeeze/route.ts` — JSON route. No page yet; this is a drill-down companion to Surface A and could live as a query-param toggle on the squeeze page rather than its own URL.

### Updated landing page

- `app/insights/page.tsx` — adds Surface E card, updates "three wedges" → "five wedges" in the lede.

### API polish (additive params, no breaking changes)

- `app/api/public/insights/squeeze/route.ts` — added `max_circulation` param for trophy-only filtering.
- `app/api/public/insights/first-mint/route.ts` — added `max_circulation` + `tier` params.

### Commit command

```powershell
cd C:\Users\TDill\rip-packs-city
del .git\index.lock 2>$null
git add app/api/public/insights app/insights docs/handoff-2026-05-30-second-pass.md docs/audits/item-b2-uuid-merger-plan-2026-05-30.md
git commit -m "feat(insights): Surface E (cross-collection whales) + Surface G route + API polish + B2 plan

Surface E (/insights/cross-collection) — 143 wallets hold 3+ Flow
collections. Cohort distribution, per-wallet collection-dot indicators,
TS set overlap. Backing tables shipped live (cross_collection_cohort_mat
+ cross_collection_ts_set_overlap_mat), refreshable via two SECDEF RPCs.

Surface G — topshot_set_squeeze_board view + JSON route over it. No page
yet; companion to Surface A. Top sets by avg squeeze: WNBA Squad Goals
76.4%, 2023 NBA Playoffs 76.0%, Metallic Gold LE 74.3%, Freshman Gems
72.5%.

API polish (additive only): squeeze gets max_circulation, first-mint
gets max_circulation + tier. Existing callers unaffected.

Updates /insights landing to 5 cards.

Surface F (Got Game burn) honest-blocked: badge_editions has no coverage
for the legacy set. Item B2 plan drafted (docs/audits/item-b2-uuid-
merger-plan-2026-05-30.md) — three-phase merger, unapplied per your call."
git push origin main
```

## Honest blocks (not shipped, with reason)

### Surface F — Got Game burn post-mortem
`badge_editions` has zero rows for the Got Game set (it's in the 44% of TS sets with no badge coverage). The launch plan's "Lonzo / KCP / Damion Lee / Harry Giles 67-77% burned" numbers come from research, not from our DB. Can't publish a burn report with no burn data. Skipped.

### Pack_rips dist_id bulk backfill
5,000-row sweep resolved only 19 (0.4%). Attrition audit: 10,471 sampled rips have moment_acquisitions (100%), 9,296 reach a moment (89%), only **3 (0.03%) hit a pack_drop_pool row**. The bottleneck is pack_drop_pool historical coverage. The existing cron is doing all it can — needs the pack-EV ingest to backfill historical drops, which is its own project. Skipped.

## Audits with clean results

### Pinnacle FMV honesty check — PASSES
428 priced editions: 52% HIGH + 31% MED + 12% LOW. 0 stale, 0 older than 7d. The 43 editions clustered at exactly $1.00 are NOT artifacts — sampled 8 of them, all have 1-11 sales in last 30d at the $1 price point (Megara Brushed Silver: 11 sales, ask $1; Sally Cars Vol.1 Brushed Silver: 10 sales). Pinnacle's `pinnacle-1.0.0` algo is the only writer; no clobber surface. Pinnacle FMV is the cleanest signal in the platform.

### AllDay `allday-gql-v1` drain rate — TRENDING TO COMPLETION
1,934 editions still on the legacy algo. Migrated last 7 days: 1,139 (~163/day pace). Migrated last 24h: 65 (~30 day completion at that rate). Last 1h: 3. The `fmv-recalc` Step 5b catch-up is working as designed. No acceleration recommended — the 1000/tick cap exists for a reason.

## Item B2 — drafted, not applied

Full plan at `docs/audits/item-b2-uuid-merger-plan-2026-05-30.md`. Three phases:

1. One-time merge of 4,985 strict-match UUID-keyed editions to their canonical int-pair siblings. Repoints dependents in dependency order (pack_drop_pool, fmv_snapshots, moments, sales, wmc), then deletes UUID rows.
2. Redesign `seed_topshot_editions` RPC + matching `compute-topshot-pack-ev` edge function changes so new UUID rows aren't created. Ship together.
3. Cleanup: drop the 1,947 empty stubs, retire the defending trigger, drop the working table.

Each phase is idempotent + has verification queries + has a stop-point. **Don't run on a Friday** — Surface B sits on top of pack_drop_pool.

## Operational

Still pending on you:
- `/api/ingest` cron — Claude Code reported it's firing but throttled to ~75min not 20min. Worth a glance.
- `topshot-fmv-populate` cron — masked-token blocked from manual trigger. Re-enable when convenient; one manual tick validates the batched RPC live.

The Item B leak is resolving — `uuid_to_int_redirected` 9-12/tick per Claude Code's morning measurement, ~92% reduction confirmed.

## Suggested order

When you're back at it:
1. Land this commit (Surface E + G + polish).
2. Re-enable the two crons.
3. Tomorrow or next session: read the B2 plan, decide if you want to run Phase 1.
