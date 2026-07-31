# DB-invariant tests

Plain-SQL tests that pin the behavior of high-stakes Postgres functions/triggers
(guards, normalizers) — the layer the vitest suites can't reach because it lives
in the database, not in `lib/` or `app/api/`.

## Why plain SQL (not pgTAP, not a schema apply)

The repo's `supabase/migrations/` are **incremental `audit_*` patches over a base
schema created outside the repo** — they do not rebuild the schema from scratch,
and some prod objects (e.g. the destructive-op circuit breaker) were applied via
MCP and were never committed as files. So we can't just apply the migrations to a
fresh Postgres and test the real objects.

Instead each test file is **self-contained**: it creates the minimal fixture
tables the function touches, installs a **verbatim copy of the committed function
DDL**, asserts the invariant, and `ROLLBACK`s. This runs on a vanilla
`postgres:16` (only the `unaccent` contrib extension is needed) — including the
GitHub Actions `postgres` service — with no schema bootstrap.

## Drift protection

Embedding the DDL risks it going stale. `__tests__/db-invariants-drift-guard.test.ts`
(in the **blocking** unit-tests job, no DB required) extracts each function's DDL
from both the SQL test and its source migration and asserts they are identical
(whitespace-normalized). Editing the function in a migration without updating the
test copy — or vice versa — fails CI. When you change a pinned function: update
the migration, copy the new DDL verbatim into the test file, and keep the
`>>> BEGIN verbatim ... >>>` / `<<< END verbatim ... <<<` markers.

## Running locally

```bash
# against any reachable postgres (needs the unaccent contrib extension)
DATABASE_URL="postgres://user@host:5432/db" bash scripts/run-db-tests.sh
```

Each `*.sql` file (except `_helpers.sql`) is one test; a failed `_assert` RAISEs,
which under `psql -v ON_ERROR_STOP=1` exits non-zero and the runner reports it.

## What's pinned

| Test | Function | Invariant |
|---|---|---|
| `norm_player.sql` | `_norm_player` | accent-fold + lowercase + strip trailing Jr/Sr/roman-numeral suffixes + drop non-alphanumerics; NULL→''; idempotent. Underpins name matching in challenge-slot resolution and pack-drop pricing. |
| `fmv_block_phantoms.sql` | `fmv_snapshots_block_phantoms` | a `> $10k` FMV is nulled + audited to `fmv_phantom_attempts` UNLESS it is `HIGH` confidence AND `>= 3` recent sales; ordinary FMVs pass untouched. Keeps phantom grail valuations off the public surface. |
| `backfill_allday_edition_jersey.sql` | `backfill_allday_edition_jersey` | accepts ONLY a valid NFL jersey `0..99`, ignores NULLs, is change-detecting (no redundant write), is scoped to the AllDay collection, and returns the count actually changed. Lights up the JERSEY-MATCH special-serial row. |
| `refresh_topshot_fmv_display_guard.sql` | `refresh_topshot_fmv_display_guard` | the read-side FMV display-honesty guard: only `fmv_exceeds_max`/`is_thin`/`fmv_disconnected` editions are inserted, `clamp_target` is set iff disconnected, and non-`int:int` external ids are excluded. Consumed by `/api/market` + `/api/sniper-feed`. |

