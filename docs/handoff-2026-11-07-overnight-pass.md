# Overnight pass — 2026-11-07 (~1:00–1:20 AM PT)

> ⚠ The git-push constraints noted here are specific to **this Cowork cloud session** (no `add_repo` tool; `gh` token invalid; GitHub Actions reachable only via the mount `.rpc-git-cred` token as an API Bearer). Trevor's machine and Claude Code push and read Actions normally via Git Credential Manager. **Commit/push as usual.**

**Session:** Cowork cloud, laptop-VM clone + `.rpc-git-cred` (push available — VM dry-run `Everything up-to-date`). Genuine overnight run, clock verified against DB: shell 09:02:16Z, DB `now()` 09:02:47Z, newest sale ingest 08:54Z, newest FMV compute 08:53Z — all agree, no skew; 09:0xZ = ~1:0x AM PT, inside 00:00–06:00 PST. Not frozen. No `add_repo` this session; GHA read done via the mount cred token as a GitHub API Bearer (sanctioned path; token never printed).

**Verdict: GREEN · 0 shipped · 0 reverted · idle: routed-to-claude-code · oldest routed: #228 cold-whale `/api/collection-snapshot` CDN-warm lever, 4 nights.** Nothing was clearly-safe-and-open with an autonomous sandbox lever. The two owed dated reads both came back benign (All Day FMV ratio ACCEPT; Panini backlog on track — 3-night check complete). All three new inbox items resolved without a ship. Two carried queue items closed (trophies `max_ms` applied + breach cleared; cron-job.org MFA now on). Docs only: this handoff, ledger line, metrics, session entry.

## What was reviewed

- **CLAUDE.md** in full; continuity state (`ledger.md` top matter, `inbox/INDEX.md` + filings since the last pass, `metrics-latest.json`, `focus.md` active steers, latest handoffs 11-06 overnight + daytime-audit). `ops:ready-queue` run.
- **Inbox — three new filings since the last pass, all resolved; inbox left untouched (append-only):**
  - `2026-11-07T0409Z` **All Day 7-d published FMV/sale ratio 0.899 < 0.90** → **ACCEPT** (see owed reads). Re-derived here: 7-d published ALL ratio **0.889**, driven by LOW tier **0.761**, which is the by-design `allday_low_haircut_075` (no-sale LOW editions at 0.75×floor). 30-d ratio a clean **1.000 across every tier**. Median abs error **$0.05** on a sub-$1 market. Not a writer defect; no haircut change (the steer and the filing both say explicitly: do not change the haircut off one marginal short-window read). **Steer closed.**
  - `2026-11-06T1610Z` **scheduler-liveness reds `main` daily (new weekly `cadence-swap-lint.yml` never fired)** → **ALREADY FIXED IN-TREE.** The durable grace the filing asked for landed as `e5dadf492` (`check-scheduler-liveness.mjs`: `graceHours = Math.max(newWorkflowGraceHours, silenceThresholdHours(perDay))`, + test `__tests__/scheduler-liveness-detector.test.ts`), present in current HEAD `a6c822a04`. Verified by hand: cadence-swap-lint (cron `41 17 * * 1`, perDay ≈ 0.143, threshold 192 h, age ~106 h) now classifies **pending**, not dead. A `workflow_dispatch` of scheduler-liveness on `e5dadf492` ran **success** (11-06 16:51Z); the last scheduled *failure* (15:56Z 11-06, head `2548434`) predates the fix. Next scheduled tick (~08:17 AM PT 11-07, after this pass) self-confirms. No action.
  - `2026-11-06T2205Z` **verify the E2E DOM Smoke band re-pin (`cfa4711`) cleared** → **RESOLVED.** `e2e-smoke.yml` is **success on current HEAD `a6c822a04`** (11-07 07:23Z) and on the two prior 11-07 deploys. The band monitor reading `/nba-top-shot/market` passes. No action.
  - Older filings (`2026-11-05T0105Z` conflated-editions miss, `2026-11-06T0109Z` sold-floor, `2026-11-06T0414Z` perfect-mint liveness) were all dispositioned in prior 11-05/11-06 handoffs; confirmed still holding (sold-floor arm 10 ok; `public_board_empty_count` 0 ok).
- **Dashboards:** none flagged broken by the monitor; no schema change broke a dashboard query. No repair in scope.

## Post-ship regression watch (FIRST, before any shipping) — CLEAN

Re-measured the 11-06 daytime-audit ships (7 code commits + 6 migrations) and the 11-06 overnight's one applied config write, against their targets:

