# Claude Code handoff — 2026-05-28 Cowork platform pass

Companion to `docs/audits/cowork-platform-pass-2026-05-28.md`. The Cowork session shipped 2 DB migrations live but can't push code (no sandbox git creds). This handoff covers the code-side follow-ups, in priority order.

Work direct-to-`main`, commit and push to `main`, no branches / no PRs per CLAUDE.md. Verify each item before moving on.

---

## Order of operations

Do these in the order listed. Items 1 and 2 are the actual fixes; item 3 is the deferred cleanup that should land after item 1.

1. **GQL editions writer — root cause of the TS UUID-dupe regression.**
2. **`/api/sentinel` + `/api/cron/stale-fmv-monitor` — shape mismatch with `health_check()`.**
3. **Re-merge the 6,949 TS UUID-keyed dupes** (deferred from Cowork because the merge is risky against a hot DB with active sales partitions).

Plus three follow-on items added by a 2nd-pass Cowork audit after the handoff was first written:

4. **Accelerate `fmv-recalc` AllDay coverage** (3,784 LOW editions stuck on `allday-gql-v1`).
5. **Add LOW→STALE downgrade to `fmv-recalc`** for zero-90d-sales editions (2,759 affected).
6. **Investigate the 382 catchable TS NO_DATA editions** with recent sales but no snapshot.

Full FMV diagnostic: `docs/audits/fmv-confidence-decomposition-2026-05-28.md`.

---

## Item 1 — Fix the GQL editions writer

**Why this is the headline.** The 2026-05-26 merge dropped TS editions 17,574 → 9,535. Between the merge and 2026-05-28 03:00 UTC, 6,409 new UUID-keyed TS edition dupes re-accumulated, plus ~30-50/day expected if the writer isn't fixed. The Cowork pass shipped a defensive trigger that catches the bypass pattern going forward (the UUID row's `set_id_onchain` / `play_id_onchain` are nulled when the canonical exists), but the *root* fix is in the writer.

### Bypass pattern (verified via timing analysis)

The GQL editions-catalog writer INSERTs a TS edition row with `set_id_onchain = NULL` and `play_id_onchain = NULL`. The trigger predicate `NEW.set_id_onchain IS NOT NULL AND NEW.play_id_onchain IS NOT NULL` is FALSE at INSERT time → trigger lets the row in. ~10 seconds later, the writer UPDATEs the row to populate the on-chain ids. The new trigger now neutralizes that UPDATE, but you still get an inert orphan UUID row.

### What to do

Find the writer that does this. Likely candidates (greppable patterns):

```bash
cd C:\Users\TDill\rip-packs-city

# The GQL editions-catalog path on the topshot-proxy /topshot route.
# Look for code that ingests `searchEditions` results and writes to editions.
grep -rln "searchEditions" app/api lib supabase/functions

# Look for ingest paths that insert into editions with external_id assembled
# from UUIDs (the dupes' external_id is `<uuid>:<uuid>`).
grep -rln "external_id" app/api lib supabase/functions | xargs grep -l "from(\"editions\")\|from('editions')"

# The May 26 handoff (`docs/handoff-2026-05-26b-remaining-work.md` Phase 1
# "GQL ingest writer" section) called out the same investigation:
#   "Find the route that writes UUID-keyed editions on the GQL editions-catalog
#    path. Switch it to upsert against the integer-keyed canonical when
#    set_id_onchain/play_id_onchain are known."
# That instruction was never executed.
```

The fix is to **resolve `set_id_onchain` / `play_id_onchain` BEFORE the INSERT** and either (a) upsert against the integer canonical via `external_id = format('%s:%s', set_id_onchain, play_id_onchain)`, or (b) drop the write entirely when the integer canonical already exists.

