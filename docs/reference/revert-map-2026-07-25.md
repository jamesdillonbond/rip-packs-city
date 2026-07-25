# Revert map — the 2026-07-25 migrations that shipped without an inline REVERT comment

**Recoverability gap, closed externally.** House convention is that every `audit_*` migration
carries an inline `-- REVERT:` comment in its own statement text, so the undo path travels with
the change. Thirteen of the ninety-three migrations applied on 2026-07-25 did not. Because
`supabase_migrations.schema_migrations` rows are **immutable historical records**, they were
**NOT modified** to add one — this file is the external record instead. Every revert below was
derived by reading the migration's actual statements out of `schema_migrations` and checking the
claimed prior state against the live catalog (`pg_proc`, `pg_class`, `pg_index`, `pg_depend`,
`pg_default_acl`). Where a safe revert does not exist, it says so rather than guessing.

**Counts (live DB, 2026-07-25):** 93 migrations with `version >= '20260725'`; **13** with no
`REVERT` mention anywhere in `statements`. (The commissioning brief estimated ~92 total — the
database says 93. The 13 figure matched.)

---

## Summary

| Version | Name | Revert class |
|---|---|---|
| 20260725001036 | `audit_20260725_marketplace_offers_listed_coll_nft_idx` | drop |
| 20260725005340 | `audit_20260724_candy_troll_floor_guard` | restore-prior — **superseded, do not revert in isolation** |
| 20260725010534 | `audit_20260725_pin_panini_serial_premium_mult` | no-op |
| 20260725011047 | `audit_20260724_candy_scoped_fmv_current` | restore-prior + drop (needs `DROP … CASCADE`) |
| 20260725032632 | `audit_20260725_backfill_nft_edition_map_from_sales_fn` | drop (side-effect rows NOT revertible) |
| 20260725032719 | `audit_20260725_grant_nem_backfill_to_cron_heavy` | inverse-grant |
| 20260725064824 | `audit_20260725_trust_health_fmv_coverage_staleness_legs` | **Cannot determine a safe revert** — superseded 8× same day |
| 20260725081831 | `audit_20260725_get_team_activity_soldat_ordered_rewrite` | restore-prior |
| 20260725170024 | `audit_20260725_secure_allday_residue_audit_tables` | inverse-grant — **partially NOT REVERTIBLE** (exact prior ACL unrecoverable) |
| 20260725171815 | `audit_20260725_sales_ingest_unresolved_park_table` | drop |
| 20260725171850 | `audit_20260725_sales_ingest_park_unresolved_rows` | restore-prior |
| 20260725171927 | `audit_20260725_resolve_sales_ingest_unresolved_ambiguity_safe` | drop — superseded by 20260725172035 |
| 20260725172035 | `audit_20260725_resolve_sales_ingest_unresolved_fix_uuid_agg` | restore-prior (restores a **known-broken** definition) |

---

### 20260725001036 — `audit_20260725_marketplace_offers_listed_coll_nft_idx`

Added one partial index to support the per-wallet best-offer join on `/api/best-offers` for the
non-TopShot Flow collections. `marketplace_offers` is a partitioned table (`relkind = 'p'`) with
14 partitions; the `CREATE INDEX` (no `ONLY`) created the parent plus 14 attached child indexes.
No earlier migration mentions this index name — it is brand new.

```sql
DROP INDEX public.idx_marketplace_offers_listed_coll_nft;
```

Dropping the parent index drops all 14 attached child indexes (verified: 14 rows in `pg_inherits`
for this index). No data loss. The `/api/best-offers` non-TopShot path will regress to a
seq-scan over all partitions, which is the pre-migration behaviour.

### 20260725005340 — `audit_20260724_candy_troll_floor_guard`

Replaced three Candy views — `candy_listing_floor`, `candy_offer_spread_board`,
`candy_secondary_board` — to add a troll-ask ceiling (`10 × GREATEST(fmv, tier_median_fmv)`) to
the floor computation, plus the new `excluded_troll_count` / `floor_capped` columns. All three
already existed, so this is a restore-prior. The last migration carrying a **full body** for
each is: `candy_listing_floor` → `20260724165518`; `candy_offer_spread_board` and
`candy_secondary_board` → `20260724170010`. (`20260724193401` only ran
`ALTER VIEW … SET (security_invoker=on)` — no body.)

