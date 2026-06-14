# Full Platform Audit — 2026-06-13 (evening, Cowork interactive)

Run ~21:00Z 06-13 → 04:30Z 06-14, the day after the DBSAT-IO-EXHAUSTION-0612 recovery + Micro→Small compute upgrade. Scope: DB + pipelines, security, FMV accuracy, deploys, Sentry, GHA/cron, Telegram alerts, Cowork estate (artifacts/tasks/skills), AND — the part the 06-12 audit couldn't do (Chrome was down) — a live Chrome pass of the moment-page template (light + dark), the trophy case, the new /insights/trophies surface, and a Dapper Market cross-check. Plus the specific deep-dive Trevor asked for: every trophy in his case + his top 20 moments by FMV.

Companion: docs/roadmap-2026-06.md (updated same session). Code handoff: docs/handoff-2026-06-13-audit-trophy-moment-media.md. Prior audit: docs/audits/full-platform-audit-2026-06-12.md.

---

## 1. Verdict

**Platform is GREEN and healthier than 06-12.** Security clean across all four checks; pipelines 0.11% fail rate (all wave-coincident IO class, far below alarm); FMV quality still climbing; the DBSAT incident class stayed resolved on the Small tier. One real, shipped fix this session (trophy-case stale FMV). The main remaining user-facing defect is **blank hero media on ~30% of premium (Series-1) Top Shot moment pages** — a CDN-URL problem with a clean fix (handoff Item 1). Everything else is completeness/parity polish.

## 2. DB + pipelines (live)

| Check | Result |
|---|---|
| Security (4 checks) | **0/0/0/0** — RLS-off base tables none; anon/auth write none; check_secdef_anon_execute_violations `[]`; check_public_security_invariants 0 |
| detect_stalled_pipelines() | `[]` |
| get_pipeline_alerts() | `[]` |
| v_rpc_trust_health | **8/8 ok** (edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap $1/50, pack_ev_stale 0.8d/2, pack_ev_depleted 0/30, pinnacle_ask 0.2h/3, pinnacle_fmv 18.3h/30, ts_uuid_dupes_24h 0/200) |
| Pipeline fails 24h | **14 / 12,834 (0.11%)** — check-alerts 4, wmc-fmv-populate 4, topshot-fmv-populate 2, +1 each offers-sweep/pack-events/hybrid-custody/pack-events-backfill (all wave-coincident) |
| Sentinel TS-UUID-48h | **0** |
| DB size | 4,544 MB (creep ~+90/day; weekly-db-maintenance prune due ~06-14 04:23Z) |
| unmapped_sales open | **247** (⚠ creeping from 183→215→247; AllDay resolver class — watch) |

GHA + drain pipelines all healthy (48h): ufc-enrichment-drain ok (48 runs, last 04:07Z — UFC null-key drain working), topshot-sales-history-backfill ok (23), topshot-buyer-backfill ok (272, TS buyer gap draining), topshot-badge-catalog ok (7), pinnacle-owner-discovery ok (19).

## 3. FMV accuracy + completeness

| Metric | Value | Trend |
|---|---|---|
| TS HIGH+MED | **3,350** (966 H / 2,384 M) | ↑ from 3,282 (06-13 am), 3,259 (06-12) |
| TS NO_DATA | 4,099 | ↓ (improving) |
| TS ASK_ONLY / STALE / LOW | 915 / 468 / 6,688 | tshb draining ASK_ONLY → sales-backed |
| AllDay HIGH+MED | **677** (166 H / 511 M) | ↑ from 657 |
| Pinnacle per-render priced | 1,836 (797 HIGH+MED) | healthy |
| fmv-recalc 24h | 93 runs / 0 fails | last 04:08Z ok |
| fmv_sanity_flags | 0 | — |

## 4. Deploys / Sentry / alerts / estate

- **Vercel: prod `6b4aca4` (light-mode batch 2b) READY.** Recent CANCELED deploys are docs-only commits correctly skipped by the new `ignoreCommand` cost fix (0e7e627) — working as intended, NOT errors. No ERROR deploys.
- **Sentry: 1 unresolved** — JAVASCRIPT-NEXTJS-15 (allday-listings retry churn). `bd8e05c` (today) tuned that exact alert; last occurrence predates the fix → quiet. The 2 incident-echo issues (06-12) already auto-resolved. Resolve NEXTJS-15 after 24h quiet.
- **Telegram alerts:** check-alerts firing (trust-health 8/8 feeds it); sentinel path exercised during the 06-12 incident as designed.
- **Estate:** 13 scheduled tasks enabled (all on Opus post-fable-outage, all firing on cadence); 12 active artifacts + 5 intentional RETIRED tombstones; rpc-live-health refreshed 02:54Z. Skills current (rpc-data/migration/handoff/cron-ops/insights-qa).
- **/insights/trophies** (new public surface, shipped 34b1543 today) QA'd — honest copy, KPIs (200 trophies/170 1-of-1s/94 priced/$10k top), confidence chips (ASK/STALE/LOW/AWAITING A COMP, never $0), explainer + legend, lazy images load fine. TROPHIES-INSIGHTS-QA can close. One follow-up: add it to the rpc-live-health insights surface list (rpc-insights-health is a tombstone now).

