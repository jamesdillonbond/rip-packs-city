# Chain-Aware Reads Audit — DB Side (2026-05-30)

**Scope:** Postgres `public` schema only. Companion to Claude Code's Phase E (route / lib audit). Independent audit objects, no overlap.

**Method:** scan `pg_proc.prosrc` and `pg_views.definition` for substrings that indicate Flow-specific assumptions vs. chain-generic reads.

---

## Inventory totals

| Object class | Count | Read `collection_id` | % |
|---|---|---|---|
| Public functions | 401 | 212 | 53% |
| Public views | 53 | 26 | 49% |
| Public triggers | 71 | n/a | n/a |
| Public tables | 172 | most via FK | n/a |

Headline: ~75% of collection-aware DB code already reads via the `collection_id` FK, which carries chain implicitly. Only ~25% has Flow-specific naming or relies on Flow-specific identifier shapes.

---

## Classification

### Tier 1 — assumes-Flow by identifier shape (10 functions)

Reference `set_id_onchain` / `play_id_onchain` columns. These are Flow integer-pair identifiers (`UInt32` on chain); the columns are nullable for non-Flow chains. These functions cannot work for chain-two collections without explicit chain-dispatch.

```
editions_block_topshot_uuid_dupe   (trigger function)
get_edition_onchain_ids
get_edition_page_data
get_edition_parallels
get_topshot_editions_by_setplay
get_topshot_set_detail
get_topshot_set_progress
get_topshot_stub_targets
promote_unmapped_sales
seed_topshot_editions
```

**Disposition:** stays Flow-scoped by design. Chain two gets parallel functions (e.g. `get_candy_set_progress`), not a shared dispatch. Mark with code comment.

### Tier 2 — assumes-Flow by naming a Flow collection slug (50 functions)

| Slug named | Function count |
|---|---|
| `nba_top_shot` | 30 |
| `disney_pinnacle` | 15 |
| `nfl_all_day` | 3 |
| `ufc_strike` | 2 |
| `laliga_golazos` | 0 (but reached via `collection_id` FK in tier 3) |

These read collection by slug (string match) rather than `collection_id` FK. They will not return chain-two data because the slug filters exclude it.

**Tier 2 splits further:**

- **Read-only analytics & dashboards** (`analytics_*`, `get_market_pulse_all`, `get_collection_stats`, `get_platform_stats`): chain-internal but slug-keyed for filtering. When chain two arrives, these gain chain-two slugs added to their `WHERE` clauses, or they become chain-aware via a `p_chain` parameter. Defer dispatch.
- **Pinnacle bridge functions** (`bridge_pinnacle_editions_to_main`, `bridge_pinnacle_fmv_to_main`, `populate_pinnacle_wmc_fmv`): Pinnacle-specific table topology (separate `pinnacle_editions` / `pinnacle_fmv_snapshots` tables). Bridging is unique to Pinnacle's parallel-table pattern. Chain-internal — no dispatch needed.
- **Top Shot stub seeders** (`ensure_topshot_edition_stub`, `seed_topshot_editions`, `fill_topshot_set_play_from_external_id`, `replace_topshot_moments_batch`, `resolve_special_serials_from_ownership`): Top Shot identifier specifics. Stay Flow-scoped. Chain two has its own seed pattern.
- **Concierge tools** (`mcp_get_fmv`, `mcp_get_badge_data`, `mcp_find_set_completion`, `moment_detail`): user-facing surfaces. Chain-aware-dispatch when chain two has product. Annotate.

### Tier 3 — chain-internal via `collection_id` FK (~152 functions)

The 212 functions reading `collection_id` minus the 60 in Tiers 1+2 = **~152 chain-generic functions**. These read `collection_id` and operate on whatever collection the caller passes. Multi-chain compatible out of the box. No change needed.

Spot-check examples (confirmed chain-internal by reading source):