```sql
-- Not runnable as-is. See caveats: this revert is superseded and requires DROP CASCADE.
-- 1. Restore candy_secondary_board  + candy_offer_spread_board from migration 20260724170010
-- 2. Restore candy_listing_floor                               from migration 20260724165518
-- Each must be dropped first, in dependency order, then re-created:
DROP VIEW public.candy_secondary_board;
DROP VIEW public.candy_offer_spread_board;
DROP VIEW public.candy_listing_floor;
-- then replay the CREATE OR REPLACE VIEW bodies from the migrations named above,
-- in the order: candy_listing_floor, candy_offer_spread_board, candy_secondary_board
```

**Caveat 1 — superseded.** `20260725011047`, six hours later the same day, replaced all three of
these views again (re-pointing them at `candy_fmv_current`). Reverting `20260725005340` on its own
is therefore not meaningful against the current schema. Revert `20260725011047` first, or treat
the two migrations as one unit.

**Caveat 2 — `CREATE OR REPLACE VIEW` will not work.** The prior `candy_listing_floor` had 6
output columns (`floor_sol, floor_usd, listing_count, distinct_sellers, last_seen_at` on
`edition_id`); the post-migration version has 8. `CREATE OR REPLACE VIEW` cannot **remove**
columns, so the restore must be `DROP VIEW` + `CREATE VIEW`. Live `pg_depend` shows
`candy_offer_spread_board` and `candy_secondary_board` both read `candy_listing_floor`, so they
must be dropped first (or use `DROP VIEW … CASCADE` and recreate both). Same applies to their own
`excluded_troll_count` column.

### 20260725010534 — `audit_20260725_pin_panini_serial_premium_mult`

Re-asserted the live definition of `public.panini_serial_premium_mult(boolean, boolean, boolean)`
so a DB-invariant test could pin it — the previous migration (`20260721003143`) had only `ALTER`ed
its `search_path`, leaving no readable `CREATE` for the drift-guard extractor.

```sql
-- No revert needed (no-op).
```

Verified: the body asserted by this migration is byte-identical to the body created in
`20260718011844`, and the `SET search_path TO 'public', 'pg_temp'` matches what
`20260721003143` had already set. `pg_get_functiondef()` on the live function today returns
exactly what this migration asserted. `CREATE OR REPLACE` preserved the grants. There is no state
change to undo.

### 20260725011047 — `audit_20260724_candy_scoped_fmv_current`

Introduced the **new** view `public.candy_fmv_current` (a Candy-scoped `DISTINCT ON (edition_id)`
over `fmv_snapshots`) and re-pointed five existing views off the global `fmv_current` onto it:
`candy_listing_floor`, `candy_deals_board`, `candy_offer_spread_board`, `candy_secondary_board`,
`candy_special_serials_board`. No earlier migration mentions `candy_fmv_current`, so that one view
is brand new; the other five are restore-prior.

```sql
-- Drop in dependency order (all five read candy_fmv_current; two also read candy_listing_floor):
DROP VIEW public.candy_secondary_board;
DROP VIEW public.candy_offer_spread_board;
DROP VIEW public.candy_special_serials_board;
DROP VIEW public.candy_deals_board;
DROP VIEW public.candy_listing_floor;
DROP VIEW public.candy_fmv_current;

-- Then replay the prior bodies (each followed by its
--   REVOKE ALL ON <view> FROM anon, authenticated;
--   GRANT SELECT ON <view> TO service_role;
-- pair, which those migrations already carry):
--   candy_listing_floor          -> restore definition from migration 20260725005340
--   candy_offer_spread_board     -> restore definition from migration 20260725005340
--   candy_secondary_board        -> restore definition from migration 20260725005340
--   candy_deals_board            -> restore definition from migration 20260724170010
--   candy_special_serials_board  -> restore definition from migration 20260724165915
```

**Caveat.** `candy_fmv_current` cannot be dropped until all five dependents are dropped — live
`pg_depend` confirms all five reference it. Reverting only part of this set leaves a broken
dependency graph. Nothing after `20260725011047` touches any of these six objects, so this revert
*is* valid against the current schema (unlike `20260725005340` above). No data loss: these are all
views.

### 20260725032632 — `audit_20260725_backfill_nft_edition_map_from_sales_fn`

Created the **new** function `public.backfill_nft_edition_map_from_sales(uuid, integer)` — a
self-heal that derives `nft_id → edition` from already-resolved rows in `public.sales` and inserts
into `nft_edition_map`, which `promote_unmapped_sales` then drains. Also revoked it from
`PUBLIC`/`anon`/`authenticated` and granted `EXECUTE` to `service_role`. No earlier migration
mentions the function name — brand new.

```sql
DROP FUNCTION public.backfill_nft_edition_map_from_sales(uuid, integer);
```

Signature confirmed against `pg_proc`:
`backfill_nft_edition_map_from_sales(uuid,integer)`.

