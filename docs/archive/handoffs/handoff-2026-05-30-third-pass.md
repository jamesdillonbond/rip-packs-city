# Claude Code handoff — 2026-05-30 third pass

Owner: Trevor. Follow-up to the second-pass handoff. Picks up after your
`5b2f62f` morning ship (Surfaces B/C/D + first-mint OG + landing fix).

## TL;DR

DB-side: 5 new live migrations (Pinnacle scarcity view, wallet-squeeze-
exposure RPC, TC report RPC, expired-listings recurring RPC + sweep,
B2 readiness gate validation). Two Cowork artifacts updated in place
(`rpc-live-health` leak commentary post-Item B, `rpc-cross-collection`
swapped to use the materialized cohort tables).

Code-side: 4 new files awaiting your PowerShell commit — `/insights/
squeeze-check` page + JSON route (the "paste your wallet, see what's
liquid" tool, Week 2 launch-plan item) and two more public JSON routes
(`/api/public/insights/pinnacle-scarcity`, `/api/public/insights/
tc-report`). The squeeze-check page is on the landing index as "Tool ·
Live"; Pinnacle scarcity and TC report are data routes only for now.

## Shipped live this pass (5 DB migrations)

### 1. Pinnacle scarcity board — Surface H plumbing

- **`audit_20260530_pinnacle_scarcity_board_view_for_surface_h`** — new
  `pinnacle_scarcity_board` view scoped to Pinnacle. Pinnacle doesn't
  have TS's lock+burn mechanic; scarcity comes from low mint counts
  within a variant family, chaser status, and premium-variant +
  low-mint combinations. View exposes `scarcity_vs_variant_pct` (how
  far below the variant's average mint the edition sits), joined to
  latest `pinnacle_fmv_snapshots`. Top results: Lumière Beauty and
  the Beast Vol.2 Standard 333-mint (70.6% rarer than Standard avg),
  Fear Inside Out Vol.1 Standard 333-mint (70.6%), Sulley Pixar Fuzzy
  Party Standard 400-mint (64.7%). Filters out `set_name='Unknown'`
  stubs from the wallet-scan backfill.

### 2. Wallet squeeze exposure RPC — concierge / public tool

- **`audit_20260530_wallet_squeeze_exposure_rpc_for_concierge`** +
  **`audit_20260530_wallet_squeeze_exposure_rpc_no_temp_table`** —
  `get_wallet_squeeze_exposure(p_wallet text)` returns the wallet's
  TS holdings bucketed by squeeze % (liquid <25 / moderate 25-50 /
  squeezed 50-75 / extreme ≥75), moments-weighted, plus the top 10
  most-squeezed editions held. CTE-based, STABLE, anon-callable.
  Trevor's wallet validates clean: 92% liquid (13,113 of 14,274
  moments under 25% squeeze), top extreme Tatum Video Game Numbers
  RARE 98.6%.

### 3. Per-wallet TC report RPC — Week 3 outreach workflow

- **`audit_20260530_get_wallet_tc_report_rpc`** —
  `get_wallet_tc_report(p_wallet text)` returns a composite jsonb:
  cross-collection rollup (moments + editions + approx FMV per
  collection), composed-from-squeeze-exposure squeeze section, 2025
  rookie cohort coverage (X of 61 owned + best holding), WNBA Series 7
  set coverage with completion %, top-5 most-held TS sets with
  completion %, and recent 90d acquisitions. Validated against your
  wallet: 59 of 61 2025 rookies owned (best holding: Caleb Love
  Freshman Gems RARE #1), 2025 WNBA Playoffs at 97.1% completion
  (34/35), $96k aggregate FMV across all 5 collections.

  Caveat: the `recent_acquisitions` section returns empty for most TS
  wallets because `sales.buyer_address` is widely NULL on TS V1 sales.
  That's the long-tail issue #1 in CLAUDE.md ("Most TS sales have NULL
  buyer_address. The same fetchTxBuyers pattern AllDay uses needs to
  be applied to TS V1 sales"). The section is wired but inert until
  that's fixed.

### 4. Expired listing close-out recurring RPC

- **`audit_20260530_cached_listings_v2_close_expired_recurring_rpc`** —
  the morning's one-shot expired-listing close-out had already accrued
  126 new AllDay rows by 14:48 UTC. Packaged the close-out as
  `close_expired_cached_listings()` SECDEF RPC so a daily cron can
  keep it tidy. Re-ran inside the migration to clear the residual.
  Add to cron-job.org at any cadence — RPC is idempotent and reports
  a `closed` count for monitoring.

### 5. B2 readiness gate (added to plan doc, not applied)

The Item B2 plan doc now includes a single read-only validation query
at the top — run it as the first step of any sit-down B2 session and
it will tell you whether `safe_to_merge` is still ≈4,976 (or whether
upstream changes have shifted the surface). Verified live: cohort
unchanged since dry-run (7,233 / 1,947 / 4,976 / 2 / 210, all matching).

## Cowork artifacts updated this pass (2)

### `rpc-live-health`

The edition-writer-leak commentary was stale — it claimed "the GQL
writer at `app/api/ingest/route.ts` is still hitting the UUID fallback"
and used a >1,000/48h threshold to color the pill bad. After Item B
shipped, that's wrong. Rewrote: shows both 24h + 48h counts now,
rebased thresholds to the post-fix steady state (<500/48h = good,
<2000 = warn for normal residual, else bad regression), and the
explanation references the Item B2 plan doc by path. RPC brand block
preserved.

### `rpc-cross-collection`

Set-overlap section was scanning wmc × editions on every refresh
(1.5M+ row inline aggregation). Swapped to read the materialized
`cross_collection_cohort_mat` + `cross_collection_ts_set_overlap_mat`
tables shipped second pass. Same on-screen result, snappy + reliable.
Per-wallet "Present in" dots now compute from the per-collection
moment columns rather than a separate `array_agg`. Footer updated
with the refresh RPC commands.

### Artifacts NOT touched (clean)

`rpc-fmv-watch`, `rpc-my-wallet`, `rpc-trophy-ladder`,
`rpc-deploys-and-cost` all reviewed — no dropped views referenced,
brand styling consistent, commentary still accurate. The two older
artifacts (`rpc-platform-tracker` 5/24 and `rpc-platform-health`
5/23) were flagged as superseded and you deleted them.

## On-disk, awaiting commit

### Public surfaces

- **`app/api/public/insights/squeeze-check/route.ts`** — JSON route over
  the new RPC.
- **`app/insights/squeeze-check/page.tsx`** + **`layout.tsx`** — the
  "paste your wallet, see what's actually liquid" page. Buckets bar
  row, top-10 squeezed table, methodology block, share button.
- **`app/insights/page.tsx`** — landing card grid gets a 6th card,
  "Tool · Live": squeeze-check. Lede updated to "five wedges" (still
  accurate; the tool sits outside the wedge framing).
- **`app/api/public/insights/pinnacle-scarcity/route.ts`** — JSON route
  over the new Pinnacle view. No page yet; this is data plumbing for
  a future Surface H page when you want it.
- **`app/api/public/insights/tc-report/route.ts`** — JSON route over
  the TC report RPC. **Intentionally not on the landing index** — this
  is an internal tool you'll use to write personalized TC DMs, not a
  public-facing surface that should compete with the wedge content.
- **`docs/handoff-2026-05-30-third-pass.md`** — this doc.
- **`docs/audits/item-b2-uuid-merger-plan-2026-05-30.md`** — updated
  with the readiness gate at the top of the plan.

### Commit command

```powershell
cd C:\Users\TDill\rip-packs-city
del .git\index.lock 2>$null
git add app/api/public/insights app/insights docs/handoff-2026-05-30-third-pass.md docs/audits/item-b2-uuid-merger-plan-2026-05-30.md
git commit -m "feat(insights): ship /insights/squeeze-check + Pinnacle scarcity + TC report routes

Three new surfaces, all backed by RPCs + views shipped live to Supabase
during the third pass:

- /insights/squeeze-check ('paste your wallet, see what's liquid') is
  the Week 2 launch-plan concierge demo as a standalone tool. Anyone
  can paste a Flow address (no signup — same trust model as nbatopshot
  .com/profile/<addr>). Buckets bar row + top-10 squeezed table + the
  liquid-vs-extreme one-line summary.
- /api/public/insights/pinnacle-scarcity — data route over a new
  pinnacle_scarcity_board view. Pinnacle equivalent of the squeeze
  board (mint_count + variant family + chaser status, since Pinnacle
  has no lock+burn). No page yet — data ready when you want the
  Surface H page.
- /api/public/insights/tc-report — composite per-wallet report
  wrapping get_wallet_tc_report RPC. Powers the Week 3 personalized
  TC DM workflow. Intentionally NOT on the landing index; it's an
  internal tool.

Landing page now shows 6 cards: A/B/C/D/E + squeeze-check tool.

Backing DB:
- audit_20260530_pinnacle_scarcity_board_view_for_surface_h
- audit_20260530_wallet_squeeze_exposure_rpc (initial + no-temp-table)
- audit_20260530_get_wallet_tc_report_rpc
- audit_20260530_cached_listings_v2_close_expired_recurring_rpc
Plus the B2 plan doc gains a readiness-gate query at the top."
git push origin main
```

## Honest blocks (revisited)

- **Surface F (Got Game burn)** — still blocked. badge_editions has
  zero coverage for the Got Game set (it's in the 44% of TS sets
  with no badge coverage).
- **pack_rips dist_id bulk backfill** — confirmed: 5,000-row sweep
  resolved 19. Attrition is at pack_drop_pool (0.03% hit rate). The
  existing cron is doing all it can; needs pack-EV ingest to
  backfill historical drops.
- **Reward-Pack Premium Board (Fast Break secondary curve)** — still
  blocked on `pack_purchases.pack_dist_id` 0/134,820 on TS (only
  resolvable via pack_rips, which has its own attrition problem).
- **TS V1 sales `buyer_address` resolution gap** — affects the
  `recent_acquisitions` section of the TC report. Needs the
  fetchTxBuyers pattern from AllDay applied to TS. Documented as
  CLAUDE.md long-tail #1; not autonomous-safe.

## Suggested order

1. Land this commit (4 new files + 2 doc updates).
2. Smoke `/insights/squeeze-check` with a wallet (your own works; try
   pasting different ones from `/insights/cross-collection`'s top-20).
3. If you want a Surface H Pinnacle scarcity page, the route is ready —
   the page is a quick lift mirroring the squeeze board structure.
4. If you want to start the TC outreach workflow, hit
   `/api/public/insights/tc-report?wallet=0x...` against your shortlist.
   The data's all there; a polished UI is one more commit.

## Item B leak status (for your tracker)

- 12:00ish UTC measurement (Claude Code): `uuid_to_int_redirected` 9-12/tick
- 15:30 UTC measurement (this pass): 24h leak rate 804 rows, ~46%
  reduction from 1,500/day pre-fix baseline. Residual is the pack-EV
  pipeline path that B2 addresses.
- Item B2 readiness gate VALIDATES CLEAN as of 14:48 UTC (4,976
  safe-to-merge, 2 ambiguous, 210 hydrated-no-canon — exact match to
  the dry-run).
