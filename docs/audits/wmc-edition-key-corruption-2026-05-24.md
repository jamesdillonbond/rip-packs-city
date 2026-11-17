# wmc.edition_key corruption — audit & fix (2026-05-24)

## Summary

Trevor reported two symptoms on his wallet `0xbd94cade097e50ac`:

1. Top Shot set tracker showed far fewer completed sets than nbatopshot.com (RPC: 33, actual per Top Shot: 91).
2. A chase moment — #5 Damian Lillard, *Run It Back: Legacies 2014-19* (Series 4) — was missing from the collection view.

Both traced to **one structural bug**: ~202k `wallet_moments_cache` rows had `edition_key` written in the wrong format, breaking every reader RPC that joins `editions.external_id = wmc.edition_key`.

## Root cause

`wmc_edition_key_drain_v3()` — driven by the `migrate-wmc-edition-keys` cron and `app/api/admin/migrate-wmc-edition-keys/route.ts` — rewrote integer-format edition_keys (`set:play`, e.g. `121:4255`) to `editions.id::text` (a bare PK UUID, e.g. `db53bc30-83db-4d5d-b030-d2123c15dd72`).

The route header described this as migrating to "the canonical UUID-edition external_id" — but the function wrote `e.id`, not `e.external_id`, and integer-format keys never needed migrating in the first place (they ARE valid `external_id` values and join fine).

Every reader joins on `external_id`:
- `get_wallet_moments_with_fmv` — LEFT JOIN, so drained moments still appeared but lost FMV / circulation / thumbnail / team and sorted to the bottom (NULL FMV). This is why the Lillard moment "disappeared" — it sank to page ~286 of a 14,260-moment collection.
- `get_topshot_set_progress` / `get_topshot_set_detail` — INNER JOIN, so drained moments were dropped from owned-play counts → sets under-counted as incomplete.

Scale at discovery: 202,241 broken rows (202,197 Top Shot + 44 UFC). ~17% of all Top Shot wmc rows. Only ~83% of Top Shot wmc rows were joining correctly.

## Fixed (live in DB, 2026-05-24)

Migration `audit_20260524_retire_wmc_edition_key_drain_v3` — `wmc_edition_key_drain_v3()` rewritten as a no-op that preserves the JSON return shape the route reads (`rows_migrated: 0`, `algo_version: drain-v3-retired-noop`), so the cron exits clean instead of corrupting more rows.

Data repair — 200,053 rows restored: `edition_key` set back to the matched edition's `external_id` (round-trips cleanly to the original `set:play` form). Done in batched UPDATEs to avoid lock timeouts.

Migration `audit_20260524_fix_mutable_search_path_fmv_trigger` — pinned `search_path` on `fmv_snapshots_block_stale_ingest_algo()` (cleared a standing advisor warning).

### Verification

| Metric | Before | After |
|---|---|---|
| Top Shot wmc rows joining to editions | ~986k (~83%) | 1,186,315 (99.7%) |
| Broken (single-UUID) edition_keys | 202,241 | 2,188 |
| Trevor — complete Top Shot sets (`get_topshot_set_progress`) | 33 | 56 |
| Trevor — Lillard *Legacies* moment (43604624) edition_key | `db53bc30-…` (unjoinable) | `121:4255` (joins ✓) |

### Residual: 2,188 orphan rows (36 distinct keys)

These reference a bare UUID that matches no `editions.id` in any collection — the referenced edition row was deleted, so they can't be auto-repaired. Pre-existing (broken before this work too), 0.18% of Top Shot wmc. 30 are in Trevor's wallet. They need a destructive re-backfill (DELETE + re-walk) to self-heal because `upsert_wallet_moments` `ON CONFLICT` does not update `edition_key`.

## Still open

### The 56 → 91 sets gap is a SEPARATE issue

The edition_key fix recovered +23 sets. The remaining gap to 91 is **not** the same bug — it is catalog coverage / definition drift:

- `get_topshot_set_progress` tracks only **241 sets**; Top Shot's full catalog is far larger. Sets Trevor completed that aren't in RPC's `sets`/`editions` catalog cannot be credited.
- **26 sets contain junk editions** — rows with `player_name` NULL/`'Unknown'` but a non-null `play_id_onchain`, so they pollute the set "universe" and make the set un-completable (e.g. *Clamps* requires a phantom `play_id 3`, player "Unknown"). 1,288 Top Shot editions total have junk player names.
- Some near-miss sets (12 missing exactly 1 play, 7 missing 2, 13 missing 3) may be genuinely incomplete OR over-counted by one — needs reconciliation against Top Shot's authoritative set definitions.

This is a catalog-backfill project, scoped separately.

### FMV for thin-traded chase moments

The Lillard *Legacies* edition (`121:4255`, 28-print LEGENDARY) has 0 recorded sales → `NO_DATA` FMV. After the key fix it now displays with correct metadata (circulation, tier, set, thumbnail) but no dollar value. It still sorts last under the default `fmv_desc`. Worth considering: a circulation/tier-aware fallback rank so high-scarcity NO_DATA moments aren't buried.

## Claude Code handoff prompt

Plain text below — paste into Claude Code (works on `main`, no branch).

---

Retire the wmc edition_key "drain" pipeline. Background: wmc_edition_key_drain_v3 was corrupting wallet_moments_cache.edition_key (rewriting valid set:play keys to editions.id, which breaks every editions.external_id = edition_key reader join). The v3 SQL function has already been neutralized to a no-op in the DB and 200k rows were repaired. Now retire the dead surface in the repo:

1. Delete app/api/admin/migrate-wmc-edition-keys/route.ts and its directory.
2. Remove the migrate-wmc-edition-keys entry from cron-job.org (Trevor must do this in the cron-job.org dashboard — flag it for him) and from docs/operations/cron-schedule.md and CRON_SCHEDULE.md.
3. Delete scripts/cleanup-wmc-int-orphans.mjs if it only services this dead pipeline.
4. In CLAUDE.md, add a short note under a recent-session entry that the wmc edition_key drain pipeline was retired 2026-05-24 because it corrupted edition_key; wmc.edition_key must always equal editions.external_id.
5. Grep for any remaining references to wmc_edition_key_drain, wmc_dedup_pairs, wmc_dedup_pairs_sync_from_view, or canonical_pair and report what still uses them — these may now be fully dead and droppable.

Do not change get_wallet_moments_with_fmv, get_topshot_set_progress, or get_topshot_set_detail — they are correct as-is. Commit and push to main.

---

### Optional follow-ups

- Defense-in-depth: make the three reader RPCs join-tolerant (`e.external_id = wmc.edition_key OR e.id::text = wmc.edition_key`) so a future backfill regression can't silently re-break enrichment.
- Catalog cleanup: backfill `player_name` for the 1,288 junk Top Shot editions, and audit the 241-set catalog against Top Shot's real set list.

## Update — DB cleanup pass (2026-05-24, later)

App side retired in commit `e349cc1` (route, script, cron entry, docs). DB cleanup pass then ran with a dependency check first — which corrected the rest of the "droppable" list:

**Dropped** (migration `audit_20260524_drop_wmc_edition_key_drain_functions`): `wmc_edition_key_drain_v3`, `wmc_edition_key_drain_v2`, `wmc_edition_key_drain_batch`. Confirmed no DB object referenced any of them.

**NOT dropped — the rest of the list is load-bearing, not dead.** A `BEFORE INSERT OR UPDATE OF edition_key` trigger on `wallet_moments_cache` — `trg_wmc_canonicalize_edition_key` → `canonicalize_wmc_edition_key()` — reads `wmc_dedup_pairs` on every write. It is heavily live: 416,925 rewrites in the last 14 days. It exists because **7,221 of 9,064 Top Shot play keys have duplicate edition rows** (one integer-format `external_id`, one UUID-format) and the trigger normalizes `wmc.edition_key` onto the canonical one. Dropping `wmc_dedup_pairs` would make every wmc write throw.

**Problem the route deletion would have introduced:** the deleted route was the *only* caller of `wmc_dedup_pairs_sync_from_view` — the refresh mechanism for `wmc_dedup_pairs`. That table would have frozen. Resolved below.

## Resolution — canonicalization made self-sufficient (2026-05-24)

Research findings that drove the fix:

- 7,222 of 9,064 Top Shot play keys have duplicate edition rows — one integer-format `external_id`, one UUID-format. Edition creation has two independent paths (GQL catalog → UUID rows; Cadence integer-edition / `ensure_topshot_edition_stub` → integer rows).
- FMV is computed on the UUID (canonical) edition: 7,096 / 7,222 pairs have real FMV there vs only 395 on the integer edition. So canonicalization is functionally necessary — a wmc row on the integer edition loses FMV.
- The canonicalization was working well: only 180 wmc rows platform-wide were stranded on an integer edition.
- The trigger's `wmc_dedup_pairs` lookup is just a materialized cache of a query that runs fine live: `editions` has both needed indexes (`editions_external_id_collection_id_key`, `idx_editions_onchain_pair`).

Chosen path — eliminate the materialized layer rather than re-home its refresh:

- `canonicalize_wmc_edition_key()` rewritten (migration `audit_20260524_canonicalize_wmc_edition_key_self_sufficient`) to resolve the canonical external_id with two index lookups directly against `editions`. Verified identical to the old `editions_canonical_pair` mapping on random samples; live-tested after deploy (integer key in → canonical UUID key out).
- 180 stray wmc rows canonicalized.
- Dropped (`audit_20260524_drop_wmc_dedup_pairs_machinery`): `wmc_dedup_pairs` table, `wmc_dedup_pairs_sync_from_view` RPC, `editions_canonical_pair` view.

End state: the canonicalization trigger is self-healing and always live against `editions` — no materialized table, no refresh cron, no frozen-drift risk. `wmc_canonicalize_trigger_stats` kept for observability.

**Still the underlying disease:** Top Shot's `editions` catalog carries two rows per play for ~80% of plays. The canonicalization trigger is a band-aid. See the dedup scoping below.

## Editions dedup — scoped, NOT recommended (2026-05-24)

The full dedup (delete the 7,222 integer edition rows) was scoped in detail. Conclusion: **don't do it.**

Reference surface — what points at the 7,222 integer editions:

| Table | Rows on integer editions |
|---|---|
| `moments` | 24,883 |
| `special_serial_targets` | 14,382 |
| `fmv_snapshots` | ~7,222 editions × history (mostly NO_DATA) |
| `fmv_calibration_caps` | 37 |
| `sales` | 10 → **repointed, now 0** |
| `price_snapshots` | 6 |
| `fmv_phantom_attempts` | 6 |
| `cached_listings_v2`, `marketplace_offers`, `offers`, `pack_drop_pool`, `watchlist_items`, `user_wishlists`, `user_trade_offers`, `trade_matches`, `special_serial_holders`, `portfolio_moments`, `topshot_insider_buybacks` | 0 |

Actual correctness damage from the duplication is small: 50 plays mispriced (canonical edition shows NO_DATA while the integer twin has an FMV) and the 10 stray sales (now fixed). The `moments` / `special_serial_targets` split is internal fragmentation, not a visible break.

Why not recommended:

1. The self-sufficient canonicalization trigger already makes the **user-facing** surface correct — `wmc` → wallet / sets / FMV all resolve to the canonical edition.
2. A real dedup can't be a DB-only migration. Every pipeline that writes `edition_id` — the moments hydrator, the sales/listing indexers, fmv-recalc, the special-serial pipeline — resolves editions independently. Repointing child rows without first converging all of them onto the canonical edition just re-fragments on the next pipeline run. That convergence is route-code across the stack.
3. Deleting integer editions also requires rewriting the canonicalization trigger to parse `set:play` by `(set_id_onchain, play_id_onchain)` instead of looking up the integer edition row.
4. Poor ROI vs. RPC's intelligence-first priorities — the payoff is catalog cosmetics (17.5k → ~10.3k edition rows) for real migration risk on core tables.

Done in this pass: repointed the 10 stray `sales` rows to canonical editions (migration `audit_20260524_repoint_stray_sales_to_canonical_editions`) — durable because sales rows are immutable and new sales resolve `edition_id` via the canonicalized `wmc.edition_key`.

If catalog cleanliness ever matters, the cheap mitigation is one `WHERE` clause in `fmv-recalc` so it skips integer editions that have a canonical sibling — stops the ongoing wasted NO_DATA snapshot writes. Optional, not required.
