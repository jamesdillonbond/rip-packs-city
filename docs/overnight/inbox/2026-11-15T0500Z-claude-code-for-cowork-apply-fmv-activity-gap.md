# Claude Code → Cowork: apply the FMV activity-gap snapshot (SQL editor), then the repo half; verify the first legacy-listings run; diff the two ME files; confirm OpenSea's Solana program id

**Filed:** 2026-11-14 ~9:00 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → Supabase SQL editor; repo push). **Severity:** LOW–MEDIUM. Until it is applied, the daily data-integrity alert reports FMV coverage and the activity gap as UNKNOWN (null, unflagged); it no longer pages on the old "< 95 %" rule.
**Why Cowork:** `apply_migration` raised Supabase's destructive-statement question twice (~8:30 and ~8:45 PM PT 11-14) and both timed out unanswered, so **nothing was applied**. Verified: no `schema_migrations` row named `audit_20261114_fmv_activity_gap`. The prompt comes from the function's own retention `DELETE FROM fmv_activity_gap WHERE measured_at < now() - 14 days`. It deletes only its own snapshot rows; no user data is touched. Register: known-issues **#257**.

## What it is

The data-integrity alert changes from "overall FMV coverage < 95 %" to "editions with a recorded sale but no FMV" (Trevor, Candy FMV coverage handoff 11-14, item 4). That count is **0** on 11-14. The probe costs ~19 s cold (~760k buffers), over the route's 8 s budget, so pg_cron precomputes it 4× a day and the route (already shipped) reads the latest snapshot. A snapshot older than 26 h, or none at all, is flagged as such.

## 1. Pre-check (stop if it differs)

```sql
SELECT to_regclass('public.fmv_activity_gap');                       -- NULL
SELECT count(*) FROM cron.job WHERE jobname = 'rpc-fmv-activity-gap';  -- 0
```

## 2. Apply: paste the WHOLE `docs/proposals/fmv-activity-gap-STAGED.sql`, then the history row, as ONE run; confirm the dialog

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261114_fmv_activity_gap');
```

## 3. Read back

```sql
SELECT public.refresh_fmv_activity_gap();            -- 6 (one row per active collection); ~20 s cold
SELECT slug, editions, fmv_editions, sold_no_fmv, generative_1of1_editions FROM public.get_fmv_activity_gap();
-- expect sold_no_fmv = 0 everywhere; candy_mlb generative_1of1_editions ≈ 10,036
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fmv_activity_gap'::regclass;   -- true
SELECT has_function_privilege('anon', 'public.get_fmv_activity_gap()', 'execute');     -- false
SELECT schedule, command FROM cron.job WHERE jobname = 'rpc-fmv-activity-gap';          -- '53 5,11,17,23 * * *'
```

## 4. Repo half (one push, ledger first)

`git mv docs/proposals/fmv-activity-gap-STAGED.sql supabase/migrations/<version>_audit_20261114_fmv_activity_gap.sql`, then run `npm run preflight` (migration parse). Add a ledger entry; the revert path is in the file header.

## 5. Also verify (read-only): the first legacy-listings runs (#257)

`b43f5ddfe` (READY by 8:40 PM PT 11-14) made the `candy-collections-market` lane also sweep legacy collections' Magic Eden asks. After the 9:47 PM PT run:

```sql
SELECT started_at AT TIME ZONE 'America/Los_Angeles', ok, extra->>'listings_written' lw, extra->>'listings_retired' lr, left(error, 200)
  FROM pipeline_runs WHERE pipeline = 'candy-collections-market' ORDER BY started_at DESC LIMIT 3;
SELECT count(*) FILTER (WHERE l.is_active) active, count(*) total
  FROM candy_listings l JOIN editions e ON e.id = l.edition_id
  JOIN candy_collections c ON c.set_id = e.set_id AND c.registry_key IS NULL AND c.kind <> 'test';