Plus (in `__tests__/db-invariants-drift-guard.test.ts`, all with the same
verbatim-DDL discipline): `expire_ended_challenges`, `fmv_clamp_disconnected_ask_topshot`,
`compute_pack_ev_per_edition_weighted`, `fmv_from_cached_listings`,
`apply_fmv_thin_sales_guard`, `rpc_guard_block_destructive`, `compute_listing_divergence`,
`resolve_moment_id`, `check_email_allowed`, `flowty_collection_id_from_nft_type`,
`get_pinnacle_wallet_best_offer_total`, `get_wallet_best_offer_total`,
`pinnacle_serial_fmv_estimate`, `panini_serial_premium_mult`, `check_anon_write_surface`,
`serial_fmv_estimate` (the canonical 8-arg TopShot special-serial FMV estimator —
pooled → jersey → power-law → grid precedence, the input guards, and the jersey1
double-special flag), and `get_edition_fmv_history` (the per-edition FMV-chart
series — day-window clamp [1,365], latest-snapshot-per-day, the standard vs
Pinnacle render-keyed branches, empty→`[]`), and the **sales-integrity trio**
(2026-07-28): `backfill_nft_edition_map_from_sales` (the free-lane edition mapper —
the DERIVABILITY gate that binds the LIMIT to recoverable rows [the 2026-07-27
green-while-blind defect], the deterministic `order by nft_id` slice, latest-sale-
wins conflict resolution, `on conflict do nothing`, `nullif(serial,0)`),
`promote_unmapped_sales` (the drainer into the FMV-feeding `sales` table — edition-
resolution precedence set:play→edition_id→nft_edition_map→wallet_moments_cache,
serial COALESCE, the 0-price guard, the recheck-horizon skip, the 7-day archive,
and — re-pinned 2026-07-31 — the FOUR per-row outcomes, incl. `merged_cross_source`
for an insert the AllDay dedup trigger silently SUPPRESSED and `insert_vanished`
for one that is genuinely unexplained; `log_pipeline_run` stubbed, but
`allday_sales_cross_source_dedup` installed VERBATIM so the suppression path is
real), and `backfill_null_serial_sales_from_moments` (serial recovery for
serial-FMV — moments>0 then wmc>0 precedence, the `>0` guard against a fake #0,
age-window scope, idempotency), plus the **FMV read + write flagships** (2026-07-28):
`get_wallet_moments_with_fmv` (THE wallet-display read — latest-FMV-per-edition
[future-dated snapshots ignored], the sort ladder, filter + `total_count`, the
`price_band_30d` gate [LOW/MEDIUM conf + ≥10 sc30d + ≥5 recent sales, outlier-
trimmed], the `{moments,total_count}` envelope; `serial_fmv_estimate` stubbed) and
`upsert_topshot_marketplace_fmv` (the marketplace→FMV WRITE honesty gates —
no_edition counting, ULTIMATE-skip, don't-overwrite-HIGH/MEDIUM, sales-precedence,
median×3 cap, troll-ask/ceiling clamps, and DELETE-ONLY-TODAY so history is never
upserted over), plus the **read/write RPC batch** (2026-07-29):
`fmv_recalc_edition_page` (the recency-ordered edition work-list that drives the
whole fmv-recalc sweep — window/price/pinnacle/null filters, per-edition dedupe,
MAX(sold_at) ordering, LIMIT/OFFSET), `recalc_ultimate_fmv` (the ULTIMATE-tier FMV
WRITER — ULTIMATE-only source, insert-only-when-fmv-not-null, and the delete-only-
today-own-algo-ULTIMATE scope that protects history + other pipelines' rows),
`get_edition_badges_unified` (the badge-list read — the play-tag allowlist that
blocks fabricated badges, Three-Star Rookie derivation + subsumption, source-
precedence dedupe, codename-mercury relabel, derived-only fallback),
`refresh_seeded_wallet_stats` (the seeded_wallets display-cache writer — count/FMV
from holdings_summary, and the rarity-RANK top-tier ladder), the entity-page reads
`get_set_detail` / `get_team_detail` (slug scope, variant aggregation, latest-
snapshot FMV/floor totals, teams_master ACTIVE-row branding, 30d activity, Pinnacle
branches), the profile reads `get_user_top_owned_moments` (cross-user guard, cross-
wallet dedupe keeping the higher-fmv copy, the image_url fallback ladder) and
`get_trophy_slab_data` (cross-user guard, editions-over-frozen-denorm precedence,
acquisition latest-wins, empty→'[]'), and `get_moment_detail` (the highest-traffic
detail read — not_found contract, the LOW/MEDIUM + sc30d≥10 + ≥5-cleaned
price_band_30d outlier-trim gate, serial owner/last-sale fallbacks, Standard-
parallel labelling), plus the **read-RPC batch 2** (2026-07-29):
`get_player_detail` (the player/character hub read — slug resolution + the
candidate tie-break ladder that disambiguates a shared name, standard aggregation,
Pinnacle character branch), `get_wallet_collection_snapshot` (the /share card read
— totals, top-5 by FMV, badge count, series buckets, per-collection rollup, rarest
by mint), and `get_pack_detail_bundle` (the pack detail read — the hero strip whose
hit_probability = drop_weight / whole-pool weight, with the drop_weight>0 pool gate),
plus `allday_sales_cross_source_dedup` (2026-07-31 — the BEFORE INSERT trigger that
collapses AllDay cross-source economic twins; the only insert-suppressing trigger
on `sales`) — **42 invariants pinned** in total.

## Adding a test

1. Pick a committed function whose deps you can stub with a few `CREATE TABLE`s.
2. New `supabase/tests/<name>.sql`: `BEGIN;` → fixtures → verbatim DDL (with the
   marker comments) → `SELECT _assert…` lines → a `✓` result → `ROLLBACK;`.
3. Add a `PINS` entry to `__tests__/db-invariants-drift-guard.test.ts` pointing at
   the source migration so the copy stays honest.
4. `DATABASE_URL=… bash scripts/run-db-tests.sh` to confirm green locally.