- **`v_insights_trophies` max_ms 3000 → 7000** (queued 11-06 overnight, applied by Claude Code ~7:05 AM PT per ledger): **confirmed landed** — `public_board_slow_count` = **0, ok** in tonight's snapshot; trust 40/40, 0 breaches. The one benign flicker the 11-06 overnight queued is now closed.
- **Search typo fuzzy fallbacks, og:image/JSON-LD, mixed-case 308s, All Day ≤50 premium-serial stale cap, All Day LOW 0.75 haircut:** no regression signal — `fmv_sanity_flags` 0, `edition_integrity_flags` 22 (<250), `topshot_fmv_stale_hours` 0.3, `panini_fmv_stale_hours` 0, `topshot_impossible_parallel_serials` 0, 0 FMV-related trust breaches. All Day 30-d backtest ratio a clean 1.000 across tiers. No new Vercel crash group. CI on HEAD `a6c822a04` fully green (29 checks). No auto-revert needed or taken.

## Health-drift findings + deltas (`rpc_ops_snapshot()` 09:05:35Z)

- **Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations `[]`. The Section-2 direct queries agree (0 public tables with RLS off; `check_public_security_invariants()` `[]`). **Clean.**
  - ⚠ **Transient, already self-resolved (not a live finding):** the `/api/smoke-test` error group showed `check_public_security_invariants: rls_off_base_table:audit_20261106_topshot_dead_hero_thumbnails_backup`, last seen **03:21Z** (~7:21 PM PT 11-06). Direct check at ~09:08Z: that table now has **RLS ON** (21 MB, 0 anon/authenticated grants). An 11-06 cleanup created the backup table momentarily without RLS; the invariant smoke-test caught it (instrument working as designed) and RLS was enabled before this pass. Standing lesson (already in CLAUDE.md): `audit_*` backup tables must get RLS enabled at creation. No action.
- **Trust:** **40/40 ok, 0 breaches.** Notable legs: candy_sales_stale_hours 629.7 (<1114.9; candy re-verify ~11-27), edition_integrity_flags 22 (<250), panini_coverage_pct_drop 5.9 (<15), fmv_sanity_flags 0, trust_precompute_max_age 5.29 (<13; NOT the refresher), topshot_sold_floor_asks_found 10 (<50), public_board_slow_count 0, public_board_empty_count 0.
- **Pipelines:** `stalled_pipelines` `[]`. Structural checks all `[]` (wmc_null_edition_key, backward_cursor_rewinds, function_search_path_drift, procedure pins/txn, cross_collection_mat_staleness, suppression drifts). sentinel_ts_uuid_editions_48h 0, ts_uuid_dupes_created_24h 0. `pipeline_fails_24h` all upstream 0 — topshot-pack-supply-atlas 25, atlas-pack-market 19 (Atlas Cloudflare challenges, designed), the rest ≤7.
- **Alerts:** 1 `medium` + 2 `info`.
  - **`candy-offers-indexer` failure_rate medium (3/9 over 3 d) — benign upstream flake.** Each failure is a Magic Eden bid-activity *discovery* 503/timeout; the known/stored bidders were still swept every tick, and the last two ticks (00:50Z, 06:50Z 11-07) are ok. Candy secondary trading has been silent since 10-11, so the discovery call is naturally thin and ME 503ing it intermittently is upstream, not ours. No sandbox lever; honest error logged; self-recovering. WATCH only.
  - 2 `info`, both designed: Flow REST moved-Moment 400s (8/229, 3.5%, last ok 09:03Z) and Atlas pack-supply 404 (2/240, last 200 09:05Z).