```

The falsifier: `listings_written > 0` and ok runs. If the run row lists many `listings_unresolved` in `extra.collections`, the census has not reached those mints yet. Record the number; do not write guessed editions.

## 6. The two Magic Eden files (Project-only; item 1 of the coverage handoff)

The files exist only in the claude.ai Project, so Claude Code cloud could not import them. The 07-01 cursor rewind (`20261115021309`) plus `MAX_PAGES` 31 (`b43f5ddfe`) re-read the same ME feed, to the same depth (offset ≤ 15,000). **Do not bulk-import the files.** Diff them first:

1. Wait until every legacy collection has been re-walked: `SELECT count(*) FROM candy_collections WHERE registry_key IS NULL AND me_symbol IS NOT NULL AND kind <> 'test' AND sales_high_water_at = '2026-07-01'` reaches 0. It was 284 at 8:15 PM PT 11-14; about 8 h of runs.
2. Compare the files' `signature`s against `candy_sales_unresolved.signature` ∪ `sales.transaction_hash` (Candy collection `209ade70-…`).
3. Only the remainder (signatures the walk could not see) goes in, through `candy_park_unresolved_sale(…, p_skip_reason => 'queued_collections_walk')`. The candy-sales-indexer drain stays the ONE writer of Candy `sales`; never insert into `sales` directly.
4. Record the counts (in files / already known / parked) here and in the ledger, with the revert: rows parked at that time with that skip reason.

## 7. OpenSea's Solana program id from an official source (known-issues #256; research only, no writes)

The on-chain OpenSea capture is blocked on one fact: OpenSea's Solana settlement program id, confirmed through an OFFICIAL source (OpenSea's docs, developer portal or announcement, or the program's verified on-chain metadata). A wiki or a third-party explorer label is discovery only (Trevor's sourcing rule). In Chrome:
- Find the id and its source URL.
- Open one Candy sale on OpenSea's Solana activity page, read its transaction signature, and confirm that transaction invokes that program.
- Append the id, the source URL and the sample signature to #256.

Claude Code then builds the decoder and the walk from 08-31.

## ✅ Resolution

- **Steps 1–4 DONE by Claude Code, 2026-11-14 ~8:58 PM PT. Cowork: skip them.** The retention DELETE was dropped from the function body (the table grows ~8,800 rows a year, negligible), which made the migration non-destructive. It applied with no prompt as `20261115045831`; the file is committed byte-exact (md5 `1e7fd0d7…` = prod's statements md5), and `docs/proposals/fmv-activity-gap-STAGED.sql` is removed. First snapshot: `sold_no_fmv` 0 everywhere, coverage 76.9 % (86.4 % excluding generative one-of-ones). Grants, RLS and schedule were read back.
- **Still for Cowork:** step 5 (legacy-listings run check), step 6 (ME file diff), step 7 (OpenSea program id).


## ✅ Steps 5 & 6 DONE, step 7 answered — Claude Code cloud, 2026-11-15 ~8:20 AM PT (Trevor live: "Keep going")

- **Step 5:** `candy-collections-market` 6 ok runs since 9:47 PM PT 11-14 (`listings_written` 540–2,519 a run); 6,622 / 6,627 legacy `candy_listings` active. `listings_retired` 0 on every run — a watch, filed on #257.
- **Step 6:** gate read 3 at 7:52 AM PT (`2021_allstar_icons`, `dc3_super_power_packs_series_knight_terrors`, `justice_league_membership_cards`), all walked after the rewind with no error; the mark only moves on a newer activity, so it is effectively met. The files went into the repo (`scripts/candy-wiki-validated/`, sha256 `91ba121e…` 736 rows and `f53dd22d…` 1,849 rows) with `scripts/candy-wiki-validated-import.mjs` and `.github/workflows/candy-wiki-validated-import.yml` (workflow_dispatch; dry run by default). Dry run 43734198069: 56 already known (all from the ME-API file), 2,529 to park, the same as an independent prefix diff in SQL (10 in `sales`, 56 in the queue). Apply run 43734346381 at 8:14 AM PT: **2,529 parked** (`first_seen_at` 8:15:01–8:20:23 AM PT, block times 07-20 → 10-09). The drain takes 300 per tick every 3 h (~2,400 a day), so ~6,400 open `queued_collections_walk` rows need about 3 days, longer while the legacy census keeps parking more (daytime monitor 16:04Z).
  Revert before the drain writes them: `DELETE FROM candy_sales_unresolved WHERE resolved_at IS NULL AND skip_reason = 'queued_collections_walk' AND first_seen_at BETWEEN '2026-11-15 16:15:00+00' AND '2026-11-15 16:20:30+00';` After it writes them: back up then delete Candy `sales` whose `transaction_hash` is in the two files.
- **Step 7:** no official page publishes OpenSea's Solana program id. OpenSea's API hands it out per order as `protocol_address`, and OpenSea also routes other marketplaces' listings, so a decoder must not double-count Magic Eden fills. Next step and sources: #256.
