# DUPE1 canonical-merge plan — GATED, do not execute before the gate clears

Prepared 2026-06-07 (Cowork daytime audit session). READ-ONLY dry-run complete; NO writes have happened. **EXECUTOR: Claude Code (Trevor's decision, 2026-06-07 evening).** Run the SQL via the Supabase MCP (apply_migration for each step, audit_YYYYMMDD_dupe1_* tags). Claude Code's direct inspection wins over this doc on any disagreement — re-verify every count before each destructive step.

GATE (check it yourself at execution time — BOTH required):
1. Sentinel TS-UUID-48h < 250 and not re-climbing (was 1,566 at 2026-06-07 ~22:30Z, decaying ~50-60/hr — expected to clear late 2026-06-08). Check: SELECT count(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id !~ '^[0-9]+:[0-9]+$' AND created_at >= now() - interval '48 hours'; A re-climb means the writer leak re-opened: STOP, re-diagnose, do not merge.
2. Trevor's go was given for gated execution on 2026-06-07 — no further approval needed once the sentinel gate clears, but ABORT and report if any dry-run count at execute time diverges wildly from this doc's numbers.

## What this cleans up

6,406 inert UUID-keyed TS editions (external_id !~ '^[0-9]+:[0-9]+$'), of which 6,382 were minted by the June 4-6 DUPE1 re-mint wave (only 24 predate June 4 — the old historical pile is already gone). The writer is fixed (uuid_fallback_keys=0 since 2026-06-06 15:39; trigger `editions_block_topshot_uuid_dupe_trg` holds inserts+updates inert), so this backlog is static and safe to merge once the sentinel confirms quiet.

## Dry-run results (measured 2026-06-07)

Mapping via the proven strict 5-field unique match (player_name + set_name + series + circulation_count + name, all IS NOT DISTINCT FROM, exactly one canonical int-keyed match — same method as the 2026-06-06 pool remap):
- UNIQUE map: 4,978 of 6,406 (78%) → merge these.
- Ambiguous (>1 canonical): 176 → leave inert, list in the report.
- No match: 1,252 → leave inert (no canonical sibling exists yet; they re-audit later or die with a future GQL-resolve pass).

Dependents of ALL 6,406 (counted live):
- sales: 3,728 rows → REPOINT to canonical (sales history feeds FMV; must move).
- moments: 478 rows → REPOINT.
- wallet_moments_cache: 460 rows (edition_key text match) → UPDATE edition_key to the canonical external_id.
- pack_drop_pool: 6,523 rows → DELETE the dupe-keyed rows outright (pools are delete-then-rebuilt per dist every EV tick; the v21 writer re-keys int-pair, so deleted rows regenerate correctly — do NOT bother repointing).
- fmv_snapshots: 8,660 rows → DELETE (bloat; canonical editions have their own real snapshots; never migrate dupe snapshots).
- badge_editions: 2 rows → DELETE (badge-sync regenerates int-keyed).
- user_wishlists / watchlist_items: CASCADE on edition delete (verify counts at execute time; expected ~0).

## Execution order (each its own apply_migration, audit_YYYYMMDD_dupe1_* names)

0. Re-run every dry-run count above at execute time (counts move; never trust this doc's numbers for the destructive steps — verify-rowcount rule).
1. Build mapping table `audit_dupe1_map_20260608` (dupe_id, dupe_external_id, canon_id, canon_external_id) from the strict 5-field unique match. Persist as a real table (it IS the backup of record for reverts).
2. Collision dry-runs (read-only, both classes per the merge playbook):
   a. sales dupe-vs-canonical: **PRE-MEASURED 2026-06-08 00:30Z = 666 collisions** (tx hashes recorded on BOTH the dupe and its canon — double-ingests from the pre-fix window). These 666 dupe-side rows must be DELETED, not repointed, BEFORE the repoint UPDATE or it violates the per-partition unique(transaction_hash). Re-measure at execute time; expect a similar number.
   b. intra-dupe: two dupes mapping to the same canon with the same transaction_hash — same treatment. The ad-hoc query times out without the map materialized; run it AFTER step 1 builds audit_dupe1_map (trivial with the map as a real table).
   c. wmc: UNIQUE(wallet_address, collection_id, moment_id) is untouched by an edition_key UPDATE — no collision class, but verify no wmc row would end with an edition_key that disagrees with its moment's canonical edition.
3. Repoint sales (UPDATE ... SET edition_id = canon WHERE edition_id IN (mapped dupes)), chunked if needed (~3.7k rows, single statement fine).
4. Repoint moments (~478), wmc edition_key (~460), then DELETE badge_editions dupe rows (2).
5. DELETE pack_drop_pool rows for mapped dupes (~most of 6,523).
6. DELETE fmv_snapshots rows for mapped dupes (~most of 8,660; partitioned — single DELETE by edition_id list is fine at this size, well under the ~700k MCP tx cap).
7. DELETE the 4,978 mapped dupe editions rows. SAME TRANSACTION as a drift sweep: re-run the mapping match for any dupe rows created between step 1 and now (concurrent-cron drift rule) — the trigger keeps new ones inert but they'd survive the delete and pollute counts.
8. Post-flight: sentinel count, security invariants, `SELECT count(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id !~ '^[0-9]+:[0-9]+$'` (expect ~1,428 = 176 ambiguous + 1,252 no-match + drift-window stragglers), spot-check 3 repointed sales price-join to canonical, pack_ev_latest avg coverage unaffected-or-up, and the rpc-tracked-fmv-confidence artifact still loads.

## Revert path

`audit_dupe1_map_20260608` holds every (dupe, canon) pair. Reverting = re-INSERT the deleted edition rows from a step-1 snapshot table (take `CREATE TABLE audit_dupe1_editions_backup_20260608 AS SELECT * FROM editions WHERE id IN (mapped dupes)` BEFORE step 7), then UPDATE sales/moments/wmc back via the map. fmv/pool/badge rows are regenerated by pipelines and need no revert.

## Explicitly NOT in scope

- The 176 ambiguous + 1,252 no-match dupes (inert, trigger-held; revisit only if a GQL UUID→int resolve pass is built).
- Any change to the writer/trigger (already correct).
- AllDay/Golazos/UFC/Pinnacle (TS-only problem).