- **Sentry:** dark (SDK removed #34). **Paired with Vercel** (a Sentry zero is health only beside a near-zero Vercel number): Vercel 24h = 50 error groups, **every one chronic** `read exceeded Nms` degrade-to-empty (market-cap tile 8s bounds, set tier-mix 6s, entity-section statement-timeouts, player-hub 4s bounds, pack-reality/market-pulse/pack-sniper initial-fetch 8s), first-seen Jul–Oct, a burst at 01:41Z consistent with an ISR/crawler revalidation wave hitting many edition/set/player pages at once. **No new crash group.** **Client beacon:** 0 real errors.
- **DB size:** 46,281 MB (−291 vs 46,572 last night) — `net._http_response` 6h-TTL Atlas sawtooth, within band. No new unexpected >200 MB public table.

### Deltas vs `metrics-latest.json` (11-06 daytime, 20:55Z)

- db 46,572 → 46,281 MB (−291; net._http_response sawtooth).
- FMV HIGH+MED: nba 6,786 → 6,826 (+40; HIGH 1,256 + MED 5,570); panini 18,001 → 17,996 (−5; HIGH 17,170 + MED 826); nfl 1,655 → 1,700 (+45; HIGH 238 + MED 1,462); pinnacle 937 → 926 (−11; HIGH 237 + MED 689); candy 51 → 49 (−2); golazos 1 → 1; ufc 0. Normal churn (fmv_sanity_flags 0).
- editions: nba 14,696 → 14,704 (+8); panini 40,302 flat; nfl/golazos/ufc/candy flat.
- trust breaches 0 → 0.

## Owed dated reads

- **All Day 7-d published FMV/sale ratio (focus.md steer 11-04 "re-read after 11-07"):** 7-d published ALL **0.889** (n=3,694) — the step is now ~3–4 d into the window. Tier split: LOW **0.761** (n=852, the driver), MEDIUM 0.890, HIGH 0.960, ASK_ONLY 1.000. 30-d published ALL **1.000** (LOW/MED/HIGH all 1.000). **Decision: ACCEPT.** The sub-0.90 is the intended `allday_low_haircut_075` (no-sale LOW editions priced at 0.75×floor — LOW ratio 0.761 ≈ the 0.75 haircut) plus a sub-$1 market where $0.05 median abs error is ~20% of a $0.25 sale; the 30-d 1.000 shows LOW tracks actual sales fine over a real window. Not a writer defect. **No lever pulled.** Steer closed.
- **Panini old-catalogue backlog (focus.md steer, 11-07 read owed — the 3rd of 3 nights Trevor's cadence decision depends on):** older-than-7d **7,999** (was 8,260 on 11-06 ~9:40 PM PT, 11,223 on 11-06 7:10 AM PT) ≈ **−3.2k/18 h ≈ −4.3k/day** — ahead of the expected −2.5k/day. Oldest `last_seen_at` 2026-10-27 18:19Z. Total 40,302. **Walk-weighting-off regression watch (both 11-07 conditions hold):** non-WC (n=35,014) p50 75.6 h, **>9 d = 6,245 and falling** (was 6,495); WC (product_set_id 2332, n=5,288) p50 **51.9 h (~2.2 d, ≤ 4 d)**, >9 d = 0. No regression shape (WC p50 well under 5 d; non-WC tail shrinking). **On track; cadence stays at 6 runs/day; the 3-night check is complete.**

## Queued for Trevor / Claude Code

1. **[P2, Claude Code, carried since 11-06 daytime] per-dist EV precompute for `get_pack_realized_ev_row`** — the pack page's last user-facing error class (~4/day, 5 s bounds; `pack-detail/pack_realized_ev` in Vercel 24h ×3). `mv_pack_ev_latest` is NOT a drop-in (374/1,392 dists absent, 412 gross_ev differ). Route/code → Claude Code (off-limits for autonomous shipping).
2. **[P3, Claude Code/Trevor, 4 nights] #228 cold-whale `/api/collection-snapshot` timeout** — SQL lever exhausted; next lever is CDN warm (route/edge, off-limits). **Not recurring** (absent from the 24h window since 11-04); dormant, carried for completeness.
3. **[P4, Trevor, dated ~11-11] `net._http_response` growth lever** — weekly read; whether `atlas_market_drain` should delete consumed 200 responses (high-water mark, not a leak). Detail: inbox `2026-11-03T0705Z`.
4. **[P4, Trevor, dated ~11-27] #58 OPENSEA_API_KEY / candy re-verify** — the candy_mlb silence re-verify clock breaches ~11-27; secret, no sandbox lever.

### Closed this pass (recap — not open queue)

- **`v_insights_trophies` max_ms 3000 → 7000** — applied by Claude Code ~7:05 AM PT 11-06; `public_board_slow_count` = 0 ok tonight. RESOLVED.
- **cron-job.org account MFA** — now on (TOTP, verified), commit `65585fb16` (11-06). RESOLVED.

## Failed / blocked / reverted

Nothing failed; nothing was blocked (no write was attempted — the owed reads were ACCEPT/on-track and the carried queue has no autonomous sandbox lever); nothing reverted. No shipping hard-stop.

## Revert (this pass)

Docs only — `git revert` the commit titled "docs(overnight): 2026-11-07 pass — green, 0 shipped".