The GQL editions-catalog payload contains both the UUID identifiers (`setID`, `playID` as UUIDs in `searchEditions`) AND the on-chain integer ids (these come from a separate call — possibly the existing Cadence script path, or you may need to add one call to `topshot-proxy /topshot` resolving the UUID setID → integer set_id_onchain via the schema's set query). If the on-chain ids are not available cheaply at write time, batch-resolve them via a single `searchSets(byIDs)` lookup before the insert loop.

### Verify after deploy

```sql
-- After the fix is live, monitor new TS UUID-dupes for 24h.
-- Expectation: net delta ~0 (the trigger may still see attempted writes
-- and silently null the on-chain ids, but the row count should plateau).
SELECT COUNT(*) FROM editions
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND external_id !~ '^[0-9]+:[0-9]+$'
  AND created_at >= NOW() - INTERVAL '24 hours';
```

If this is < 100 (vs the current ~30-50/day baseline), the writer fix is working. Then move to Item 3 (cleanup the 6,949 existing dupes).

---

## Item 2 — Fix sentinel + stale-fmv-monitor route shape

**Why.** `Pipeline Sentinel` and `RPC Ops Monitor` GHA workflows are red on every run. They're loud-but-harmless (the routes crash before the Telegram notify path, so no Telegram spam), but the red GHA UI is constant noise.

### Root cause

`public.health_check()` returns:

```json
{
  "generated_at": "...",
  "pipelines": { "runs_24h": 8406, "errors_24h": 28, ... },
  "fmv": { "stale": 1673, "high_confidence": 423, ... },
  "collections": { ... },
  "users": { ... },
  "insider_signals": { ... },
  "telemetry": { ... },
  "db_size_mb": 5654
}
```

But `app/api/cron/stale-fmv-monitor/route.ts` reads:

```ts
data.fmv_pipeline.staleness_minutes     // not on the response
data.sales_pipeline.last_sale_at         // not on the response
data.data_integrity.orphaned_editions_ok // not on the response
data.database.size_mb                    // is `db_size_mb` instead
data.database.rls_coverage_pct           // not on the response
```

Route throws → HTTP 500 → GHA exits 1 with `::error::Health check returned HTTP 500`.

`app/api/sentinel/route.ts` is a separate set of 6 checks (Sales Ingest, FMV Freshness, FMV Confidence, Edition Coverage, Total Sales, Sniper Feed). It doesn't call `health_check()` directly. Verify by `curl`ing it with auth — likely cause is the Sniper Feed check returning 0 deals (current TS GQL path returns empty post the 2026-05-26 reframe) and tipping overall to CRITICAL.

### What to do

Pick one of two approaches:

**Sister RPC already shipped — use it.** The Cowork pass also shipped `sentinel_fmv_confidence_rows(p_collection_id uuid DEFAULT NULL)` (migration `audit_20260528_sentinel_fmv_confidence_rows_rpc`). It returns the row shape the sentinel route already expects (`TABLE(confidence text, count bigint)`) AND uses `DISTINCT ON (edition_id) ORDER BY computed_at DESC` semantics (latest-per-edition, not all-time-rows). Smoke-tested: 7 rows returning LOW 10,656 / NO_DATA 8,550 / STALE 1,675 / MEDIUM 900 / ASK_ONLY 559 / HIGH 423 / SALES_ONLY 403.

**Route change in `app/api/sentinel/route.ts`** (line 116): swap `.rpc("sentinel_fmv_confidence")` → `.rpc("sentinel_fmv_confidence_rows")`. The existing `.reduce()` / `.find((r) => r.confidence === "HIGH")?.count` shape will then work as-written.

The original `sentinel_fmv_confidence(p_collection_id uuid)` RPC has a different bug: it counts all-time `fmv_snapshots` history (324,255 rows; HIGH inflated to 9,389) instead of latest-per-edition. Probably worth leaving in place for any other consumer but swap the sentinel route to the new sister.

**For `stale-fmv-monitor`, Option A (cheap, surgical):** Update `app/api/cron/stale-fmv-monitor/route.ts` to read the current `health_check()` shape. The mapping:

```ts
// staleness_minutes — derive client-side; the RPC doesn't surface it.
//   Compute from `pipelines.success_pct_24h` AND `(SELECT MAX(computed_at) FROM fmv_snapshots)`
//   in a second query, OR add `fmv_staleness_minutes` to the health_check RPC body.
// last_sale_at — query `MAX(sold_at) FROM sales WHERE sold_at >= NOW() - 1 day` separately.
// orphaned_editions_ok — define what this means and either compute it inline or add to RPC.
// db_size_mb — already in the response at the top level, just `data.db_size_mb`.
// rls_coverage_pct — query `pg_tables WHERE rowsecurity IS FALSE` separately.
```

The cleanest read: most of these aren't time-critical and can be inlined as additional `supabase.rpc()` / `supabase.from()` calls. The route is rate-limited (every 30 min) so latency is fine.

**Option B (sturdier):** Add the missing fields to `health_check()` as a new top-level `compat` block, then update the route to read them. Pro: any other consumer of these fields also wins. Con: makes health_check slower if the new fields are expensive.

After whichever option, also debug `/api/sentinel`:

```bash
# Hit the route directly with auth and inspect the JSON.
curl -X POST https://www.rippackscity.com/api/sentinel \
  -H "Authorization: Bearer ${INGEST_SECRET_TOKEN}" \
  | jq '.checks[] | select(.status != "ok")'
```

For each non-OK check, fix the underlying signal OR adjust the threshold so a legitimately-empty state (e.g. Sniper Feed returning 0 TS deals because Flowty is gone) isn't flagged as CRITICAL.

### Verify

After deploy, the next `Pipeline Sentinel` and `RPC Ops Monitor` schedule runs should pass green. Watch `https://github.com/jamesdillonbond/rip-packs-city/actions` for the next 2-3 hourly runs.

---

## Item 3 — Re-merge the 6,949 TS UUID-keyed dupes

**Defer until Item 1 is verified.** Without Item 1, the dupes will just regenerate. With Item 1 + the new trigger, the dupes will plateau, making the cleanup one-shot durable.

### Protocol

Re-run the May 26 merge body against the smaller dupe count. Reference: `docs/audits/editions-merge-dry-run-2026-05-26.md` (the original repoint methodology) and the 11-chunk `wallet_moments_cache` migration sequence:

```
audit_20260526_merge_step1_*
audit_20260526_merge_step2_*
audit_20260526_merge_step3a_*  → step3f_wmc_chunk_01_hot through chunk_11_final
audit_20260526_merge_step3g_defensive_repoints_v2
audit_20260526_merge_step4_drift_repoint_and_delete
audit_20260526_merge_step5_drop_staging
```

For the re-run, the same dependent-table FK + collision map applies:

- `sales` (partitioned, NO ACTION) — repoint by `edition_id`
- `moments` — UNIQUE on `(edition_id, serial_number)` — collisions to dedup-then-repoint
- `fmv_snapshots` (partitioned, NO ACTION) — repoint
- `price_snapshots` (partitioned, UNIQUE collisions possible) — dedup-then-repoint
- `pack_drop_pool` (SET NULL, PK includes edition_id) — repoint, may collide intra-dupe
- `wallet_moments_cache` (text `edition_key` join) — rewrite key, chunked to avoid txn timeouts
- `badge_editions` (text `external_id` join) — rewrite + collision delete (143 the first time)

Use `mcp__24ab6d77-3292-4646-b039-669cc9535ef8__apply_migration` per chunk. Don't `mcp__24ab6d77-3292-4646-b039-669cc9535ef8__execute_sql` for the big ones — it has a ~700k row tx-size cap (memory `mcp-execute-sql-tx-size-cap`).

### Pre-flight

Re-do the §2 dry-run on the current dupe count (6,949 vs the original 8,579) to confirm the dependent-table shape hasn't changed materially. Per memory `verify-rowcount-before-destructive-db-ops`, `SELECT count(*)` before every UPDATE/DELETE in each chunk.

### Verify after

```sql
-- Expect ~9,067 TS editions (≈ 8,995 integer canonical + 72 UUID-only orphans
-- with no integer-canonical pair, untouched by the merge).
SELECT count(*) FROM editions
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';

-- Expect 0 dupes that collide with an integer canonical.
SELECT count(*) FROM editions e1
WHERE e1.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND e1.external_id !~ '^[0-9]+:[0-9]+$'
  AND e1.set_id_onchain IS NOT NULL
  AND e1.play_id_onchain IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM editions e2
    WHERE e2.collection_id = e1.collection_id
      AND e2.external_id ~ '^[0-9]+:[0-9]+$'
      AND e2.set_id_onchain = e1.set_id_onchain
      AND e2.play_id_onchain = e1.play_id_onchain
  );
```

---

---

## Item 4 — Accelerate `fmv-recalc` AllDay coverage

3,784 AllDay editions are currently LOW on `allday-gql-v1` (marketplace-GQL-derived). They've never been reprocessed by `fmv-recalc` 1.7.0 because the sweep is moving but slowly across AllDay (2,362 writes/24h vs 7,958 for TS).

### What to do

Two non-exclusive options:

(a) **Round-robin the sweep** — `fmv-recalc` route should sample editions evenly across collections instead of paginating by `edition_id` (which de facto biases to TS because TS has the most rows). If the route already does collection-fair sampling, this isn't needed.

(b) **Bump `DEFAULT_LIMIT` for AllDay-only runs.** Add a parameter or run a dedicated daily AllDay sweep (`?collection=nfl_all_day&limit=5000`).

Expected outcome based on TS's 1.7.0 distribution (366 HIGH / 727 MEDIUM / 5,795 LOW = HIGH+MED 16% of priced rows): if AllDay's 4,839 LOW pool follows the same ratio after full 1.7.0 re-eval, **~770 of those would promote to MEDIUM or HIGH**.

---

## Item 5 — Add LOW→STALE downgrade to `fmv-recalc`

2,759 LOW editions (1,929 AllDay + 830 TS) have zero 90-day sales. They keep getting written LOW by `fmv-recalc` because the route's confidence logic doesn't downgrade based on recency.

### What to do

In `lib/fmv-confidence.ts` (or wherever the confidence assignment lives), add a recency gate above the LOW write:

```ts
// Pseudocode — apply before the existing LOW assignment
if (daysSinceLastSale > 60 && sales90d === 0) {
  return { confidence: 'STALE', algo_version: '1.7.0' };
}
```

The existing `cold-tail-stale-repair-1.0` writer already does this for editions that haven't been snapshotted in 7 days; the new gate brings the same logic into the main `fmv-recalc` path so freshly-snapshotted dead editions are honestly downgraded.

This is a quality improvement, not a quantity improvement — it moves 2,759 editions from "we say it's LOW but actually we have no idea" to "we honestly say STALE."

---

## Item 6 — Investigate 382 catchable TS NO_DATA editions

There are 382 TS editions currently NO_DATA that DID sell in the last 180 days. They should have a snapshot. Either `fmv-recalc` is skipping them (cursor or pagination gap) or `drain-fmv-cold-tail` is failing on them.

### What to do

Pick a sample:

```sql
WITH latest AS (
  SELECT DISTINCT ON (edition_id) edition_id, confidence
  FROM fmv_snapshots ORDER BY edition_id, computed_at DESC
),
sales180 AS (
  SELECT edition_id, COUNT(*) AS n, MAX(sold_at) AS last_sale
  FROM sales WHERE sold_at >= NOW() - INTERVAL '180 days' GROUP BY edition_id
)
SELECT e.id, e.external_id, e.player_name, e.set_name,
       s.n AS sales_180d, s.last_sale
FROM editions e
JOIN latest l ON l.edition_id = e.id AND l.confidence = 'NO_DATA'
JOIN sales180 s ON s.edition_id = e.id
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
ORDER BY s.n DESC LIMIT 25;
```

Then trace one through `/api/fmv-recalc` manually with `?edition_id=<id>` (if the route accepts that) and see which step bails.

---

## Constraints (read before starting — same as the 2026-05-26 handoff)

- Work direct-to-`main`. No feature branches, no PRs (CLAUDE.md).
- Do NOT reintroduce the cart / in-app buy (memory `intelligence-first-decision`).
- Do NOT mention or prioritize the Pro paywall (memory `no-paywall-until-traction`).
- Do NOT reach out to Austin Kline / Flowty (memory `no-austin-kline-outreach`).
- `pipeline_runs` columns: `started_at` / `finished_at` are NOT NULL; `duration_ms` is GENERATED — never write it (memory `pipeline-runs-crash-logger`).
- A function exported from `'use client'` cannot be CALLED from a server component — it can only be JSX-rendered (memory `rsc-client-function-call-crash`).
- Cowork Glob/Grep without an explicit path searches scratchpad, not the repo — always pass `path=C:\Users\TDill\rip-packs-city` (memory `cowork-glob-grep-default-dir`).
- After each migration, count(*) before destructive ops (memory `verify-rowcount-before-destructive-db-ops`).
- Verify DB end-state, not the pipeline ack (memory `rpc-silent-failure-class`).
- `execute_sql` chokes around ~700k-row transactions; use `apply_migration` or chunk further (memory `mcp-execute-sql-tx-size-cap`).

---

## Quick-reference state after Cowork pass

- `get_pipeline_alerts()` is empty.
- `editions_block_topshot_uuid_dupe_trg` is now `BEFORE INSERT OR UPDATE`.
- `unmapped_sales` open count: 11 (10 nflallday v1_tx_decode_budget_exhausted + 1 laligagolazos v2_dapper).
- 49 flowty archival `unmapped_sales` rows are retired with `resolution_hint.retire_reason = 'flowty_marketplace_archived_2026_05_13'`.
- TS editions: 15,946 total / 8,997 integer canonical / 6,949 UUID dupes (deferred cleanup).
- fmv-recalc is healthy: 150 runs/24h, 0 fails, 11,798 editions recalc'd in last 24h.
- Latest production deploy: `df2467aa9df6e164e083bff97d4679bfae3be033` (READY).

---

## Append to CLAUDE.md after shipping

Add the following entry under "## Recent sessions" at the top of `CLAUDE.md`:

```markdown
### May 28, 2026 — Cowork DB session: TS UUID-dupe trigger gap + sentinel RPC + Flowty unmapped_sales retire

DB-side Cowork session. Three migrations applied live.

Shipped live

- **`audit_20260528_editions_block_topshot_uuid_dupe_cover_update`** — extended the dupe-block trigger from `BEFORE INSERT` to `BEFORE INSERT OR UPDATE`. Root cause discovery: 6,409 new UUID-keyed TS edition dupes accumulated between the 2026-05-26 merge (which got TS to 9,535) and this session. 4,250 (66%) matched the bypass pattern INSERT-with-NULL-onchain-ids → UPDATE-backfills-ids within 1 minute. The trigger gates on `set_id_onchain IS NOT NULL AND play_id_onchain IS NOT NULL`, so at INSERT time it's FALSE and the row lands; never fires on UPDATE. New trigger nulls the on-chain ids back on UPDATE-match, leaving the row but inert. Real fix is the GQL writer (handed off). 6,949 existing UUID dupes deferred to a follow-up merge.
- **`audit_20260528_unmapped_sales_retire_archival_flowty_rows`** — retired 49 archival `unmapped_sales` rows where `marketplace='flowty'` (2026-04-17 → 2026-05-13). Flowty marketplace shut down 2026-05-13 and no resolver path operates on `marketplace='flowty'` anymore. Open backlog 60 → 11.
- **`audit_20260528_sentinel_fmv_confidence_rows_rpc`** — new `sentinel_fmv_confidence_rows(p_collection_id uuid)` RPC returning `TABLE(confidence text, count bigint)` based on `DISTINCT ON (edition_id) ORDER BY computed_at DESC`. The existing `sentinel_fmv_confidence` RPC has two bugs: returns a single JSONB object (not the row array the route expects) AND counts all-time `fmv_snapshots` history (324k rows; inflates HIGH to 9,389) instead of latest-per-edition (423). New sister RPC matches the route's shape and semantics — `app/api/sentinel/route.ts` just needs to swap the RPC name.

FMV diagnostic finding: HIGH peaked at 704 on 2026-05-24 then dropped to 423 today. Looks alarming — actually 203 of the lost editions were on the retired `sales_wap_v1` rogue inflated-AVG algo, so the drop is honest de-inflation. Honest baseline post-clobber-purge is ~501; current 423 is 84% of that. The remaining gap is the 2026-05-26 TS UUID-merge changing sale populations for canonicals. Pinnacle is the FMV quality leader at 53.6% HIGH (vs TS at 2.3% HIGH). Full decomposition in `docs/audits/fmv-confidence-decomposition-2026-05-28.md`.

Edge-function + cron retirement audit confirmed already-clean: all Flowty pipelines stopped 2026-05-24 (cron-job.org cleanup ran during the 2026-05-24 handoff); `topshot-listings-indexer` retired 2026-05-26. Dormant edge functions on Supabase are sleeping idle code, zero ongoing cost.

Full session report: `docs/audits/cowork-platform-pass-2026-05-28.md`. Code-side handoff: `docs/handoff-2026-05-28-cowork-pass.md`. FMV decomposition: `docs/audits/fmv-confidence-decomposition-2026-05-28.md`.
```

End. Ship Item 1 first.