**Data-loss / side-effect warning.** The function has been executed since it shipped.
`public.nft_edition_map` holds 133,855 rows, of which **2,909 have `created_at >= 2026-07-25
03:26`** — i.e. after this function existed. Dropping the function does **not** undo those
inserts, and `nft_edition_map` has no `source` column, so rows written by this function cannot be
distinguished from rows written by any other writer in the same window.
**NOT SAFELY REVERTIBLE (the data side):** deleting by `created_at` would also delete other
writers' rows. Those inserts have in turn fed `promote_unmapped_sales` into `public.sales`. Treat
the function drop and the row cleanup as two separate, independently-scoped decisions.

### 20260725032719 — `audit_20260725_grant_nem_backfill_to_cron_heavy`

Two `GRANT EXECUTE` statements only, adding the `cron_heavy` role to
`backfill_nft_edition_map_from_sales(uuid, integer)` and `promote_unmapped_sales(uuid, integer)`.

```sql
REVOKE EXECUTE ON FUNCTION public.backfill_nft_edition_map_from_sales(uuid, integer) FROM cron_heavy;
REVOKE EXECUTE ON FUNCTION public.promote_unmapped_sales(uuid, integer) FROM cron_heavy;
```

Safe inverse. Verified no earlier migration grants either function to `cron_heavy` (this is the
only migration matching both `cron_heavy` and `promote_unmapped_sales`), so `cron_heavy` held no
prior privilege to preserve. Live `proacl` on both functions is
`{postgres=X/postgres,service_role=X/postgres,cron_heavy=X/postgres}` — the revoke returns both to
the `postgres` + `service_role` state. Any pg_cron job running as `cron_heavy` that calls these
will start failing with `42501` immediately.

### 20260725064824 — `audit_20260725_trust_health_fmv_coverage_staleness_legs`

Replaced `public.v_rpc_trust_health` to add five FMV **coverage** legs
(`{topshot,allday,golazos,ufc,pinnacle}_fmv_pct_stale_30d`) alongside the existing freshness legs,
each with a baseline captured that day. The immediately-prior full body is in migration
`20260725063537` (`audit_20260725_cron_heavy_selfheal_impossible_parallel_circ`).

```sql
-- Cannot determine a safe revert. Do not run a naive restore-prior.
-- The nominal prior definition is in migration 20260725063537, but see below.
```

**Cannot determine a safe revert.** `v_rpc_trust_health` was redefined **eight more times on the
same day** after this migration: `20260725163824`, `175600`, `180412`, `180453`, `180936`,
`181700`, `184741`, `184907`. The live view today is 11,968 characters and reads from
`public.rpc_trust_health_precompute` (confirmed via `pg_get_viewdef` and `pg_depend`), a
precompute table that did not exist when `20260725064824` was applied. Restoring the
`20260725063537` body would silently roll back all eight later migrations, including the
precompute rewire, and would drop the coverage legs that the later baseline-capture and
precompute-refresh migrations depend on. **Missing information:** which of the nine same-day
definitions is the intended target state. Reverting this one migration is only meaningful as part
of an explicitly-ordered rollback of the whole `20260725` trust-health series — that ordering has
to be decided by a human, not inferred.

### 20260725081831 — `audit_20260725_get_team_activity_soldat_ordered_rewrite`

Replaced `public.get_team_activity(uuid, text, integer, integer)` to fix a 28s → ~60ms regression
(Sentry `JAVASCRIPT-NEXTJS-1Y`, pool-connection exhaustion on `/[collection]/team/[slug]`). It
materialises the team's `edition_id[]` first, then walks `sales` newest-first on the existing
`(collection_id, sold_at DESC)` per-partition indexes so `MergeAppend` stops at the limit.
Attributes and output columns were preserved.

```sql
-- restore definition from migration 20260701165102
--   (revert_get_team_activity_to_join_form_20260701 — the JOIN form)
```

Signature confirmed: `get_team_activity(uuid,text,integer,integer)`. `20260701165102` carries a
complete `CREATE OR REPLACE FUNCTION public.get_team_activity` body, and nothing after
`20260725081831` touches the function, so the restore is valid against the current schema. No data
loss (read-only `STABLE` function). **Caveat:** reverting reinstates the 28s query and the
pool-exhaustion incident. The function's own `SET statement_timeout = '8s'` is documented as inert
on the direct-call path, so it will not protect you.

### 20260725170024 — `audit_20260725_secure_allday_residue_audit_tables`

