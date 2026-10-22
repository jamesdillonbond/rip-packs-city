# Overnight pass — 2026-10-22 (~01:15 AM PT)

**Mode:** genuine overnight run (DB `now()` 08:04Z, `max(sales.ingested_at)` 08:03Z and shell all agree to the second — no clock skew; real local time ~01:04 AM PT). Push available (clone `git push --dry-run` clean). No FREEZE. Lock taken (`HELD 2026-10-22T08:04Z run=3c2cf593e491`), released at end.

**Verdict: GREEN · 0 production shipped · 0 reverted.** `idle: routed-to-trevor` (oldest routed item #58 OPENSEA_API_KEY, ~27 nights). Honest quiet night — nothing was both low-risk and non-hot/verifiable to ship. Two carried items cleared themselves since 10-21 (R118, refresh-conflated-editions); the one genuinely-new HIGH-flagged inbox item (pinnacle-image) investigated down to platform noise with its filing hypothesis refuted.

## What was reviewed
- **Inbox drained:** the two filings newer than the 10-21 pass — `2026-10-21T1515Z` (fmv-recalc Step 6 flatline) and `2026-10-22T0313Z` (pinnacle-image MODULE_NOT_FOUND recurred). Older filings (≤10-21T0315Z) were dispositioned by the 10-20/10-21 passes. Inbox left untouched (append-only); dispositions are here.
- **Health:** full `rpc_ops_snapshot()` baseline + `check_pgcron_recent_failures()` (STANDING) + `check_when_others_timeout_blind()` (R118) + direct security posture (via snapshot `security` block). Post-ship regression watch of the 10-20/10-21 Claude Code sweeps.
- **Vercel:** runtime errors (48h), production deploy list.
- **Dated check now due:** the demand re-read (PT week 10-15..10-21) — partially executed, canonical write queued (see Queued #1).

## Health-drift findings + deltas
**GREEN.** Security invariants/anon-write/rls-off/secdef all `[]` (snapshot). pg_cron failures `[]`. `detect_stalled_pipelines()` `[]`. Sentinel ts_uuid 48h `0`, ts_uuid_dupes_24h `0`. Structural-drift arms (search_path, cross-collection staleness, suppression drift, wmc null edition-key) all `[]`. 37 of 38 trust arms ok.

- **Only breach: `candy_sales_stale_hours` 244.7h** (breach 168) — long-known **#58** (Magic Eden Candy feed silent since 10-11, OpenSea unkeyed; Trevor-only). Was 220.8h on 10-21. Do not re-tune the arm (10-19 steer).
- **`fmv_stale_touch_hours` 0.3 ok** — the 10-21 Step-6 flatline (inbox `2026-10-21T1515Z`) is RESOLVED: Claude Code migration `20261021154134` lets a clean probe with 0 cohort-candidates reset the arm (it was unsatisfiable at a genuinely-empty cohort, not a step regression). Confirmed live (0.3h, ok). No action.
- **R118 CLEARED:** `check_when_others_timeout_blind()` returns `[]` this pass (was flagging `autograph_sweep_tick` on 10-21). The queued exclusion-list item is no longer reproducible; closed as resolved.
- **refresh-conflated-editions watch CLEARED:** `stalled_pipelines` `[]` and its medium watchlist row is gone from `pipeline_alerts`. The 300s fix is holding; terminal row now written.
- **pipeline_alerts:** 5 rows, all `info`, all attributed-upstream Cloudflare 403/400 (atlas-editions 77/480, atlas-market 46/316, atlas-supply 3/42, atlas-pack-supply 32/240, flow-rest moment-moved 1/265) — every lane fresh (last 200/drain within cadence); by design, nothing lost, none escalated.
- **pipeline_fails_24h:** topshot-pack-supply-atlas 317 (chronic 403-retry, upstream 0 — by design), atlas-market-feed 12, pack-mint-probes 12 (by-design backward walk), sync-nba-projections 8 (muted to 10-28), rest ≤5; all upstream 0.
- **backward_cursor_rewind:** `topshot_missing_fill_offers_walk` +9.4M-block forward jump (10-19 18:12Z) — known/CLOSED deliberate weekly re-seed (inbox `2026-10-20T2110Z`). Not re-raised.

**Deltas vs `metrics-latest.json` (10-21):**
- db_size 40,714 → **41,337 MB (+623)** — Panini coverage expansion + sales growth; not runaway (Large tier).
- editions: panini 36,957 → **38,784 (+1,827)**; nba 14,528 → 14,537; others flat.
- FMV HIGH+MED: panini 15,797 → **17,154 (+1,357, coverage)**; nba 6,489 → 6,466 (−23); nfl 1,674 → 1,697 (+23); pinnacle 945 → 929 (−16); candy 70 → 69 (−1, MEDIUM draining by design); golazos 1; ufc 0.
- trust breaches 1 → 1 (candy_sales_stale, 220.8 → 244.7h).

**Post-ship watch (10-20/10-21 Claude Code sweeps — not night-pass ships):** GREEN. All FMV arms ok, `fmv_sanity_flags` 0, `pinnacle_fmv_impossible_flags` 0, boards non-empty/non-slow (`public_board_empty_count`/`slow_count` 0), `fmv_sweep_wedge_hours` 0.15 ok, `fmv_sweep_stall_pct_24h` 4 ok. No new Vercel error class attributable to the sweeps. Nothing reverted.

## Shipped
**None to production.** No code, no migration, no deploy. The one new HIGH-flagged item (pinnacle-image) has no app-code fix (platform noise, below); the demand re-read's canonical write is queued (method not codified); everything else is carried/Trevor/off-limits.

## Investigated → dispositioned (no ship)

### pinnacle-image MODULE_NOT_FOUND — inbox `2026-10-22T0313Z` hypothesis REFUTED; platform noise, no app fix
The filing escalated this and proposed "the route reaches into the pages-router `_next/image` optimizer, absent from the app-router bundle; fix the route's image path." **That is refuted by the code and by production:**
- `app/api/public/pinnacle-image/[renderId]/route.ts` is a pure app-router handler (`runtime="nodejs"`, `force-dynamic`) that fetches a signed Dapper URL server-side and returns a **302 redirect** (or 404/400 JSON). It never imports or invokes `_next/image`. Last touched 2026-09-26 (`8019f6507`) — not collision-hot.
- Both consumer files use plain `<img>` (with `@next/next/no-img-element`), and **neither imports `next/image`** (`app/pinnacle/moment/[id]/page.tsx`, `app/moment/[id]/page.tsx`). So app code never routes pinnacle-image through the Next optimizer — there is no "route image path" to fix.
- **Production reproduction on the current serving deploy (`8eede4882` / `dpl_F1KTSEgezK1LC2Ebe99diyiXfUyj`, READY):** both failing renderIds (`LEV1-SLBT-FORE-S6`, `LEV1-PDRA-DISC-S6`), all three variants, return **302 → signed Dapper URL**; the `/_next/image?url=…` optimizer returns **200** at w=256 and w=640 for both. Nothing 500s.
- **The actual error** is `Failed to handle /_next/image?nxtPrenderId=… Error: Cannot find module './.next/server/pages/_next/image.js'` — the Next `/_next/image` optimizer's cold-lambda MODULE_NOT_FOUND packaging flake, triggered by external/bot traffic hitting `/_next/image` directly (note the synthetic `nxtPrenderId` param). **2 occurrences in 2.5 days** (10-19 20:12Z, 10-21 23:43Z), each count=1 / 1 user, **both on the now-superseded deploy `dpl_6rDX33Cc49LiQj7vHodrmHkKU37a`** — not the serving deploy. Graceful (the `<img>` onError falls back to a placeholder tile).
- **Disposition:** no route/consumer fix exists; current prod is clean. The only thing that would suppress the error class is a project-wide Next config change (`images.unoptimized`, or a firewall rule on `/_next/image`) — not warranted by 2 cold-lambda occurrences, and off-scope for a night pass. The 10-19 "benign cold-start" read and the 10-22 "real packaging break, fix the route" read are **both superseded** by this: it is a low-volume Next optimizer platform artifact on superseded deploys, not a route defect.

## Queued for Trevor / Claude Code
1. **[P3, interactive/Claude Code, 1 night — now due] Demand re-read, PT week 10-15..10-21 — canonical doc write.** The read-only data was gathered tonight (below), but the 10-15 baseline's exact queries were never codified (prose-only across `roadmap-status.md` / the `2026-10-18T0233Z` filing), and the comparison turns on two steps I can't reproduce faithfully unattended: the **ref→source first-page-of-visit classification** and the **"unflagged headless fingerprint" discount**. Stamping a possibly-inconsistent dated block into `roadmap-status.md` would seed a bad baseline for every future read (the exact trap `focus.md` warns about). **So: not stamped.** Recommend codifying the 10-15 queries as `scripts/demand-read.sql` first, then the write is mechanical. **Clean figures gathered (event-level unless noted; week = 2026-10-15 07:00Z → 2026-10-22 07:00Z, `usage_events` minus `metadata.automated`):**
   - Non-automated events **503** (baseline 334); 0 `webdriver`, 0 headless-UA (the automated flag already caught those); **120 distinct sessions**, 9 wallets.
   - **External signed-in users (minus `internal_accounts`): 7** (baseline 6).
   - **Funnel:** share page-views 72; `signin_click` events **0** (baseline paste→sign-in click 10→0 — the share→sign-in drop-off is unchanged); email-capture (`first-alert-prompt-shown`) shown 11×; `magic-link-requested` 5.
   - **Page-view referrers (event-level, indicative — NOT the baseline's visit-level first-page):** direct/none 218, Google 93, ChatGPT (`utm_source=chatgpt.com`) 40, Bing 4, X/t.co 1, Ecosia 1. ChatGPT long-tail referral continues; Google long-tail continues.
2. **[P2, Trevor, ~27 nights] #58 `OPENSEA_API_KEY`.** `candy_sales_stale_hours` 244.7h BREACH; indexer healthy, Magic Eden Candy feed silent since 10-11, OpenSea unkeyed. Clears when Trevor sets the key or the feed resumes.
3. **[P3, Trevor/interactive, carried] DROP 3 leftover scratch tables (~4.8 MB)** — `public.scratch_20261019_counter_checks_before`, `scratch_20261010_rip_dist_sample`, `scratch_20261010_rip_ident_batches`. RLS-on, no anon exposure; cosmetic; off-limits DROP for a night pass (SQL editor).

## Carried watches (no decision needed)
- **Dated checks:** demand re-read (above, Queued #1) — now due, partially done. **#193 Pinnacle re-measure due ≥10-31** (pricing change → NOT a night-pass ship; report numbers only).
- **Candy FMV MEDIUM** steps down by design (10-19 steer) while no Candy sale is indexed — exits week of 11-02, 11-09; ~0% by ~11-11. Falsifier: a HIGH/MEDIUM Candy edition whose newest sale is >30d old after a recalc.

## Failed / blocked / reverted
None. No verification failure; no hard-stop. Push available throughout; origin/main steady at `55ee731ec` across the pass (no collision). Lock released.
