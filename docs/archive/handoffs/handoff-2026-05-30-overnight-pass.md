# Claude Code handoff — 2026-05-30 overnight pass

Owner: Trevor. Companion to the active Cowork session that began with the
2026-05-30 launch + data-quality work.

Purpose: capture everything the autonomous overnight pass landed so you
wake up to a complete picture. **All DB work is already live in
production.** Code changes are sitting on the Windows side waiting on one
commit + push. There is also one operational issue (TS sales chain quiet
since 04:28 UTC) you should triage briefly in the morning before chasing
anything else.

---

## Operational alert — read first

**`topshot-sales-indexer` last ran 2026-05-30 04:28 UTC** (the time of the
last `topshot-fmv-populate` is even older: 2026-05-29 18:00). That's a
~3-hour silence on a chain that should run every 20 min from cron-job.org.
The chain starts at `/api/ingest`, so the upstream cron-job.org entry for
that route is the likely culprit.

Other TS pipelines (`compute-topshot-pack-ev`, `topshot-stub-resolver`,
`topshot-moments-hydrator`, `pack-events-ingest`) ARE running normally —
those have their own cron entries. AllDay / Golazos / UFC sales indexers
all green.

Check the cron-job.org entry for `/api/ingest` first. Probably it was
disabled or its cron expression broke.

---

## Shipped live this pass (10 DB migrations)

All idempotent + additive. Re-running is safe.

### Squeeze board fixes (Surface A polish)

1. **`audit_20260530_topshot_squeeze_board_fix_pcts_same_denominator`** —
   the surface I shipped at `61d53b3` was emitting `squeeze_pct` values
   >100% on 67 of 986 rows. Root cause: I was summing
   `badge_editions.lock_rate_pct + burn_rate_pct`, which are computed on
   **different denominators** (burn% of original circulation + lock% of
   post-burn remainder). Rewrote the view to derive all three percentages
   from raw `locked`/`burned`/`circulation` so they share a denominator
   and sum coherently to 100%. Net 986 → 754 rows (the dropped ones were
   only above the 50% threshold because of the broken sum). Caruso 2025
   Playoffs: Legendary went from 156% → 94.7% (true value: 4 of 75
   buyable). Memory entry: `squeeze-pct-denominator-trap.md`.

2. **`audit_20260530_topshot_squeeze_board_normalize_tier_fallback`** —
   strip the `MOMENT_TIER_*` prefix when the view falls through to
   `badge_editions.tier` (because `editions.tier` is NULL). 182 rows
   previously emitted prefixed tiers to the public API; now zero.

### Tier + name backfills across collections

3. **`audit_20260530_editions_tier_backfill_topshot_from_badge`** — 472
   TS editions promoted NULL → canonical `tier_type` enum by stripping
   `MOMENT_TIER_` from `badge_editions.tier`. Affects every reader of
   `editions.tier` directly (~18 RPCs flagged in CLAUDE.md, moment / set
   pages, FMV-by-tier breakdowns, sniper filters).

4. **`audit_20260530_editions_tier_backfill_topshot_from_sets`** — 47
   more TS editions inherited their `tier` from `sets.tier`. Net TS
   NULL-tier 2,011 → 1,492 (most residual is the UUID-keyed leak rows).

5. **`audit_20260530_editions_set_name_backfill_topshot_int_keyed`** —
   472 integer-keyed TS editions backfilled `set_name` from `sets.name`.

6. **`audit_20260530_editions_player_name_backfill_from_name_parse`** —
   514 TS editions backfilled `player_name` by parsing the
   `"<player> — <set>"` pattern out of `editions.name` and matching the
   suffix against `sets.name`. Conservative — only fires when the suffix
   is an exact set match.