Closed two hard `check_public_security_invariants()` violations: enabled RLS (with zero policies)
on `audit_20260725_allday_v1_unsplittable_retag` (19,589 rows) and
`audit_20260725_allday_unmapped_dedupe_tx_nft`, revoked `anon`/`authenticated`, and added a
descriptive `COMMENT` to each. Both tables had been created earlier the same day without RLS and
were anon-readable at `/rest/v1/<table>`.

```sql
ALTER TABLE public.audit_20260725_allday_v1_unsplittable_retag  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260725_allday_unmapped_dedupe_tx_nft DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.audit_20260725_allday_v1_unsplittable_retag  IS NULL;
COMMENT ON TABLE public.audit_20260725_allday_unmapped_dedupe_tx_nft IS NULL;

-- The anon/authenticated re-grant is deliberately NOT specified here. See below.
```

**Partially NOT REVERTIBLE: the exact prior grant set cannot be recovered.** The migration
recorded only that `has_table_privilege('anon', …, 'SELECT')` was `true` before it ran — not the
full privilege bitmap. `pg_default_acl` for `public` tables currently holds **two conflicting
entries** (`anon=rxm/postgres` from one grantor and `anon=arwdDxtm/supabase_admin` from another),
so which default applied to these two tables depends on the creating role and is not determinable
after the fact. Live `pg_class` confirms the post-migration state
(`relrowsecurity = true`, 0 policies, `anon`/`authenticated` `SELECT` = false).
Also note: re-granting `anon` would re-open two internal ingest-bookkeeping tables to the public
anon key and re-break the platform invariant "0 public tables with `rowsecurity = false`". The
`DISABLE ROW LEVEL SECURITY` above is sufficient to restore *access for service_role-equivalent
paths*; the anon exposure should not be restored at all. No data loss either way — this migration
touched no rows.

### 20260725171815 — `audit_20260725_sales_ingest_unresolved_park_table`

Created the **new** table `public.sales_ingest_unresolved` (park, don't discard, the ~85-90% of
each Dune batch that `apply_sales_ingest_external` could not edition-resolve), plus its partial
drain index, RLS enable, `anon`/`authenticated` revoke, and a table comment. Deliberately a
dedicated table rather than `public.unmapped_sales`, to avoid tripping
`check_unmapped_backlog_growth()` and feeding the on-chain resolvers a backlog they cannot serve.

```sql
DROP TABLE public.sales_ingest_unresolved;
```

`DROP TABLE` removes `sales_ingest_unresolved_open_idx`, the `PRIMARY KEY`, and the
`sales_ingest_unresolved_tx_nft_key` UNIQUE constraint with it — no separate statements needed.

**Data-loss check (done): currently safe.** `select count(*) from public.sales_ingest_unresolved`
returns **0** (0 resolved). Nothing has been parked yet, so the drop loses nothing *today*. This
will stop being true the first time the Dune ingest runs — re-check the count before dropping.
Dependency note: `apply_sales_ingest_external` (as of `20260725171850`) and
`resolve_sales_ingest_unresolved` both write/read this table, so dropping it breaks both
functions; revert `20260725172035`, `20260725171927` and `20260725171850` first.

### 20260725171850 — `audit_20260725_sales_ingest_park_unresolved_rows`

Replaced `public.apply_sales_ingest_external(jsonb)` to add one behaviour: the edition-unresolvable
rows are now `INSERT`ed into `sales_ingest_unresolved` (deduped within-batch by
`DISTINCT ON (tx_hash, nft_id)` and across runs by the UNIQUE constraint) instead of being
discarded, and a `parked` counter was added to the returned JSON. Every other branch — fill path,
eligibility rule, multi-moment drop, `sales_ingest_recovered` audit writes, all other counters —
is byte-identical to the prior definition.

```sql
-- restore definition from migration 20260719124057
--   (audit_20260719_sales_ingest_external_multimoment_count)
```

Signature confirmed: `apply_sales_ingest_external(jsonb)`. `20260719124057` carries a complete
`CREATE OR REPLACE FUNCTION public.apply_sales_ingest_external` body and is the last full
definition before this one. Nothing after `20260725171850` redefines it.

**Caveat.** The revert removes the `parked` key from the return payload — any caller reading
`result.parked` must be reverted in the same change. Rows already parked in
`sales_ingest_unresolved` are **not** removed by restoring the function; they stay. That is
currently moot (0 rows), but if the ingest has since run, those parked rows are the *only* copy of
Dune datapoints already paid for — do not delete them as part of a function revert.

### 20260725171927 — `audit_20260725_resolve_sales_ingest_unresolved_ambiguity_safe`

