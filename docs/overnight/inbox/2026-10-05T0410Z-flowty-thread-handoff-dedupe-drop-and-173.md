# Handoff from Claude Code (cloud, Flowty thread) — 2026-10-04 ~9:10 PM PT

**Trevor, verbatim, 2026-10-04 ~9:10 PM PT: "Hand that off to cowork"** — "that" = the two SQL files below,
which were left for him to run in the Supabase SQL editor, plus the open #173. This filing is his
authorization for items 1 and 2 (they are destructive SQL, which the night pass otherwise queues and
never auto-ships). Item 3 is NOT authorized for shipping — investigate and file a plan.

Context: the Flowty / Dapper / Flowverse incorporation finished today (ledger 2026-10-04, entries
"Re-promotion DONE" … "Unresolved Flowty/Dapper sales closed out"). Every scratch pg_cron job is
unscheduled; the results live in `public.sales` (sources `flowty_chain_v1` / `flowty_chain_tx_v1` /
`dapper_chain_tx_v1`) and kept archive tables. Nothing below changes a route, code path or schedule.

## 1. Remove the 7 duplicate Top Shot sales — `scripts/flowty-export/dedupe_tx_lane_20261004.sql` (RUN FIRST)

- **What:** the walk lane and the mainnet24 tx lane once ran concurrently and wrote 7 sales twice (same
  transaction, nft, price, serial). The file keeps the walk row (`flowty_chain_v1`), deletes the tx-lane copy,
  and keeps a copy of each removed row in `flowty_archive.audit_20261004_tx_lane_dupes`.
- **Guarded:** it RAISES and rolls back unless it finds exactly 7. Re-verified 2026-10-04 ~9:05 PM PT: 7.
- **Pre-check (read-only):**
  `select count(*) from public.sales t where t.source='flowty_chain_tx_v1' and exists (select 1 from public.sales w where w.source='flowty_chain_v1' and w.collection=t.collection and w.transaction_hash=t.transaction_hash and w.nft_id=t.nft_id)` → **7**. Anything else: stop, do not edit the guard, file it.
- **Run:** the file verbatim (one `execute_sql`; it is a single BEGIN … COMMIT).
- **Post-check:** the pre-check query → **0**; `select count(*) from flowty_archive.audit_20261004_tx_lane_dupes` → **7**.
- **Revert:** `INSERT INTO public.sales SELECT * FROM flowty_archive.audit_20261004_tx_lane_dupes;`

## 2. Drop the scratch objects — `scripts/flowty-export/drop_scratch_20261004.sql` (AFTER item 1)

- **What:** 10 `flowty_archive.scratch_*` functions + 19 `flowty_archive.scratch_20261004_*` tables
  (drivers, probes, baselines; `scratch_20261004_cfg` holds the Firestore web key used by the harvest —
  dropping it removes it). Function bodies are preserved in `scripts/flowty-export/promote_tick.sql` etc.
- **Does NOT touch:** `public.sales`, `checkpoint_nft_meta`, `ufc_chain_set_editions`, the kept archive tables
  (`flowty_index_sales`, `flowty_chain_listing_completed`, `flowty_chain_walk_coverage`, `dapper_tx_candidates`,
  `mint_walk_coverage`, `sale_block_read_candidates`, `ufc_chain_named_promoted`) or any `audit_20261004_*` table
  (those are the revert paths — keep them).
- **Guarded:** it RAISES if any `cron.job` command still references a `flowty_archive` scratch object.
- **Pre-check:** `select count(*) from cron.job where command ilike '%flowty_archive.scratch%'` → **0**
  (do not echo `cron.job.command` itself — gate keys live there).
- **Run:** the file verbatim.
- **Post-check:** `select count(*) from pg_class where relnamespace='flowty_archive'::regnamespace and relname like 'scratch%'` → **0**;
  `select count(*) from pg_proc where pronamespace='flowty_archive'::regnamespace and proname like 'scratch%'` → **0**.
- **Revert:** none needed (scratch state; re-creatable from the preserved bodies).

Both: ⚠ an MCP `execute_sql` timeout does NOT mean the statement failed — re-run the post-check before
retrying anything. Log each in the ledger (date · what · revert) the same turn.

## 3. #173 — `topshot_moment_subeditions` holds conflated base editions (INVESTIGATE, do not ship)

- **Finding:** for a slice of Top Shot NFTs the table's `base_external_id` is a different set of the same
  player (nft 101628: chain `2:89` at spork roots 25/26/28, table `51:1804`). Checkpoint proven right:
  serial ≤ circulation 100 % vs ~82 %. 2 % sample: ≈0.2 % of checkpointed rows, all `resolved_at`
  2026-06-20 → 07-06; projected ≈1–1.5 k rows. Full text: `docs/reference/known-issues.md` #173.
- **Already mitigated:** the 782 sales it held back were inserted with the checkpoint edition
  (`scripts/flowty-export/promote_ckpt_over_conflated_local_20261004.sql`).
- **Wanted:** (a) the exact count (compare every row against the latest checkpoint record, in slices);
  (b) which writer produced the 06-20 → 07-06 rows and whether it can still (grep the WRITERS — `backfill-topshot-subeditions`,
  `sales-indexer`, `topshot-sales-history-backfill`, `ingest`, the `remap_topshot_*` functions); (c) what those rows
  already wrote downstream (`sales.edition_id`, `wallet_moments_cache.edition_key`). File the plan with numbers;
  the correction itself touches pricing-adjacent data and many readers, so it is Claude Code's or Trevor's to ship.

## ✅ RESOLVED — items 1 and 2 (Claude Code, Windows box, 2026-10-10 ~11:35 AM PT)

Pre-checks re-run live first: 7 duplicates, no audit table yet, 0 `cron.job` references, 19 scratch tables + 11 scratch functions, no view dependency, and no live function outside the scratch set naming a `scratch_` object. **Item 1** ran verbatim: the dupes check now reads 0, `flowty_archive.audit_20261004_tx_lane_dupes` holds 7 rows, none of their ids remain in `sales`, and the 7 `flowty_chain_v1` walk rows are kept. **Item 2** ran verbatim: 0 scratch relations, 0 scratch functions; the 8 kept tables (7 archives + the audit) are present, and the 1,769,301 promoted sales are untouched. The Firestore web key in `scratch_20261004_cfg` is gone with it. Item 3 (#173) was closed separately on 10-09.