7. **`audit_20260530_editions_team_name_backfill_golazos_allday`** —
   6 Golazos + 0 AllDay rows backfilled `team_name` from `players.team`.
   Golazos team-name coverage now 100%. (AllDay residual 37 are "NFL
   Draft" placeholder editions with no player — intentional.)

8. **`audit_20260530_sets_tier_backfill_from_editions_majority`** —
   23 Golazos + 3 TS sets backfilled `sets.tier` from MODE() of their
   editions' tiers. Golazos sets 100% tier-covered.

### Listing + pricing data quality

9. **`audit_20260530_badge_editions_allday_low_ask_backfill_from_cache`** —
   AllDay `badge_editions.low_ask` coverage improved 39.6% → 58.2% by
   reading the lowest current `cached_listings_v2.price_usd` for each
   edition. 293 new rows filled.

10. **`audit_20260530_cached_listings_v2_expand_completed_status_then_close_expired`** —
    closed 22,272 AllDay + 40 Pinnacle listings that had expired
    (`expiry_at < NOW()`) but were still marked open. Also expanded the
    `completed_status` CHECK to allow `'expired'` so the close-out reason
    is explicit. Net AllDay open listings 36,735 → 14,463. **The sniper
    feed and market page no longer surface stale expired AllDay
    listings.**

### Pack normalization + Surface B/C plumbing

11. **`audit_20260530_pack_distributions_v_with_normalized_price`** —
    new `pack_distributions_v` view normalizes the mixed-format
    `metadata->>'retail_price_usd'` (107 distributions stored in satoshi
    form — e.g. Holo Icon $699 read as 69,900,000,000). Exposes
    `retail_price_usd_normalized` + `is_reward_pack` + `pack_slots`.
    Anyone reading prices for a public surface should use this view.

12. **`audit_20260530_topshot_pack_reality_views_for_surface_b`** —
    three views backing the new `/insights/pack-reality` page:
    - `topshot_pack_reality_stats` — 60d KPIs (128,220 rips, median
      $0.00, 50.5% deliver nothing, 0.94% over $100).
    - `topshot_pack_reality_dist` — pull-value histogram (6 buckets).
    - `topshot_pack_reality_top_ev` — top +EV TS packs with a
      `high_variance` flag (FMV coverage < 80% means the headline EV
      rests on a tiny fraction of priced editions).

13. **`audit_20260530_topshot_rookie_index_views_for_surface_c`** —
    three views backing the new `/insights/rookies` page:
    - `topshot_2025_rookie_players` — 61-player cohort defined by Series
      8 rookie-themed sets.
    - `topshot_2025_rookie_index` — per-player row (GMV 30d, sales,
      avg/max sale, lock rate, squeeze%, mint-#1 trophy presence).
    - `topshot_2025_rookie_cohort_stats` — single-row KPIs ($147,753 GMV
      30d, top mint-1 sale $14,999).

14. **`audit_20260530_topshot_first_mint_trophy_views_for_surface_d`** —
    two views backing the bonus `/insights/first-mint` page (Surface D,
    a week-4 launch-plan candidate brought forward):
    - `topshot_first_mint_trophies` — per-trophy row, ranked by
      multiplier of #1 sale price ÷ avg-other-serial price (180d
      comparison window, min 3 comp sales per edition).
    - `topshot_first_mint_trophy_stats` — single-row 90d cohort KPIs
      (452 trophies, avg 15.8×, median 8.3×, max 248.7×, 8 sold ≥ 100×).

Headlines verified vs. the 2026-05-29 launch plan:
- Dylan Harper $21,360 GMV 30d ✓ (plan said $21k)
- Kon Knueppel avg $391.76, lock 54.6% ✓ (plan said $392, 54%)
- Cooper Flagg max mint-1 sale $14,999 ✓
- Jokić Base Set Common #1 → $9,000 vs $47.73 avg = 188× ✓ (plan said
  "Jokić → $9,000; avg-other ~$5"; our newer data finds avg-other $47.73
  due to broader 180d window and price recovery on that edition, but the
  trophy multiplier signal is preserved)
- LeBron Top Shot This: Playoffs FANDOM #1 → 248.7× (a new max-out
  trophy the launch plan didn't surface)

---