Created `public.resolve_sales_ingest_unresolved(integer, boolean)` — drains
`sales_ingest_unresolved` by deriving `nft_id → edition` from existing `sales`, but **only** where
the mapping is unambiguous (`count(DISTINCT edition_id) = 1`), because TopShot (unlike AllDay) has
genuinely ambiguous `nft_id`s (287 in the 2021 partition alone, cross-set misattribution, not the
benign `::` parallel re-key). Dry-run by default. Also revoked from `PUBLIC`/`anon`/`authenticated`
and granted `EXECUTE` to `service_role`. No earlier migration defines this function — brand new.

```sql
DROP FUNCTION public.resolve_sales_ingest_unresolved(integer, boolean);
```

Signature confirmed: `resolve_sales_ingest_unresolved(integer,boolean)`.

**Caveat — superseded.** `20260725172035` replaced this definition 68 seconds later (the
`min(uuid)` fix). Reverting *this* migration in isolation is meaningless; the only sensible
interpretation of "undo `20260725171927`" against the current schema is the `DROP FUNCTION` above,
which also undoes `20260725172035`. As applied, this definition never successfully wrote anything
(see below), so no data cleanup accompanies the drop.

### 20260725172035 — `audit_20260725_resolve_sales_ingest_unresolved_fix_uuid_agg`

Replaced `resolve_sales_ingest_unresolved(integer, boolean)` to swap `min(s.edition_id)` (invalid —
Postgres has no `min(uuid)`) for `(array_agg(DISTINCT s.edition_id))[1]`, which is exact here
because the value is only consumed when `n_editions = 1`. Behaviour otherwise identical. Re-ran the
same `REVOKE`/`GRANT` pair.

```sql
-- restore definition from migration 20260725171927
--   (audit_20260725_resolve_sales_ingest_unresolved_ambiguity_safe)
-- WARNING: that definition is known-broken. Prefer the DROP under 20260725171927 instead.
```

**Caveat — the prior definition is known-broken.** `20260725171927` as applied raises `42883`
(`function min(uuid) does not exist`) on every non-empty, non-dry-run call and resolves 0 rows.
Restoring it re-introduces that failure. This is confirmed by the migration's own comment and by
the identical trap independently hit and fixed in `20260725203212`
(`resolve_golazos_listing_edition_ids`). If the goal is to back out the resolver entirely, use
`DROP FUNCTION public.resolve_sales_ingest_unresolved(integer, boolean);` (see `20260725171927`).

**No data to unwind.** `select count(*) from public.sales where source = 'dune_settlement_resolved'`
returns **0** — the fixed resolver has not yet inserted any sale rows, and 0 rows in
`sales_ingest_unresolved` are marked `resolved_at`. If that changes, note that the resolver writes
to three places (`public.sales`, `public.sales_ingest_recovered`, and `resolved_at` /
`resolved_sale_id` on `sales_ingest_unresolved`); the `sales` rows are traceable by
`source = 'dune_settlement_resolved'`, so a future unwind is possible but must be scoped
deliberately.

---

## Method

Derived 2026-07-25 by reading each migration's `statements` array directly out of
`supabase_migrations.schema_migrations` on project `bxcqstmqfzmuolpuynti` (read-only `SELECT`s
only; **no row in `schema_migrations` was modified, and no DDL or DML was executed anywhere**).

For each of the 13 migrations:

1. **What it did** — read the full statement text, not just the name.
2. **New vs. replaced** — searched every earlier `schema_migrations` row for the object's name to
   find whether a prior definition exists, and specifically for the last row carrying a *full
   body* (several intermediate migrations only `ALTER`ed attributes and carry no restorable body —
   e.g. `20260724193401` for the Candy views, `20260721003143` for the Panini function).
3. **Superseded?** — searched for any migration with a *later* version that touches the same
   object. Three of the 13 were already superseded the same day; those are flagged rather than
   given a naive restore.
4. **Verified against the live catalog** — exact function signatures from `pg_proc.oid::regprocedure`;
   index parentage and child count from `pg_index` / `pg_inherits`; view dependency order from
   `pg_depend`/`pg_rewrite`; RLS, policy count and role privileges from `pg_class` /
   `has_table_privilege` / `proacl`; prior default grants from `pg_default_acl`.
5. **Data-loss checks** — row counts on `sales_ingest_unresolved`, `nft_edition_map` (including
   `created_at` windowing), and `sales WHERE source = 'dune_settlement_resolved'`.

No revert SQL in this document was executed. Where the prior state was not recoverable from the
migration history or the live catalog, the entry says **Cannot determine a safe revert** or
**NOT SAFELY REVERTIBLE** and names the missing information, rather than offering unverified SQL.
