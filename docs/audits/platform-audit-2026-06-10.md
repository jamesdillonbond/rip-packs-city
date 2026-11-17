# Platform audit — 2026-06-10 (evening Cowork full sweep)

Requested by Trevor: full audit of platform, tools, artifacts, scheduled tasks, DB, pipelines, crons, GHA, errors, FMV accuracy, alerts, backfills, site pages — plus LiveToken methodology and the recurring git lock. Run 16:40–17:30Z, during the tail of the DAYTIME-DBSAT incident.

## 1. The day's incident (context for every red light below)

- 10:13Z onward: platform-wide statement timeouts; root cause `populate_wmc_image` seq-scanning wmc 2x/5min after its partial index was defeated by the `image_url=''` predicate. Root-caused + FIXED LIVE by the daytime monitor (migration `audit_20260610_populate_wmc_image_partial_index_fast_path`, 43–111s → 2–554ms). Recovery trending through the evening; 23 fails/87 ok in the 30-min window at 16:45Z, improving.
- 12:55Z 5xx spike on /api/wallet-backfill-allday + -pinnacle (210/203 in 5 min): the 12:45 PT seed-wallet-refresh dispatched all ~252 active seeded wallets' backfills CONCURRENTLY into the saturated DB; the orchestrator's own dispatch retries amplified. Sales ingest and FMV freshness were never actually stale (TS sale 16:22Z, FMV snapshot 16:38Z) — the scary sentinel ping was timeout casualties.
- Structural note: cumulative cache hit ratio 97.2%; the working set no longer fits PRO Micro RAM comfortably. Per Trevor: NO compute upgrade — remediation is load- and size-reduction (see §9).

## 2. Health scoreboard (16:40–17:30Z)

