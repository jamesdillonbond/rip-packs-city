# AllDay serial-FMV parity — STATUS (mostly SHIPPED 2026-07-10) + code remainder

## What Cowork shipped live this session (DB-only, verified)
The TS serial-FMV fit functions were already collection-generic (`p_collection_id` param, scoped delete+insert, no TS hardcode). So parity was mostly a matter of running + scheduling them for AllDay:

- **Ran** `compute_serial_fmv_multipliers('dee28451…')` → **30 AllDay rows, 20 reliable** (first serial ~10–11×, perfect ~3.2–3.7×, low COMMON/UNCOMMON ~3×, normal 1.0×). `compute_serial_fmv_power_model('dee28451…')` → 2 rows, both correctly `is_reliable=false` (AllDay has too few #1/perfect sales; the flag prevents misuse). TS rows untouched (58 mult / 5 power).
- **Scheduled weekly** (`audit_20260710_allday_serial_fmv_weekly_refresh`): pg_cron `rpc-allday-serial-fmv-multipliers` (Sun 11:15) + `rpc-allday-serial-fmv-power-model` (Sun 11:20), staggered off the TS 11:00 fits.
- **Verified live:** `serial_fmv_estimate('dee28451…', 1, 899, 'RARE', 149.83, 'MEDIUM')` → `{estimate_usd: 1648.13, multiplier: 11, label: "estimated #1 premium"}`. `get_moment_detail` calls the estimate **generically** and `SERIAL_FMV_PUBLIC=true` globally, so **AllDay moment pages now render the SPECIAL SERIALS section** (confirmed on /moment/6906966 — #1 + Perfect Serial rows present). `check_secdef_anon_execute_violations()` []. TS regression: none.

Revert (if ever): unschedule the two crons + `DELETE FROM serial_fmv_multipliers/serial_fmv_power_model WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'`.

## Code remainder (CC — the DB layer is done, these surface/extend it)

### 1. Sniper-feed AllDay serial-FMV badges (LOW, additive)
`app/api/sniper-feed/route.ts` `attachSerialFmvEstimates()` is hardcoded TS: `const TS_COLLECTION_ID_FOR_SERIAL = "95f28a17…"` + `d.source === "topshot"` filter. AllDay deals never get a serial-FMV badge even though the model now exists. Extend it to pass each deal's own collection_id (AllDay deals carry `source` "flowty"/on-chain — key off the deal's collection, not source==topshot). Additive-only (never touches adjustedFmv/discount/ranking, same as the TS path). Verify an AllDay #1/perfect deal shows the badge.

### 2. `refresh-serial-fmv-multipliers` route TODO now redundant
`app/api/cron/refresh-serial-fmv-multipliers/route.ts:18` has "add an AllDay pass here". That's now covered by the pg_cron above. Either leave the pg_cron as-is (simplest) or move the AllDay pass into the route and unschedule the pg_cron — don't run both. Recommend: leave pg_cron, delete the TODO comment.

### 3. Jersey-match leg — ✅ SHIPPED 2026-07-11 (CC `0823e21` + `backfill_allday_edition_jersey` RPC). `editions.jersey_number` backfilled 0 → 5,468/6,190 from the Atlas `editionTemplate.metadata.playerNumber` field (it WAS there — no new egress). Immediate residential Atlas walk populated the DB; the badge ingest route + script now keep it fresh. Jersey-match row verified live (JuJu Smith-Schuster #19 → serial 19). Original task below for reference.

### 3 (original). Jersey-match leg — AllDay `editions.jersey_number` still 0/6,190 (residential ingest — the one true blocker)
The SPECIAL SERIALS section shows #1 + Perfect for AllDay, but NOT the **jersey-match** row (TS shows it) because `jersey_number` is null for all AllDay editions. No jersey source exists in the DB (verified: not on editions/wmc/badge_editions, not parseable from name). Source is the AllDay moment metadata trait, reachable only on the **residential path** (consumer GQL WAF-blocks Vercel + the topshot-proxy worker). **First step:** check whether the Atlas AllDay editions API (`scripts/ingest-allday-badges.mjs` source, run by the "RPC AllDay Badge Ingest" Task Scheduler job) returns a jersey/uniform field — if so, extend that residential ingest to also upsert `editions.jersey_number` (cheapest, no new egress). Once populated, the jersey-match row appears automatically (the moment page already renders it generically). Density note: ~755–913 AllDay editions are liquid enough (≥20 sales) for the serial fit to matter, so prioritize jersey coverage on that liquid set.

## Guardrails
Direct to `main`, no branches/PRs. PowerShell `git`; verify `git rev-list --count origin/main..HEAD`=0. `npx tsc --noEmit`; Vercel READY + smoke. Residential ingest edits touch the home-machine Task Scheduler flow (now S4U/logoff-durable) — coordinate with `scripts/*allday-badge*`.

## Expected end state
AllDay serial-FMV **already live on moment pages**; remaining = sniper-feed badges (small) + jersey-match via the residential jersey_number ingest. Trust 16/16, security 0/0/0/0.
