# Editions merge — dry-run findings + Phase 1 ship log

Date: 2026-05-26
Companion docs: [docs/handoff-2026-05-26-entity-pages-and-feeds.md](../handoff-2026-05-26-entity-pages-and-feeds.md) (the original §2 audit), [docs/handoff-2026-05-26b-remaining-work.md](../handoff-2026-05-26b-remaining-work.md) (the punch list that asked for this dry-run).

**Status: Phase 1 shipped 2026-05-26.** TS editions 17,574 → 9,535. Avdija Fresh Threads 2024-10-24 now renders Portland Trail Blazers (the headline win). See the §"Phase 1 ship log" section at the bottom for what actually happened during execution vs the Phase 0 plan — three new findings surfaced during the merge that weren't in the dry-run: a missed pack_drop_pool intra-dupe collision class, a parallel wrong-direction wmc canonicalize trigger, and concurrent-cron drift mid-merge.

## TL;DR

The Phase 0 dry-run **invalidates two of the §2b migration body's assumptions** and surfaces **two destructive tables missing from §2b's dependent-tables list**. The handoff prompt also predicted a `moments` UNIQUE-constraint drop as a blocker — that prediction is wrong; the existing UNIQUE works fine with a proper dedup-then-repoint pattern and dropping it would be incorrect.

What's actually needed:

1. **One prep migration** (not two): rewrite `badge_editions.external_id` for UUID-keyed TS rows to the canonical integer form, with a 143-row collision-delete pre-step.
2. **A rewritten merge migration** that fixes three things vs the §2b body:
   - drop the `UPDATE badge_editions SET edition_id` statement (column doesn't exist),
   - rewrite the `UPDATE wallet_moments_cache` statement to key on `edition_key` (column `edition_id` doesn't exist on wmc),
   - add `UPDATE moments` and `UPDATE price_snapshots` (both have FKs that block the final DELETE; both have UNIQUE collisions that need a dedup-delete pass first).
3. **Optional but recommended**: add the `editions_block_topshot_uuid_dupe` BEFORE INSERT trigger from §2d as a fifth step. The dupe count grew from 8,111 → 8,579 in the ~36 hours between the original audit and this dry-run, confirming the GQL writer is still adding new dupes.

There is no `moments` UNIQUE constraint to drop.

## Current state (verified against live DB)

| metric | value | drift vs original audit |
|---|---|---|
| Total TS editions | 17,574 | +468 (was 17,106) |
| Integer-keyed canonical | 8,995 | 0 |
| UUID-keyed dupes | 8,579 | +468 (was 8,111) |
| Pairs with both | 7,799 | 0 |
| Plays with multiple UUID dupes | 153 (up to 7 dupes/play) | new finding |

Post-merge expected TS edition count: ≈ 9,067 (8,995 canonical + 72 UUID-only orphans).

## Dependent-table FK + collision map (the actual blast radius)

Every public table with an FK to `editions(id)`, plus the row-count pointing at TS UUID dupes, plus the FK delete action:

| Table | Rows on dupes | FK action | In §2b? | Notes |
|---|---|---|---|---|
| `sales` (partitioned) | 251,411 | NO ACTION | yes | repoint OK, no UNIQUE collisions |
| `moments` | 181,259 | NO ACTION | **NO** | UNIQUE `(edition_id, serial_number)` — 727 collisions |
| `fmv_snapshots` (partitioned) | 125,447 | NO ACTION | yes | PK is `(id, computed_at)` — no edition_id collision |
| `price_snapshots` (partitioned) | 50,179 | NO ACTION | **NO** | UNIQUE `(edition_id, bucket, bucket_size)` — 1 collision |
| `pack_drop_pool` | 33,493 | SET NULL | yes | PK includes edition_id — 0 collisions |
| `wallet_moments_cache` | (joined via `edition_key` text — no FK) | — | yes (broken) | §2b refs nonexistent `edition_id` col |
| `badge_editions` | (joined via `external_id` text — no FK) | — | yes (broken) | §2b refs nonexistent `edition_id` col |
| `unmapped_sales` | (no FK) | — | yes | safe |
| `marketplace_offers` (partitioned) | 0 | NO ACTION | yes | safe today |
| `special_serial_holders` | 0 | CASCADE | yes | safe today; CASCADE risk if data grows |
| `special_serial_lookup_failures` | 0 | CASCADE | no | safe today |
| `user_wishlists` | 0 | **CASCADE** | no | **footgun**: silent user-data loss if data grows |
| `watchlist_items` | 0 | **CASCADE** | no | **footgun**: silent user-data loss if data grows |
| `cached_listings_v2` | 0 | NO ACTION | yes | safe today |
| `offers` | 0 | NO ACTION | no | safe today |
| `portfolio_moments` | 0 | NO ACTION | no | safe today |
| `trade_matches` | 0 | NO ACTION | no | safe today |
| `user_trade_offers` | 0 | NO ACTION | no | safe today |
| `topshot_insider_buybacks` | 0 | SET NULL | no | safe today |

The CASCADE on `user_wishlists` / `watchlist_items` is harmless today only because both have 0 rows pointing at TS dupes. If the merge slips by weeks while users start wishlisting, deleting a dupe edition would silently destroy the wishlist row. Either repoint those rows explicitly in the migration (treat them like any other dependent) or run the merge before user wishlists land — easiest fix is to add `UPDATE user_wishlists ... ; UPDATE watchlist_items ...` to the migration body even though today they're no-ops.

## Errors surfaced (verbatim, in order)

### Blocker #1 — badge_editions schema mismatch

```
ERROR: 42703: column b.edition_id does not exist
LINE 20: FROM ts_edition_merge m WHERE b.edition_id = m.dupe_id;
```

`badge_editions` joins to `editions` via `external_id` text, not by FK on a `edition_id` UUID column (the column simply doesn't exist).

Real shape of badge_editions: `id` (text PK, e.g. `"168+5766+0"`), `external_id` (text, e.g. `"168:5766"`), `set_id` (text, NULL for integer-keyed rows), `play_id` (text, NULL for integer-keyed rows), `parallel_id` (int), `collection_id` (uuid). UNIQUE on `(external_id, collection_id)`.

Current TS badge_editions distribution:
- 2,453 UUID-keyed rows (need rewrite)
- 143 of those collide with an existing integer-keyed badge_editions row on `(canonical_external_id, collection_id)` — must be deleted before rewrite
- 2,310 can be safely rewritten (`external_id` ↔ integer canonical, `set_id`/`play_id` NULL'd)

### Blocker #2 — wallet_moments_cache schema mismatch

```
ERROR: 42703: column w.edition_id does not exist
LINE 22: FROM ts_edition_merge m WHERE w.edition_id = m.dupe_id;
HINT: Perhaps you meant to reference the column "w.edition_key".
```

`wallet_moments_cache` only has `edition_key` (text). Per CLAUDE.md's wmc invariant, `edition_key` MUST equal `editions.external_id`. The §2b body's `UPDATE ... SET edition_id = ..., edition_key = ...` fails on the first SET clause. Correct shape:

```sql
UPDATE wallet_moments_cache w SET edition_key = mg.canonical_ext
FROM ts_edition_merge mg WHERE w.edition_key = mg.dupe_ext;
```

### Blocker #3 — moments UNIQUE collision

```
ERROR: 23505: duplicate key value violates unique constraint "moments_edition_id_serial_number_key"
DETAIL: Key (edition_id, serial_number)=(b8499a12-2b75-4033-a206-7c99c4b789f8, 1) already exists.
```

`moments` is missing from the §2b body entirely. After adding `UPDATE moments SET edition_id = mg.canonical_id`, the UNIQUE `(edition_id, serial_number)` collides on:

- 701 dupe-vs-canonical collisions (the canonical already owns the serial)
- 26 intra-dupe collisions (two different UUID dupes for the same play own the same serial — happens because 153 plays have ≥ 2 dupes, max 7)

Total: 727 of 181,259 dupe-side moment rows (0.4%) must be deleted before the repoint UPDATE. The remaining 180,532 can be repointed cleanly.

The handoff prompt's hypothesis was that this UNIQUE constraint needed to be dropped pre-merge. **It does not.** Dedup-then-repoint preserves the UNIQUE and keeps it intact for future data integrity. Dropping it would be the wrong fix.

### Blocker #4 — price_snapshots missing from §2b (would also FK-block DELETE)

50,179 rows pointing at TS dupes; UNIQUE `(edition_id, bucket, bucket_size)`; 1 collision. Same dedup-then-repoint pattern as moments.

### Blocker #5 — operational, not Postgres: transaction size

The full corrected dry-run (BEGIN…ROLLBACK across all 8+ UPDATE/DELETE statements touching ~700k rows total) timed out the Supabase MCP harness's `execute_sql` call. Not a SQL error — a harness timeout. The real migration must be applied via `apply_migration` (longer timeout) or chunked into per-table migrations applied in sequence.

## Migrations to write (corrected order of operations)

| # | name | what it does |
|---|---|---|
| 1 | `audit_20260526_badge_editions_drop_dupe_collisions_pre_ts_dedup` | DELETE the 143 UUID-keyed `badge_editions` rows that would collide with an existing integer-keyed sibling on `(external_id, collection_id)` |
| 2 | `audit_20260526_badge_editions_rewrite_external_id_to_canonical` | UPDATE the remaining 2,310 UUID-keyed badge rows: `external_id` ← canonical integer form, NULL the `set_id`/`play_id` text columns |
| 3 | `audit_20260526_merge_topshot_uuid_keyed_edition_duplicates` | The corrected merge — see body below |
| 4 | `audit_20260526_editions_block_topshot_uuid_dupe_trigger` | BEFORE INSERT trigger from §2d, verbatim from the original handoff |

There is **no** moments UNIQUE-drop migration. There is **no** moments partial-unique-add-back migration. The §2b body's "moments UNIQUE constraint drop" hypothesis is wrong — the constraint stays put through the merge.

### Corrected merge body (migration #3 above)

```sql
-- audit_20260526_merge_topshot_uuid_keyed_edition_duplicates

CREATE TEMP TABLE ts_edition_merge AS
WITH ts AS (
  SELECT id, external_id, set_id_onchain, play_id_onchain,
    (external_id ~ '^[0-9]+:[0-9]+$') AS is_integer_keyed
  FROM editions
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND set_id_onchain IS NOT NULL AND play_id_onchain IS NOT NULL
),
canonical AS (
  SELECT set_id_onchain, play_id_onchain, id AS canonical_id, external_id AS canonical_ext
  FROM ts WHERE is_integer_keyed
)
SELECT u.id AS dupe_id, u.external_id AS dupe_ext, c.canonical_id, c.canonical_ext
FROM ts u JOIN canonical c USING (set_id_onchain, play_id_onchain)
WHERE NOT u.is_integer_keyed;

-- Dedup moments: keep one row per (canonical, serial). Delete dupe-side moments that collide
-- with canonical OR with an earlier-id sibling dupe-side moment.
DELETE FROM moments m USING ts_edition_merge mg
WHERE m.edition_id = mg.dupe_id AND (
  EXISTS (SELECT 1 FROM moments c WHERE c.edition_id = mg.canonical_id AND c.serial_number = m.serial_number)
  OR EXISTS (
    SELECT 1 FROM moments m2 JOIN ts_edition_merge mg2 ON m2.edition_id = mg2.dupe_id
    WHERE mg2.canonical_id = mg.canonical_id AND m2.serial_number = m.serial_number AND m2.id < m.id
  )
);

-- Dedup price_snapshots same way.
DELETE FROM price_snapshots ps USING ts_edition_merge mg
WHERE ps.edition_id = mg.dupe_id AND (
  EXISTS (SELECT 1 FROM price_snapshots c WHERE c.edition_id = mg.canonical_id AND c.bucket = ps.bucket AND c.bucket_size = ps.bucket_size)
  OR EXISTS (
    SELECT 1 FROM price_snapshots ps2 JOIN ts_edition_merge mg2 ON ps2.edition_id = mg2.dupe_id
    WHERE mg2.canonical_id = mg.canonical_id AND ps2.bucket = ps.bucket AND ps2.bucket_size = ps.bucket_size AND ps2.id < ps.id
  )
);

-- Repoint dependent tables.
UPDATE moments m SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE m.edition_id = mg.dupe_id;
UPDATE price_snapshots ps SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE ps.edition_id = mg.dupe_id;
UPDATE sales s SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE s.edition_id = mg.dupe_id;
UPDATE fmv_snapshots f SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE f.edition_id = mg.dupe_id;
UPDATE wallet_moments_cache w SET edition_key = mg.canonical_ext FROM ts_edition_merge mg WHERE w.edition_key = mg.dupe_ext;
UPDATE pack_drop_pool p SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE p.edition_id = mg.dupe_id;

-- Defensive no-op repoints (today: 0 rows; future-proof against the CASCADE/NO-ACTION footguns).
UPDATE marketplace_offers o SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE o.edition_id = mg.dupe_id;
UPDATE special_serial_holders s SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE s.edition_id = mg.dupe_id;
UPDATE special_serial_lookup_failures s SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE s.edition_id = mg.dupe_id;
UPDATE cached_listings_v2 cl SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE cl.edition_id = mg.dupe_id;
UPDATE offers o SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE o.edition_id = mg.dupe_id;
UPDATE portfolio_moments p SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE p.edition_id = mg.dupe_id;
UPDATE trade_matches t SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE t.edition_id = mg.dupe_id;
UPDATE user_trade_offers t SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE t.edition_id = mg.dupe_id;
UPDATE user_wishlists w SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE w.edition_id = mg.dupe_id;
UPDATE watchlist_items w SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE w.edition_id = mg.dupe_id;
UPDATE topshot_insider_buybacks b SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE b.edition_id = mg.dupe_id;
UPDATE unmapped_sales u SET edition_id = mg.canonical_id FROM ts_edition_merge mg WHERE u.edition_id = mg.dupe_id;

-- Pull through richer fields from dupe into canonical (only fill NULLs).
UPDATE editions e
SET thumbnail_url = COALESCE(e.thumbnail_url, d.thumbnail_url),
    video_url     = COALESCE(e.video_url, d.video_url),
    badges        = COALESCE(e.badges, d.badges),
    reward_indicators = COALESCE(e.reward_indicators, d.reward_indicators),
    play_category = COALESCE(e.play_category, d.play_category),
    first_minted_at = COALESCE(e.first_minted_at, d.first_minted_at)
FROM ts_edition_merge mg JOIN editions d ON d.id = mg.dupe_id
WHERE e.id = mg.canonical_id;

DELETE FROM editions e USING ts_edition_merge m WHERE e.id = m.dupe_id;
```

If the transaction-size operational concern surfaces again at apply time, split this body into three sequential migrations: (a) all the dedup-DELETEs, (b) all the UPDATEs, (c) the pull-through + final DELETE. Each is independently safe to retry.

## Post-merge verification (run after migration #3)

```sql
-- Expect ~9,067 (down from 17,574)
SELECT count(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';

-- Expect 0
SELECT count(*) FROM editions
WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND external_id !~ '^[0-9]+:[0-9]+$'
  AND set_id_onchain IS NOT NULL AND play_id_onchain IS NOT NULL;

-- Spot check Avdija Fresh Threads — expect ONLY the integer-keyed row with team Portland Trail Blazers
SELECT id, external_id, team_name FROM editions
WHERE player_name='Deni Avdija' AND set_name='Fresh Threads' AND game_date='2024-10-24';

-- Expect 0 orphans
SELECT count(*) FROM sales WHERE edition_id NOT IN (SELECT id FROM editions);
SELECT count(*) FROM moments WHERE edition_id NOT IN (SELECT id FROM editions);
SELECT count(*) FROM fmv_snapshots WHERE edition_id NOT IN (SELECT id FROM editions);
```

## Findings vs the handoff prompt's hypotheses

| prompt prediction | actual finding |
|---|---|
| "badge_editions backfill required pre-merge" | TRUE, but in a different shape — backfill the `external_id` text column to canonical form (not a nonexistent `edition_id` UUID column) |
| "moments UNIQUE constraint drop" | **FALSE.** No constraint drop needed. Dedup-delete the 727 colliding rows first, then repoint. Keep the UNIQUE — it's a real invariant |
| Two prep migrations needed | One prep family (badge_editions: collision-delete + rewrite, can be a single migration or split) |
| Order of operations | See "Migrations to write" table above |

---

## Phase 1 ship log (what actually happened)

Phase 1 ran 2026-05-26 after user approval of the dry-run findings. Three things turned up at execution time that the Phase 0 dry-run did not surface; each required a halt + correction.

### Final state

| metric | before | after |
|---|---|---|
| TS editions total | 17,574 | **9,535** |
| TS UUID-keyed editions with canonical twin | 8,039 (mergeable) | **0** |
| TS UUID-only orphans (no canonical) | 72 + 468 fresh-GQL drift | 540 (intentionally retained — no merge target) |
| TS wmc rows in canonical integer form | 47,507 / 1,192,507 (4%) | **1,190,334 / 1,192,507 (99.8%)** |
| Avdija Fresh Threads 2024-10-24 team | Philadelphia 76ers ❌ | **Portland Trail Blazers ✅** |
| sales / moments / fmv_snapshots / price_snapshots / pack_drop_pool / special_serial_holders orphans | n/a | **0** |

The 540 UUID-keyed editions still in the table are out-of-scope (no canonical twin to merge into). The §2d trigger is now in place, so the GQL writer can no longer add UUID-keyed editions for plays that already have an integer canonical.

### Migrations applied (in execution order, all on `main`)

1. `audit_20260526_badge_editions_prep_for_ts_dedup` — folded collision-delete (158 rows: 143 canonical-collision + 15 intra-dupe-loser) + UPDATE rewrite (2,295 rows) into one prep migration.
2. `audit_20260526_merge_step1_create_staging` — persistent `public._ts_edition_merge_staging` table (8,039 rows; PK `dupe_id`, indexed `canonical_id` + `dupe_ext`).
3. `audit_20260526_merge_step2_dedup_deletes` — moments + price_snapshots collision-delete (727 + 1 rows).
4. `audit_20260526_merge_step3a..d` — UPDATE moments / sales / fmv_snapshots / price_snapshots (each its own migration).
5. `audit_20260526_merge_step3e_pre_dedup_pack_drop_pool` — **NEW FINDING** (see §"Surprise A" below). 72 intra-dupe pack_drop_pool rows deleted, keep-max-weight-per-canonical/dist/slot.
6. `audit_20260526_merge_step3e_repoint_pack_drop_pool` — UPDATE pack_drop_pool (~33,260 rows after dedup).
7. `audit_20260526_drop_wrong_direction_wmc_canonicalize_trigger` — **NEW FINDING** (see §"Surprise B" below). DROP trigger + function + stats table.
8. `audit_20260526_merge_temp_index_wmc_edition_key` / `audit_20260526_merge_drop_temp_index_for_hot` — failed experiment: index on `edition_key` made things slower because it blocked HOT updates. Dropped.
9. `audit_20260526_merge_step3f_wmc_chunk_01..11` — bulk wmc rewrite, 999,901 rows total, in 11 chunks of 800 staging dupe_exts each (each chunk ≈ 91k wmc rows). HOT updates restored after the temp index drop, no index churn per row.
10. `audit_20260526_merge_step3g_defensive_repoints_v2` — defensive no-op repoints across 11 zero-row tables. **`unmapped_sales` removed from the list** — the original audit thought it had `edition_id`, but it keys by `nft_id` (text); no repoint needed.
11. `audit_20260526_merge_step4_drift_repoint_and_delete` — **NEW FINDING** (see §"Surprise C" below). Atomic re-repoint of 643 concurrent-cron drift rows (200 fmv_snapshots + 358 moments + 85 pack_drop_pool) + pull-through + DELETE editions.
12. `audit_20260526_editions_block_topshot_uuid_dupe_trigger` — §2d defensive BEFORE INSERT trigger. Smoke-tested against an attempted UUID-keyed insert with a canonical twin (correctly dropped, no exception, no row leaked).
13. `audit_20260526_merge_step5_drop_staging` — `DROP TABLE _ts_edition_merge_staging`.
14. VACUUM ANALYZE on editions, moments, sales, fmv_snapshots, price_snapshots, pack_drop_pool, wallet_moments_cache, badge_editions (via `execute_sql`, not `apply_migration` — VACUUM can't run inside a transaction).

### Surprise A — pack_drop_pool intra-dupe collisions (Phase 0 missed it)

Phase 0 measured 0 dupe-vs-canonical collisions for pack_drop_pool. The intra-dupe case (two different UUID dupes for the same play both pointing at the same canonical via `(dist_id, slot_name)`) was not checked. At execution time: 56 collision groups, 72 loser rows (out of 33,332). Resolution: keep-max-weight per `(canonical_id, dist_id, slot_name)` group; tiebreak by smallest `edition_id`. 39 groups had identical weights (semantically lossless), 17 had divergent weights (chose conservative max-weight to avoid deflating pull probabilities).

**Lesson for future merge work**: when checking collision risk on a table with a PK that includes `edition_id`, count BOTH dupe-vs-canonical AND intra-dupe-vs-intra-dupe convergence.

### Surprise B — wmc canonicalize trigger was wrong-direction (massive ongoing corruption)

A trigger named `trg_wmc_canonicalize_edition_key` (firing `canonicalize_wmc_edition_key()` BEFORE INSERT OR UPDATE OF `edition_key` on `wallet_moments_cache`) had been rewriting integer-form TS edition_keys (`"168:5766"`) into the UUID form — the inverse of the May 24 wmc invariant ("`wmc.edition_key` MUST always equal `editions.external_id`" in integer form for TS).

Live damage at discovery: **1,002,042 of 1,192,507 (84%) TS wmc rows were UUID-form**, directly contradicting the contract.

This was a separate corruption mechanism from the `wmc_edition_key_drain_v3` SQL function that the 2026-05-24 audit caught and neutralized — the May 24 fix didn't catch this trigger.

User-approved decision: drop the trigger + function + stats table permanently. After this merge + the §2d trigger, no UUID-keyed TS editions can exist anyway, so the canonicalizer has nothing to canonicalize.

Bulk-rewriting 999,901 wmc rows then exposed two more operational issues:
- Statement timeout (120s + extended `SET LOCAL` to 600s both failed). PG was bottlenecked on tuple-write + index-maintenance overhead.
- A temporary `CREATE INDEX ON wmc(edition_key)` actually made it WORSE because it blocked PostgreSQL's HOT (Heap-Only Tuple) optimization — HOT can skip index maintenance only when no index covers the changing column. With the temp index dropped, hash-join + HOT updates completed in 11 chunks of 800 staging rows.

**Lesson for future merge work**: for bulk single-column UPDATEs on heavily-indexed tables, AVOID creating an index on the changing column — HOT will save more than the index lookup buys.

### Surprise C — concurrent-cron drift mid-merge (200 + 358 + 85 rows)

Between step 3c (UPDATE fmv_snapshots) and step 4 (DELETE editions), three writers fired:
- `fmv-recalc` (every 20min) — 200 new fmv_snapshots rows referencing dupes
- a moments writer (wallet-backfill?) — 358 new moments rows
- a pack_drop_pool writer — 85 new rows

The final DELETE rejected on `fmv_snapshots_edition_id_fkey`. Resolution: `audit_20260526_merge_step4_drift_repoint_and_delete` atomically (a) re-ran dedup + repoint across all dependent tables (caught the drift), (b) ran the pull-through, (c) DELETED the dupe editions. Single-transaction so any newer race-window writes would FK-fail on commit, signaling a retry was needed. Zero retries were needed in practice.

**Lesson for future merge work**: in any long-running multi-step merge against a live database, the final DELETE step must re-run drift repoint inside the same transaction as the DELETE. Phase 0 dry-runs underestimate this because the dry-run reads frozen state; production reads moving state.

### Pre-existing FK orphans surfaced (separate investigation, NOT caused by this merge)

The post-merge verification turned up large orphan counts on three tables that were NOT caused by the merge (verified by checking `EXISTS in _ts_edition_merge_staging` — zero hits in all three):

| table | total orphans | scope |
|---|---|---|
| `marketplace_offers` | 585,341 | 463,914 TS + 121,427 non-TS |
| `cached_listings_v2` | 8,352 | 0 TS (all non-TS) |
| `wallet_moments_cache` | 3,743 | TS wmc rows with edition_keys not matching any `editions.external_id` |

Both `marketplace_offers` and `cached_listings_v2` have FKs `NO ACTION` referencing `editions(id)`, so 585k + 8k orphans existing means either the FKs are `NOT VALID` (validation skipped) or some past operation deleted parent rows without enforcing them. **Defer this to a separate audit — not in scope for this merge.**

### Things I'd do differently next time

1. Always grep `information_schema.columns` for every table in the dependent list BEFORE writing the body — would have caught `badge_editions.edition_id` and `wallet_moments_cache.edition_id` and `unmapped_sales.edition_id` non-existence upfront (caught only at execution time here).
2. For any UNIQUE-constraint dedup, run BOTH the dupe-vs-canonical AND intra-dupe-vs-intra-dupe counts in Phase 0 — would have caught the pack_drop_pool case.
3. For any "I expect this dependent table to fall in line" assumption, audit the table's triggers, not just its constraints. The wmc canonicalize trigger discovery is the kind of thing that would have surfaced only by reading `pg_trigger` for every dependent — worth a checklist line.
4. Stop concurrent crons during long merges if possible (cron-job.org has a pause button). The drift recovery worked, but adding 643 rows of friction in a 1M-row merge was avoidable.

End.