## 5. Trophy case (Trevor's subject) — audited live + FIXED

All 6 slabs render beautifully (holographic 3D, light-mode clean, art loads via the media/<momentId> CDN). Found + SHIPPED a fix for stale data:

- **SHIPPED `audit_20260613_trophy_slab_live_fmv_resolve`** — `get_trophy_slab_data` was returning frozen pin-time FMV/tier/circ because its editions join keyed on the inert UUID `tm.edition_id` (join failed → frozen fallback). Now resolves live via wmc→editions→latest fmv (live-first, frozen fallback), + additive `fmv_confidence`. Verified live on the dashboard: Deni Avdija ULTIMATE (was mislabeled COMMON) #1/1; Lillard Cosmic $425 (was $1,100); Amon-Ra $450 (was $1,045); Clingan $2,100; LeBron Anthology $1,800. Both dashboard + public profile fixed (by_username delegates). Security 0/0, grants preserved.
- Remaining (cosmetic): trophy_moments.edition_id still UUID for 4 TS slabs — RPC now resolves around it; optional canonical backfill (handoff Item 4).

## 6. Top 20 by FMV + trophy moments — page-by-page (22 unique)

DB completeness across all 22: **all resolve ok, all have media URLs, all owner=Trevor, Similar editions = 6 on every one, Recent activity populated on 20/22** (last-10 all-time). FMV present on 21/22 (KD Supernova /10 = NO_DATA, never traded — honest). The 2 empty Recent-activity pages (KD Supernova, Amon-Ra Rookie Revelation AllDay) are genuinely never-traded grails.

Findings:
- **HERO MEDIA 404 (HIGH, handoff Item 1):** 6 of 21 top stored thumbnails 404 — ALL Series-1 editions (LeBron Base 2:133, LeBron Metallic Gold 5:133, Harden/Zion/Oladipo Holo MMXX 4:82/4:127/4:142, Lillard Cosmic 8:145). The moment hero uses `editions.thumbnail_url`/`video_url` (constructed `…/editions/…Transparent.png` form) which 404s for legacy editions → blank hero on ~30% of Trevor's top moment pages, his most iconic grails. The per-moment `media/<momentId>/image` CDN form works on all 21 (it's what the trophy slabs already use). AllDay unaffected.
- **special_serial_holders EMPTY (MED, handoff Item 2):** 0 rows platform-wide → curated special-serial pills never render; only derived #1/Low/Last show. Dapper shows a Special Serials list WITH owners for every edition (Trevor's exact ask). Parity feature, not a quick fix.
- **Copy nit (LOW, handoff Item 3):** "No sales in the last 30 days" is misleading (table is last-10-all-time).
- Badges resolve correctly (e.g. LeBron Metallic Gold → Championship Year + Top Shot Debut).
- Moment-page template is clean in BOTH light and dark mode (verified `/moment/134293` in each).

## 7. Dapper Market cross-check

LeBron Metallic Gold #258/299 (134293) on dapper.market: tier RARE, #258/299, Metallic Gold LE (Series 1), Lakers, Dunk/Layup, Nov 16 2019 — **all match RPC exactly**. Dapper additionally shows: Top Collectors (Most Owned) and a Special Serials list with owners (#1 Lakers08x24, #23 jersey na_mic_tire, #299 last ticketsftw248) — the gap captured in §6. Recent sales: RPC's Recent activity reads the same on-chain `sales` source Dapper does and showed real sales with resolved @handle buyers/sellers — parity is structural. Dapper's outbound links from RPC resolve correctly (`dapper.market/nba/moment/<id>`).

## 8. Open items (who / what)

| Item | Owner | State |
|---|---|---|
| Moment-hero media 404 (Series-1) | CC | Handoff Item 1 (HIGH) |
| Special Serials + owners parity | CC/Trevor | Handoff Item 2 (feature) |
| Recent-activity empty copy | CC | Handoff Item 3 (LOW) |
| Trophy-slab confidence chip (additive) | CC | Handoff Item 0 follow-up |
| Trophy edition_id canonical backfill | DB | Handoff Item 4 (optional) |
| unmapped_sales AllDay drift (247) | Watch | resolver class, +~30/day |
| NEXTJS-15 resolve-after-quiet | Operator | ~24h quiet mark |
| DB creep / weekly prune | Auto | 06-14 maintenance fire |
| Compute add-on | Trevor | CLOSED (DBSAT resolved on Small) |