- `get_wallet_pack_summary` — pure `collection_id` joins, currency-aware
- `get_pack_for_simulator` — reads `drop_pool` and `editions` by `collection_id`
- `get_edition_badges_unified` — joins `badge_editions` by `external_id` + `collection_id`
- All `wmc.tier` readers — read via `wallet_moments_cache.collection_id`

**Disposition:** none. They Just Work.

### Tier 4 — views

| Category | Count | Notes |
|---|---|---|
| Read `collection_id` (chain-internal) | 26 | Views like `analytics_sales`, `cached_listings_v2`, etc. Multi-chain compatible. |
| Reference Flow contract addresses | 0 | None found in `pg_views.definition` scan. |
| New (2026-05-30) | 2 | `collection_chains`, `topshot_squeeze_board`. |

`topshot_squeeze_board` is the squeeze board view backing `/insights/squeeze` — Flow-internal by name. Chain two would get its own equivalent (`candy_squeeze_board` or `solana_squeeze_board`), not a shared view.

---

## Parallel chain infrastructure (not via `collections` registry)

**Major finding:** RPC has an active Base mainnet indexer that is NOT modeled through `collections.chain_type`. It uses a parallel registry:

| Table | Purpose | State as of 2026-05-30 |
|---|---|---|
| `evm_chains` | Chain registry (chain_id, name) | 2 chains registered |
| `evm_nft_contracts` | Per-contract indexer targets | 1 active: Beezie Collectibles (`0xbb5ec6fd4b61723bd45c399840f1d868840ca16f` on Base, chain_id 8453) |
| `evm_indexer_cursors` | Per-contract walk-forward cursor | Base cursor at block 43,409,999 |
| `evm_nft_transfers` | Transfer event log, RANGE-partitioned on `block_timestamp` | 1,012,990 rows indexed; 1,828 distinct recipients |

Cron: `/api/cron/evm-transfers-ingest` runs hourly. Proxy: `workers/base-proxy/`. Schema migration: `20260513120000_evm_nft_indexer_schema.sql` (May 13, 2026).

**Architectural tension:** there are now two parallel chain conventions in the DB —

1. `collections.chain_type` enum (`flow | ethereum | polygon | solana | flow_evm`) — used by the Flow-side data plane (editions, sales, wmc, fmv_snapshots, badge_editions).
2. `evm_chains.chain_id` integer registry — used by the EVM-side raw indexer.

When chain-two intelligence surfaces (FMV, badges, holder analytics) are built, the integration question is whether Beezie/Base gets bridged into the `collections` registry (so the existing analytics functions can see it) or stays in the EVM-only side as a parallel data plane.

**Action item (not in this audit):** Trevor decides if Beezie/Base is promoted to "chain-two product surface" or stays "raw-indexer data, no product." This decision sits upstream of the multi-chain-thesis doc's Candy/Solana sequencing.

---

## Cross-references

- Code-side audit (Phase E, Claude Code): pending — see [docs/handoff-2026-05-30-chain-abstraction-phases-cde.md](../handoff-2026-05-30-chain-abstraction-phases-cde.md).
- Strategy: [docs/strategy/multi-chain-thesis-2026-05-30.md](../strategy/multi-chain-thesis-2026-05-30.md). Note: the strategy doc treats Candy/Solana as chain two; the Beezie/Base discovery above may revise that ordering.
- Migration plan: [docs/migrations/chain-abstraction-plan-2026-05-30.md](../migrations/chain-abstraction-plan-2026-05-30.md).

## Summary for Phase F gating

Phase F (drop `collections.chain` DEFAULT) is safe from a DB-audit perspective. No function explicitly inserts into `collections` without a `chain` value once `lib/collections.ts` enforces it at the type level (Phase C). The 50 Tier-2 functions naming Flow slugs are read-only against `collections` — they don't insert.

Phase F can ship 48h after Phase D soak completes, as planned.