- Security: 0/0 on both canonical checks (`check_public_security_invariants`, `check_secdef_anon_execute_violations`). RLS on all public tables.
- Trust health: 6/7 ok. ONE BREACH: `pinnacle_ask_stale_hours` 6.7h (breach ≥3h) — `pinnacle-listings-reconcile` failing 6/6 on statement timeout (saturation casualty; self-heals as IO recovers; verify <3h tonight).
- detect_stalled: `pinnacle-wmc-render-id` (silent since 09:37Z) + `populate-pinnacle-wmc-fmv` (11:03Z). NOT cron-disable — verified on cron-job.org console: both entries active and firing; the ROUTES fail before logging (sync 500 at ~9.3s / 30s client timeout). CC handoff items.
- Sales: TS 93 sales/2h, AllDay fresh. Editions/sentinel: ts_uuid_dupes_24h = 0.
- Deploys: 20/20 READY (prod 4d3e3ad). GHA: CI + Smoke + all ingest workflows green; only Pipeline Sentinel failing (its own DB checks time out under saturation — self-heals; hardening noted in handoff).
- Telegram alerts: working as designed (today's pings were accurate saturation signal).
- Audit-repair FMV guard check (focus 8c): 87 repaired editions, 0 re-clobbered >3x. Writer guards holding.
- Cron-job.org: ~69 entries; only deliberate Inactives (cadence-payer-balance-check, job 7491767 Pipeline Runs Cleanup — replaced by d4b058f prune-logs fold, first self-fire expected Sat 06-13). Failing entries are route-level: pinnacle-wmc-render-id (HTTP error), populate-pinnacle-wmc-fmv / run-insider-detectors / seed-topshot-pack-distributions / pack-events-ingest worker (30s cap).

## 3. FMV accuracy

- TS latest-per-edition: HIGH 602 / MEDIUM 1,852 / LOW 7,063 / ASK_ONLY 1,021 / SALES_ONLY 18 / STALE 231 / NO_DATA 4,755. HIGH+MED 2,454 vs 2,852 at the 08:20Z baseline — consistent with e3aee28's deliberate de-poisoning (grail-spike guard + Step-6 no-longer-immortalizing LOW); tonight's pass re-measures the ">3x own 90d median" metric (was 63 pre-fix; my live measurement timed out under saturation — defer to the night pass).
- fmv_sanity_flags 0; pack-EV board max staleness 1.08d (ok); Pinnacle render-FMV 6.7h (ok, <30h).
- The 8 organic users' portfolios are protected by the 06-09/06-10 fix wave; nothing new found beyond the queued LOW-bucket reliability problem (known, tracked).

## 4. Artifacts, scheduled tasks, skills

- 17 artifacts in manifest; monitor validated them at 15:05Z. No repairs needed today.
- 23 scheduled tasks: all sane; one-offs correctly disabled after firing. rpc-livetoken-crosscheck-resume fired today 16:00Z (one-time, completed). Cadences don't collide.
- Skills (rpc-data / rpc-migration / rpc-handoff / rpc-cron-ops / rpc-insights-qa) current; no drift found.

## 5. Site/UX sweep (spot checks during saturation)

- /insights/squeeze: fresh (09:37 update), rich, renders 200 rows. Data nit: many "The Champion's Path (2024)" rows show "—" for player (editions.player_name null on those TS editions) — cosmetic data-completeness item, queued.
- /insights/pack-sniper: honest empty state ("market efficient"), live-ask plumbing fine.
- /nba-top-shot/edition/2:188: full render (FMV, asks, best offer, IPFS verify, FMV history, sales, parallels, packs, special serials). Slow under saturation (>8s) — matches SMOKE-EDITION-TIMEOUT (smoke budget item, queued for CC). Buyer/seller columns all "—" on historical sales — expected until P3-BUYERS backfill drains (temp cron running).
- Sentry 22 unresolved: ~14 are smoke-test casualties of today's saturation (will quiet; resolve after 24h clean). Real client-side residue: the iOS WebKit "TypeError: Load failed" cluster on /dashboard + /share (4 issues, 1–2 events each) — known watch, low volume; NEXTJS-15 (PIN1) unchanged; 1A/16 stale singles.

## 6. LiveToken — how they do FMV + badges (Trevor's ask)

- Architecture: LiveToken is a Vue SPA; ALL pricing comes precomputed from their backend (`livetoken.co/api/topshot/account/<addr>`, `/api/topshot/momentSelector/`; auth-gated). The client bundles only FORMAT fields the API returns: `valueFMV` (per-moment, serial-adjusted), `minFMV`/`maxFMV` (they maintain an uncertainty RANGE), `thenFMV` (FMV at acquisition — they store per-moment FMV history for P/L). No client-side calculation to inspect; the algorithm is a server-side black box.
- What's observable (from our 06-02 cross-check + today): keyed on setID:playID exactly like our editions.external_id; serial-adjusted (low serials/jersey matches priced above edition level); tracks recent sales closely and reacts fast (they run their own full marketplace indexer — sales AND listings — which is why their FMV rarely goes stale); FMV presented per-serial is the big methodological difference from RPC's edition-level snapshot.
- Badges: they display Top Shot's OFFICIAL badge set as concatenated codes (TS/RY/RM/RP/CY/CR legend in memory livetoken-rpc-audit-reference). Same upstream truth as our badge-sync (Top Shot GQL tags); their coverage is complete because they walk the full catalog. RPC just shipped exactly that (catalog-walk badge sync, ed60ff0 + 3d0da01, 4x daily GHA) — coverage 3,138/9,136 (34%) and rising; track to ~100%.
- Implications for RPC (already on the books): per-serial adjustment + FMV ranges are the two LiveToken capabilities RPC lacks; both queued behind traction, not re-proposed here.

## 7. The git lock (Trevor's ask)

Two different locks get conflated:
- docs/overnight/.lock — OURS, by design (ledger concurrency guard). Currently a benign RELEASED marker (sandbox mounts can't unlink it, so released runs overwrite content instead; >45min-stale = take over). Working as intended; mild noise, no action.
- .git/index.lock "phantom" — the real annoyance. Verified (focus.md 9d + last night's pass): the file does NOT exist on Windows; sandbox sessions see it via the mount bridge, rm exits 0/says no-such-file while ls still shows it, and it blocks index operations (last night's pass couldn't commit its outputs DESPITE working push creds). It's the same Windows↔sandbox bridge corruption class as the config NULs (06-01, 06-08, 06-09).
- Workaround (proven 4x today): GIT_INDEX_FILE plumbing — export GIT_INDEX_FILE=/tmp/idx; git read-tree origin/main; git add <paths>; write-tree/commit-tree/update-ref; push. Already in tonight's pass instructions.
- DURABLE FIX (recommended): stop pointing sandbox git at the Windows-mounted .git entirely. The scheduled sessions (nightly pass + monitor) should clone fresh INTO the sandbox VM at session start using the fine-grained PAT that already powers their pushes, do all git ops in that native clone, push, and let the Windows tree just follow origin. That eliminates the whole class: phantom locks, config NUL corruption, truncated writes, cross-session staging hazards. Cost: ~30-60s clone (shallow) per run + a one-time edit to the two scheduled-task prompts. When a REAL index.lock ever appears on Windows (crashed git), PowerShell: Remove-Item .git\index.lock with no git running.

## 8. Open items inventory (deduped against today's heavy ship traffic)

Shipped TODAY already (do not redo): e3aee28 FMV poison fixes, a3c1a0c fifth wmc site, acf85c0 broken wmc writers, 4138db6 PINFMV guard, 7b03815 sitemap fossils, d4b058f weekly-maintenance fold + step3 observability, badge catalog GHA (ed60ff0/3d0da01), populate_wmc_image index fix (migration), trust-health pinnacle FMV leg.
Remaining → docs/handoff-2026-06-10-dbsat-residuals-and-cron30s.md (CC) + §9 decisions (Trevor) + ledger carries (PIN-FMV-REKEY-WAVES, PACKVIZ-GRID, NEXTJS-15/Q4, IPFS deferred legs, USERNAME-CRON note — the resolve-wallet-usernames entry EXISTS and fires :08/:38 hourly, verified on console today; the "unwired" claim in the 15:15Z inbox is stale).

## 9. Cost-flat capacity plan (NO Supabase upgrade, per Trevor) — EXECUTED same session

1. SHIPPED (Trevor-approved, ~18:10Z): `audit_20260610_drop_flowty_archive_api_harvest_and_dead_extractor_fns` — dropped flowty_archive.api_harvest_20260512 (2,580 MB / 33,177 rows, count(*)-verified) + the 4 orphaned Flowty extractor/maintenance fns referencing it (prune_flowty_archive_api_harvest, flowty_archive_insert_batch, extract_flowty_purchases, extract_flowty_offers; pg_depend + repo-grep verified no live consumers). Revert: structural re-create from repo migrations 20260512190000 / 20260517200000 / 20260517220000 (data accepted as unrecoverable).
2. SHIPPED: `audit_20260610_drop_marketplace_offers_2024_2025_partitions` — dropped the 2024 (201,189 rows / 65 MB) + 2025 (283,381 rows / 91 MB) partitions of the dead marketplace_offers pipeline. Parent + 2023/2026/default partitions untouched.
   RESULT: DB 6,897 MB → 4,166 MB (−40%). Security checks re-verified clean post-drop.
3. ALSO SHIPPED: `audit_20260610_pinnacle_listings_reconcile_statement_timeout_60s` — pinnacle_listings_reconcile() was the only pipeline SECDEF fn with no fn-level statement_timeout (inherited the 8s default → failed every tick under any IO pressure). 60s bound mirrors ~30 sibling fns; manual reconcile run then succeeded (293 editions re-asked) and pinnacle_ask_stale_hours BREACH cleared 8.0h → 0.0. Revert: ALTER FUNCTION public.pinnacle_listings_reconcile() RESET statement_timeout.
4. Load-side: the CC handoff items (wave stagger d198e68 etc.) shipped same day — see handoff doc.
5. Git durable fix ADOPTED: both scheduled-task prompts (nightly pass + daytime monitor) now use a sandbox-native clone (/tmp/rpc, pushurl harvested from the mount config) for ALL git ops — the mounted .git is never touched by git again. Effective from tonight's runs.
6. Watch: DB creep was +196MB/24h pre-drop; re-baseline at the next night pass.

Auditor: Cowork (Claude) interactive session, 2026-06-10 ~16:40–17:30Z.
