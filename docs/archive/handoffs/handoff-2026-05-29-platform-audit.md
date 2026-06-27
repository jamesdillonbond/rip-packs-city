# Claude Code handoff — 2026-05-29 platform audit (UPDATED 2026-05-30)

Owner: Trevor. Companion to the Cowork live dashboard `rpc-live-health` artifact.

This handoff was rewritten after a deeper investigation surfaced a **new high-impact bug** (fmv-recalc Step 6 self-perpetuating NO_DATA cycle) and after the Cowork pass shipped two DB-side migrations that resolve the connection-pool issue and the NO_DATA recovery. The remaining work is two code-side patches plus a small CLAUDE.md note.

## Shipped this pass (DB-only, durable, in production)

### -1. Research integration — squeeze view + cohort artifacts (2026-05-30 evening)

After Items 0–2 stabilized the FMV pipeline, ran a research-integration pass pulling in findings from the parallel "Flow collection research and strategy" thread (`docs/research/wallet-deep-dive-and-pack-strategy-2026-05-29.md` + `rpc-community-strategy-2026-05-29.md`).

DB-side:

- **`audit_20260530_topshot_squeeze_board_view`** — new public view `topshot_squeeze_board` ranking TS editions by effective-supply squeeze (lock + burn %). Joins `badge_editions` (hourly refresh) + `editions` + latest `fmv_snapshots`. Granted to anon so the planned `/insights/squeeze` page can read without auth (matches the research thread's no-auth-friction Week-1 launch guidance). Filtered to `squeeze_pct >= 50` (~3k row source → small result set). Sample top row: Alex Caruso "2025 NBA Playoffs: Legendary" at 156% squeeze (23 locked + 48 burned of 75 = 4 effectively buyable, FMV $765).

Cowork artifacts (live, persistent, re-query on open):

- **`rpc-my-wallet`** — Trevor's personal portfolio. Total moments / FMV per collection, confidence breakdown (moment-weighted, so the 89% LOW reality is honest), top 15 holdings, top 10 sets, tier mix, 24h FMV-write changes on held editions (silent-clobber detector), pack history via `get_wallet_pack_summary`. Wallet hard-coded to `0xbd94cade097e50ac`.
- **`rpc-cross-collection`** — surfaces the 143-wallet cohort holding 3+ Flow collections (per research: "RPC's natural intelligence-product audience"). Cohort distribution, top 20 multi-collection wallets with present-collections dots, TS set overlap (what the cohort actually collects).
- **`rpc-trophy-ladder`** — Supernova Ultimate ladder + top mint-#1 trophies + 1-of-1 editions, each row showing copies held in RPC tracked wallets. Surfaces the "First Mint" thesis the research thread flagged as empirically real (Jokić Base #1 → $9k in May).

These are complementary to the parallel research session's `/insights/squeeze` mockup work — squeeze data lives in the DB view; the dashboard surfaces what the research thread isn't building (personal wallet, cohort lens, trophy ladder).

### 0. Round-2 NO_DATA recovery + AllDay batched RPC + defensive temp drops

After Item A (Step 6 fix) shipped at `14ae144` and verified, a residual tail of 44 TS editions remained stuck at NO_DATA — these had been promoted by recovery #1 below, then re-clobbered by the still-buggy Step 6 in the ~3-hour window before Item A deployed. Round-2 recovery (`audit_20260530_recover_topshot_nodata_round2_post_step6_fix`) re-ran the same logic; Step 6 (now honest) doesn't re-clobber. Verification: `active_editions_stuck_at_nodata = 0`.

`audit_20260530_upsert_allday_marketplace_fmv_batched` — same shape rewrite as the TS one (Step 2 below), now applied to `upsert_allday_marketplace_fmv`. Also fixed a latent bug: the legacy function looked up existing confidence with `SELECT ... LIMIT 1` (no `ORDER BY computed_at DESC`), so it could read an arbitrary partition row and clobber a real HIGH/MEDIUM with `allday-gql-v1` LOW. 9 such clobber events observed in last 7d.

`audit_20260530_upsert_marketplace_fmv_defensive_temp_drops` — added `DROP TABLE IF EXISTS` before each `CREATE TEMP TABLE ON COMMIT DROP` in both RPCs so consecutive calls in one transaction (smoke testing, future BEGIN/COMMIT wrappers) don't hit "relation already exists." Production was unaffected (supabase-js `rpc()` is autocommit) but the guard is cheap insurance.

### 1. `audit_20260530_recover_topshot_nodata_with_recent_sales`

Inserted one fresh `1.7.0` snapshot for **146 Top Shot editions** that were perpetually labelled `NO_DATA` despite 30+ recent sales. 84 went to LOW, 62 to MEDIUM. Top Shot HIGH+MED count jumped 724 → 778 immediately.

Verification: every affected edition now reports correct sample size + fmv_usd. Spot check Chris Youngblood `042c8722-0e6e-44a1-a8de-ec19e790cbc3` (external_id `219:7853`): was NO_DATA daily-restamped since 2026-05-25 23:53; now MEDIUM $8.76 / 30 sales / days_since=4.

### 2. `audit_20260530_upsert_topshot_marketplace_fmv_batched`

Rewrote `upsert_topshot_marketplace_fmv(jsonb)` from a row-by-row PL/pgSQL loop into a 5-step set-oriented transaction. Same signature, same return shape `(upserted, skipped, no_edition)`. Same grants (postgres + service_role only).

Why: production logs show three runs in last 14 days at 113–295 s duration with `upserted=0` — pure connection-pool exhaustion under lock-hold. The old function did 4N SQL ops per call inside one transaction (~700 ops with a typical ~178-node batch). The DELETE additionally used `computed_at::DATE = CURRENT_DATE`, which is a non-sargable expression vs. the available `idx_fmv_snapshots_2026_edition_id_timezone_idx`, forcing partition scans per row.

New shape: parse jsonb → temp `_input_rows` → join `editions` once → LATERAL latest-confidence filter once → one batched DELETE (half-open range hits standard edition_id+computed_at index) → one batched INSERT. Reduces transaction ops from ~4N to ~5 regardless of N.

Smoke-tested live with empty + single-row payloads — return values match the legacy contract exactly. Should drop `topshot-fmv-populate` failure rate from ~30% to near-zero.

## Items remaining (code-side, can't ship from Cowork)

### Item A — fmv-recalc Step 6 pagination bug (HIGH PRIORITY)

**File:** `app/api/fmv-recalc/route.ts`, lines 745–832 (Step 6 — Stale freshness touch).

**Symptom:** Editions get stuck in self-perpetuating NO_DATA snapshots. Verified via Chris Youngblood snapshot history:

```
2026-05-25 19:03  HIGH  $7.66  (Step 1 wrote this)
2026-05-25 23:53  NO_DATA  ←  Step 6 wrote this
2026-05-26 23:53  NO_DATA  ←  Step 6 propagated the old NO_DATA
2026-05-27 23:53  NO_DATA
...
2026-05-30 03:23  NO_DATA  ←  current state pre-recovery-migration
```

**Root cause:** Step 6's staleness query filters BEFORE the `DISTINCT ON`:

```sql
SELECT DISTINCT ON (fs.edition_id) ...
FROM fmv_snapshots fs
JOIN editions e ON e.id = fs.edition_id
WHERE fs.computed_at < now() - interval '24 hours'   -- ← bug
  AND ...
ORDER BY fs.edition_id, fs.computed_at DESC
```

The intent was "find editions whose LATEST snapshot is >24h old". The actual semantics is "find every edition that has SOME snapshot >24h old, pick its newest pre-24h row, re-stamp THAT". For an edition with mixed-history (HIGH this week, NO_DATA last week), Step 6 picks the OLD NO_DATA and re-stamps it forward as a NEW NO_DATA. The skipSet at line 786 only excludes editions Step 1 wrote in the SAME TICK; the next cron with cursor past finds the old NO_DATA and re-stamps again. Cycle is durable across cron ticks.

**Patch.** Two changes:

1. Compute the true-latest snapshot per edition FIRST, then filter to those whose latest is >24h old:

```sql
WITH latest AS (
  SELECT DISTINCT ON (edition_id)
    edition_id, collection_id, fmv_usd, floor_price_usd, wap_usd,
    wap_without_outliers, liquidity_rating, confidence::text AS confidence,
    ask_proxy_fmv, sales_count_7d, sales_count_30d, days_since_sale,
    computed_at
  FROM fmv_snapshots
  ORDER BY edition_id, computed_at DESC
)
SELECT l.*
FROM latest l
JOIN editions e ON e.id = l.edition_id
WHERE l.computed_at < now() - interval '24 hours'
  AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
  AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
LIMIT 1000
```

2. Skip propagating NO_DATA. Once Step 1 has gone silent on an edition for 24h and the latest snapshot is still NO_DATA, re-stamping doesn't add signal — it just preserves stale absence. Add `AND l.confidence <> 'NO_DATA'` to the WHERE. (Optional but defensive — without it the new query still won't re-cycle the old NO_DATA, but won't keep an edition fresh that legitimately has no signal either.)

**Verify after deploy:**

```sql
-- Should NOT increase from current ~6,200 over the next 7 days for actively
-- traded editions. Spot-check: latest snapshot per TS edition where
-- confidence='NO_DATA' AND sales_count(30d) >= 5.
WITH latest AS (
  SELECT DISTINCT ON (edition_id) edition_id, confidence
  FROM fmv_snapshots WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  ORDER BY edition_id, computed_at DESC
)
SELECT COUNT(*) FROM latest l
WHERE l.confidence='NO_DATA'
  AND (SELECT COUNT(*) FROM sales s
       WHERE s.edition_id=l.edition_id
         AND s.sold_at >= NOW() - INTERVAL '30 days'
         AND s.price_usd > 0) >= 5;
-- Today after the recovery migration: 0. Should stay near 0.
```

### Item B — TS GQL editions writer UUID fallback (DEFERRED, INERT-ONLY)

**File:** `app/api/ingest/route.ts`, `buildEditionKey` (lines 167–178) + the hydrate-at-insert path (lines 508–595).

**Symptom verified by live probe:** 5,067 UUID-keyed TS edition rows created per 48h. All inert (on-chain IDs null). Trigger blocks the dupe-canonical correctly, but bloat accumulates at ~73k rows/month.

**Root cause:** `searchMarketplaceTransactions` (the GQL query that drives `/api/ingest`) returns `tx.moment.set.flowId` and `tx.moment.play.flowID` as null for current marketplace sales. Direct curl against `public-api.nbatopshot.com` with the `searchEditions` query for the SAME (setUUID, playUUID) pairs DOES return the integer pair correctly:

```
set: { flowId: 32, flowName: "Cool Cats", flowSeriesNumber: 2 }
play: { flowID: "788" }
```

So the public-api has the data; the marketplace-transactions query just doesn't expose it. The hydration path (`hydrateTopShotEditions` → `fetchTsEditionMeta` → `searchEditions`) DOES retrieve the integer pair successfully — but the writer has already committed the UUID-pair external_id by the time hydration enriches the row.

**Patch.** In `buildEditionKey`: when `extractOnchainIds(tx)` returns null, call `fetchTsEditionMeta(setUUID, playUUID)` to resolve the integer pair before deciding the editionKey. Cache the result for the rest of the ingest tick to avoid double-fetching. If hydration also returns null, only THEN fall back to UUID-pair.

This is the same lever the 2026-05-28 fix attempted, but the prior fix only changed the field-request part of the GQL query — it didn't add the hydration-as-fallback. Without that fallback, every transaction where `tx.moment.set.flowId` is null still falls through to UUID.

**Defer rationale:** the rows are inert (trigger nulls them), no canonical corruption, no impact on user-visible FMV. The sentinel tripwire Trevor shipped (`9c4adb1`) is monitoring the leak rate. Ship this when convenient; not a fire.

### Item C — CLAUDE.md "Recent sessions" entry

Append at top of `## Recent sessions`:

```markdown
### May 30, 2026 — Cowork platform pass: FMV NO_DATA recovery, batched topshot-fmv-populate RPC, Step 6 bug identified

Two DB migrations shipped live; one route-code fix handed off; one code-side defer documented.

Shipped live:

- **`audit_20260530_recover_topshot_nodata_with_recent_sales`** — wrote a fresh 1.7.0 snapshot for 146 Top Shot editions that were perpetually labelled NO_DATA despite 30+ recent sales (84 LOW + 62 MEDIUM). TS HIGH+MED 724 → 778. Spot check: Chris Youngblood "Rookie Debut" (042c8722) was NO_DATA daily-restamped since 2026-05-25 23:53 → now MEDIUM $8.76 / 30 sales / 4d since.

- **`audit_20260530_upsert_topshot_marketplace_fmv_batched`** — rewrote `upsert_topshot_marketplace_fmv(jsonb)` from a row-by-row PL/pgSQL loop into a 5-step set-oriented transaction. Same signature + return shape + grants. Reduces transaction ops from ~4N to ~5 regardless of N. Fixes the three runs in last 14d that hit 113-295s `connection pool / statement timeout` failures. Smoke-tested live (empty + single-row payloads).

Open (route code):

- **fmv-recalc Step 6 pagination bug** — Step 6's WHERE filter runs BEFORE the DISTINCT ON, so it picks the newest >24h-old row per edition (which can be a stale NO_DATA) and re-stamps it as today. Creates self-perpetuating NO_DATA cycles on actively-trading editions. Fix: rewrite the query to compute latest-per-edition first, then filter; optionally skip NO_DATA propagation. Full patch in `docs/handoff-2026-05-29-platform-audit.md` Item A.

Deferred (route code, inert-only):

- **TS GQL ingest writer UUID fallback** — `searchMarketplaceTransactions` returns null for `tx.moment.set.flowId`/`play.flowID` (confirmed via direct public-api probe; `searchEditions` returns the same fields populated). The 2026-05-28 buildEditionKey fix changed the request fields but didn't add hydration-as-fallback. ~5k inert UUID rows / 48h still accumulating; trigger keeps them inert so no canonical corruption. Item B in the handoff.
```

## Tests after Items A + B ship

```sql
-- Item A: confirm Step 6 isn't re-creating NO_DATA on active editions
WITH latest AS (
  SELECT DISTINCT ON (edition_id) edition_id, confidence
  FROM fmv_snapshots WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  ORDER BY edition_id, computed_at DESC
)
SELECT COUNT(*) AS active_editions_stuck_at_nodata
FROM latest l
WHERE l.confidence='NO_DATA'
  AND (SELECT COUNT(*) FROM sales s
       WHERE s.edition_id=l.edition_id
         AND s.sold_at >= NOW() - INTERVAL '30 days'
         AND s.price_usd > 0) >= 5;
-- Expect 0 within 24h of Item A deploy.

-- Item B: confirm the writer leak rate drops
SELECT COUNT(*) AS inert_uuid_rows_last_hour
FROM editions
WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND external_id !~ '^[0-9]+:[0-9]+$'
  AND created_at >= NOW() - INTERVAL '1 hour';
-- Expect ~0 within 1 hour of Item B deploy.

-- topshot-fmv-populate failure rate (already shipped):
SELECT COUNT(*) FILTER (WHERE NOT ok) AS fails,
       COUNT(*) AS total,
       ROUND(100.0 * COUNT(*) FILTER (WHERE ok) / COUNT(*), 1) AS ok_pct
FROM pipeline_runs
WHERE pipeline='topshot-fmv-populate'
  AND started_at >= '2026-05-30 03:38:00+00';
-- Expect ok_pct >= 95% over the next 24h of cron ticks.
```

## What was misdiagnosed and corrected

- The original 2026-05-29 audit framed `topshot-fmv-populate` as a logging-flag bug. Trevor corrected: the `ok=false` runs carry real connection-pool errors. This pass addresses the root cause (the row-by-row RPC), not the flag.
- The original audit identified "382 catchable TS NO_DATA" as needing Step 5b coverage. That framing missed the deeper Step 6 self-perpetuating cycle — Step 5b can't reach editions whose latest snapshot is on `1.7.0` (its predicate is `NOT LIKE '1.7.%'`). The real lever was the Step 6 rewrite + a one-shot recovery for the affected editions.
- `snapshot-institutional-wallets` was framed as a function bug. Trevor's test confirmed it was two missed cron-job.org schedules. Not a code issue.