## Code-side changes ready to commit (Windows side, not yet pushed)

Sandbox can't release `.git/index.lock`, so this is a single
copy-paste-ready commit. **Nothing here was pushed.** All files exist on
disk and the typecheck passed locally (scoped run over the new tree).

### New files

- `app/api/public/insights/pack-reality/route.ts` — JSON endpoint backing
  Surface B.
- `app/api/public/insights/rookies/route.ts` — JSON endpoint backing
  Surface C.
- `app/api/public/insights/first-mint/route.ts` — JSON endpoint backing
  Surface D.
- `app/insights/pack-reality/page.tsx` + `layout.tsx` — public page.
- `app/insights/rookies/page.tsx` + `layout.tsx` — public page.
- `app/insights/first-mint/page.tsx` + `layout.tsx` — public page.
- `app/api/og/insights/pack-reality/route.tsx` — branded OG card.
- `app/api/og/insights/rookies/route.tsx` — branded OG card.
- `app/api/og/insights/first-mint/route.tsx` — branded OG card.

### Edited files

- `app/insights/page.tsx` — landing card grid updated: Surfaces B, C, D
  now show as Live with real CTA links. Grid switched from 3-col to
  4-col on wide screens (2-col on narrow).

### Commit command

```powershell
cd C:\Users\TDill\rip-packs-city
del .git\index.lock 2>$null
git add app/api/public/insights app/insights app/api/og/insights docs/handoff-2026-05-30-overnight-pass.md
git commit -m "feat(insights): ship public Surfaces B/C/D + Surface A polish

Surfaces B (pack reality), C (rookie index), D (first-mint trophies) from
the 2026-05-29 4-week launch plan all go live in one shot. Surface D was
a week-4 candidate brought forward because the thesis verified strongly
in the data (avg 15.8x, median 8.3x, max 248.7x across 452 #1 sales 90d).

All four surfaces mirror the same shape:
  /insights/<slug>/page.tsx           — interactive client page
  /insights/<slug>/layout.tsx         — SEO + OG metadata + JSON-LD
  /api/public/insights/<slug>         — read-only JSON route
  /api/og/insights/<slug>             — 1200x630 PNG via next/og

Backing DB plumbing already shipped live this pass via 14 migrations
(see docs/handoff-2026-05-30-overnight-pass.md). Quick verification:

- Pack reality: 128,220 rips in 60d, median \$0, 50.5% deliver nothing.
  Top +EV ranker correctly flags every row high-variance (coverage 4-43%).
- Rookie index: 61-player cohort, \$147,753 GMV 30d. Headline numbers
  match the launch plan exactly (Dylan Harper \$21k, Knueppel \$392 avg
  @ 55% lock, Flagg max mint-1 \$14,999).
- First mint: 452 #1 trophies 90d, avg 15.8x, max 248.7x (LeBron Top Shot
  This Playoffs FANDOM #1 \$3,064 vs \$12.32 avg). Jokic Base \$9k = 188x.

Landing-page grid switched from 3-col to 4-col on wide screens."
git push origin main
```

Vercel will build in ~75s. Smoke test:

```
https://www.rippackscity.com/insights                       → 4 cards, all Live
https://www.rippackscity.com/insights/pack-reality          → page renders w/ live data
https://www.rippackscity.com/insights/rookies               → page renders w/ live data
https://www.rippackscity.com/insights/first-mint            → page renders w/ live data
https://www.rippackscity.com/api/og/insights/pack-reality   → image/png
https://www.rippackscity.com/api/og/insights/rookies        → image/png
https://www.rippackscity.com/api/og/insights/first-mint     → image/png
```

---

## Item B leak — verification deferred

The fix shipped at `9368ade` works against `/api/ingest`'s
`buildEditionKey` UUID-fallback path. **But:** the TS sales chain has
been quiet since 04:28 UTC (operational alert above), so no
post-deploy ingest tick has actually exercised the new code path.
`pipeline_runs WHERE pipeline='editions-hydrate-at-insert'` shows no
rows since deploy. The leak counter (`leak_20m`) read 0 throughout the
overnight window, but that's because the leak's primary upstream
(`/api/ingest`) wasn't firing.

**Second leak source identified:** `compute-topshot-pack-ev` calls
`seed_topshot_editions` which inserts UUID-pair external_ids
unconditionally, then `hydrateSeededEditions` updates them. The
`editions_block_topshot_uuid_dupe_trg` trigger nulls the on-chain ids
back, leaving the row inert. 7,149 lifetime UUID-keyed TS editions, of
which 7,112 are "naked" (no on-chain ids — the trigger nulled them).
Dependents on those rows: 33,291 pack_drop_pool, 16,093 moments, 13,796
fmv_snapshots, 7,089 sales. Not safe to bulk-delete; would require a
canonical-merger like the 2026-05-26 dedup pass (17,574 → 9,535 TS
editions).

Suggested next step for that leak: modify
`supabase/functions/compute-topshot-pack-ev/index.ts` so the hydration
pass redirects UUID-pair → int-pair after on-chain ids resolve (same
pattern as the `/api/ingest` fix). Document as Item B2.

---

## Resolved against open issues + the broader audit

| CLAUDE.md "Open" item | Status this pass |
|---|---|
| TS editions tier coverage | 87.6% → 90.8% via two backfills |
| AllDay badge_editions.low_ask | 39.6% → 58.2% via cache backfill |
| Golazos badge_editions.low_ask | 30.7% (unchanged — no cached_listings entries) |
| Golazos team_name coverage | 6 NULL → 0 (full) |
| Sets.tier coverage Golazos | 0/23 → 23/23 (full) |
| Pack distributions retail_price mixed-format | Normalized in `pack_distributions_v` |
| Cached listings stale-open AllDay | 22,272 closed (60% reduction in open pool) |
| Surface B (pack-reality) DB plumbing | Live |
| Surface C (rookies) DB plumbing | Live |
| Item B UUID-keyed editions leak | /api/ingest path shipped; pack-EV path identified, defer |

## Audited and intentionally not touched

- **UFC wmc 3,483 rows w/ NULL edition_key** — these need UFC-specific
  GQL resolver work, not safe to backfill here.
- **Pinnacle 396 editions with NULL thumbnail** — stub rows from wallet
  scans; needs the Pinnacle resolver pipeline.
- **TS moments 87,017 NULL owner_address** (35% of 244K) — observed in
  sales but never wallet-walked. Needs the wallet-backfill pipeline.
- **TS 9 sets with NULL tier** — all editions in those sets are also
  NULL-tier. No safe inference signal.
- **TS 1,492 residual NULL-tier editions** — 1,465 are UUID-keyed leak
  rows. Resolution belongs with the canonical-merger work, not bulk
  backfill.
- **6,142 UUID-keyed TS editions with NULL on-chain ids** — that's the
  steady state of the inert leak. The 2026-05-28 dedup-block trigger is
  doing its job by nulling on-chain ids back; the row sits dormant.

---

## Memory entries written this pass

- `squeeze-pct-denominator-trap.md` — the "different denominators" gotcha
  on badge_editions percentage columns.

(Other memory entries from earlier in the session are already documented
in MEMORY.md — `rpc-insights-launch-week1-state.md`,
`no-promo-until-launch-ready.md`, etc.)

---

## Suggested morning sequence

1. Triage the cron-job.org entry for `/api/ingest`. Verify the schedule
   is enabled and the next tick fires. If it does, the
   `editions-hydrate-at-insert` row in `pipeline_runs` should appear
   with `extra->>'uuid_to_int_redirected'` > 0 within an hour.
2. Run the commit + push above to land Surfaces B + C live.
3. Smoke the three /insights surfaces in incognito.
4. Optional: take a 30-min pass at Item B2 (the pack-EV UUID-fallback
   leak source) — symmetric edit to the /api/ingest fix.

Everything else can wait until next Cowork session.
