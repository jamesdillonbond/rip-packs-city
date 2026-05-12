# MCP Tool → Backing RPC Mapping

Authoritative mapping between the worker-facing MCP tools (advertised to agents via the tool-schema descriptions) and the live-DB RPCs that back them. Every adapter is a thin translation layer; **none of these tools reimplement pricing, badge, set-progress, or wallet-portfolio business logic** — that belongs in the underlying RPCs.

Status as of 2026-05-12. The worker (`rpc-mcp-proxy` Cloudflare Worker) ships in Track D.

## Tool table

| MCP tool | Adapter (SECDEF, service_role) | Backing RPC | Adapter scope |
|---|---|---|---|
| `get_fmv` | `mcp_get_fmv(edition_key, collection_slug, serial?)` | `get_fmv_for_editions` + direct `fmv_snapshots` read | External-id → uuid resolution |
| `compute_pack_ev` | `mcp_compute_pack_ev(dist_id)` | `compute_pack_ev_from_pool` | Looks up `pack_distributions` row, extracts price/slots from `metadata` jsonb |
| `get_badge_data` | `mcp_get_badge_data(edition_key, collection_slug)` | `get_edition_badges_unified` | External-id → uuid resolution + EXCEPTION guard on backing-RPC failure |
| `find_set_completion` | `mcp_find_set_completion(wallet, collection_slug, set_id)` | `get_topshot_set_progress` / `get_allday_set_progress` + composed `editions` / `wmc` / `badge_editions` / `cached_listings` query | Filters set-progress jsonb to `setId` at SQL level (avoids 370KB payload); composes full missing-edition list because upstream RPC only emits top-5 |
| `get_sniper_deals` | — *(worker calls backing RPC directly)* | `get_top_deals` (TS) / `get_allday_sniper_deals` (AllDay) | No external-id translation needed |
| `lookup_wallet` | — *(worker calls backing RPC directly)* | `holdings_summary` and/or `get_wallet_portfolio` | wallet_address is already the external key |

All adapters return `jsonb` and include a `gaps text[]` array. Gap entries follow `<dimension>_<reason>` to give agents a stable pattern-match surface.

---

## `get_fmv`

**MCP tool signature** (worker-facing, advertised in tool schema):
```
get_fmv(edition_key: string, collection_slug: string, serial?: integer) -> object
```

**Adapter**: `public.mcp_get_fmv(p_edition_key text, p_collection_slug text, p_serial integer default null) returns jsonb`

**Backing RPC**: `public.get_fmv_for_editions(p_collection_id uuid, p_edition_ids uuid[]) returns TABLE(edition_id uuid, fmv_usd numeric)`

The adapter reads `fmv_snapshots` directly rather than going through `get_fmv_for_editions`, because the snapshot table exposes the rich distribution-shape signal (`wap_usd`, `wap_without_outliers`, `sales_count_7d/30d`, `days_since_sale`, `liquidity_rating`, per-source asks) that the agent needs. `get_fmv_for_editions` returns only `(edition_id, fmv_usd)`. Both paths are honest.

**Why two args**: `editions.external_id` is unique within a collection, NOT globally. AllDay and Golazos both use plain-integer external_ids ("1", "10", "100" all exist in both), so a one-arg `(edition_key)` signature would be ambiguous.

**Known gaps** (always emitted in `gaps` array as applicable):
- `percentile_distribution_not_persisted` — always present. `fmv_snapshots` stores point estimates and per-source asks; p10/p50/p90 are not computed or stored. The concierge `get_fmv` tool computes them on-the-fly from `sales` (separate surface), but the MCP path doesn't.
- `no_fmv_snapshot_for_edition` — edition exists but has never been priced.
- `top_shot_ask_unavailable` / `flowty_ask_unavailable` — per-source ask was null in the latest snapshot.
- `liquidity_rating_unavailable` — liquidity_rating column was null.
- `pinnacle_direct_ask_not_yet_in_fmv_snapshots` — Disney Pinnacle's direct-ASK pipeline (shipped 2026-05-11) writes to `pinnacle_editions.ask_source='pinnacle_direct'`, NOT to `fmv_snapshots`. The MCP surface will see NULL asks for Pinnacle until Phase 2C reconcile feeds the snapshot table.

**Example invocation**:
```sql
select public.mcp_get_fmv(
  '9e444420-9ae1-4a6a-a42d-ce94e2089af1:5a567d2a-a155-45ba-9323-f330305c16bb',
  'nba_top_shot',
  7
);
-- returns { edition_id, collection_slug, external_id, fmv_usd: 220, serial_mult: 4.5,
--           adjusted_fmv: 990, confidence: 'STALE', gaps: ['percentile_distribution_not_persisted', ...] }
```

---

## `compute_pack_ev`

**MCP tool signature**:
```
compute_pack_ev(dist_id: string) -> object
```

The worker-facing tool name in the MCP schema may read more naturally as `pack_id`; the adapter parameter intentionally uses `dist_id` to match the underlying `pack_distributions.dist_id text` column and `compute_pack_ev_from_pool`'s second arg. Worker translates at its boundary.

**Adapter**: `public.mcp_compute_pack_ev(p_dist_id text) returns jsonb`

**Backing RPC**: `public.compute_pack_ev_from_pool(p_collection_id uuid, p_dist_id text, p_pack_price numeric, p_slots integer) returns jsonb`

**External-id translation**: all four inputs to the backing RPC come from a single `pack_distributions` row.
- `collection_id` → `pack_distributions.collection_id` (already uuid)
- `dist_id` → passthrough
- `pack_price` → `pack_distributions.metadata->>'retail_price_usd'`
- `slots` → `pack_distributions.metadata->>'number_of_pack_slots'`

**Known gaps**:
- `pack_not_found_<dist_id>` — no row in `pack_distributions`.
- `pack_price_missing_from_metadata` / `slots_missing_from_metadata` — metadata jsonb keys absent (rare; usually only for old or malformed rows).
- `ev_skipped_missing_inputs` — pack found, but missing price or slots, so EV computation was not attempted.
- `compute_pack_ev_from_pool_raised_<sqlerrm>` — backing RPC threw an exception. EXCEPTION-guarded so the adapter doesn't crash.

**Example invocation**:
```sql
select public.mcp_compute_pack_ev('1765');
-- returns { dist_id: '1765', pack_title: 'WNBA Holo Icon Quick Rip', pack_price: 3, slots: 1,
--           ev: { ok: false, reason: 'pool_empty', dist_id: '1765' }, gaps: [] }
```

Note: `ev: { ok: false, reason: 'pool_empty' }` is an honest verdict from the backing RPC, not an adapter error. Use it to teach agents that pool-depletion means no buyable pack.

---

## `get_badge_data`

**MCP tool signature**:
```
get_badge_data(edition_key: string, collection_slug: string) -> object
```

**Adapter**: `public.mcp_get_badge_data(p_edition_key text, p_collection_slug text) returns jsonb`

**Backing RPC**: `public.get_edition_badges_unified(p_edition_id uuid) returns jsonb`

**External-id translation**: same as `get_fmv` — `(collection_slug, external_id) → edition_id uuid`.

**Known gaps**:
- `no_badge_data_for_edition` — backing RPC returned null/empty.
- `badge_premium_data_only_robust_for_nba_top_shot` — `badge_editions` table is TopShot-shaped (other collections have minimal or zero badge coverage).
- `backing_rpc_get_edition_badges_unified_raised_<sqlerrm>` — adapter EXCEPTION-guards the backing call. **As of 2026-05-12, the backing RPC raises `function unaccent(text) does not exist` because its hardened `search_path` doesn't include the `extensions` schema where `unaccent` lives.** This is a separate backing-RPC bug, tracked outside Track C scope. The adapter degrades to `badges: {}` and surfaces the upstream error in `gaps` rather than 5xx'ing.

**Example invocation**:
```sql
select public.mcp_get_badge_data(
  '9e444420-9ae1-4a6a-a42d-ce94e2089af1:5a567d2a-a155-45ba-9323-f330305c16bb',
  'nba_top_shot'
);
-- returns { edition_id, collection_slug, badges: {},
--           gaps: ['backing_rpc_get_edition_badges_unified_raised_function_unaccent_text_does_not_exist',
--                  'no_badge_data_for_edition'] }
-- (until the backing-RPC search_path is fixed)
```

---

## `find_set_completion`

**MCP tool signature**:
```
find_set_completion(wallet: string, collection_slug: string, set_id: string) -> object
```

**Adapter**: `public.mcp_find_set_completion(p_wallet text, p_collection_slug text, p_set_id text) returns jsonb`

**Backing RPCs**:
- `public.get_topshot_set_progress(p_wallet text, p_collection_id uuid) returns jsonb`
- `public.get_allday_set_progress(p_wallet text, p_collection_id uuid) returns jsonb`

**Composition**: the upstream RPCs return ALL sets the wallet has any progress in (~370KB jsonb per TopShot wallet) and the per-set `missingPreview` is only the top-5 by FMV. The adapter:
1. Calls the upstream RPC, filters to `setId == p_set_id` via `jsonb_array_elements` — never passes the full payload through.
2. Runs a direct `editions LEFT JOIN (badge_editions | cached_listings)` query to assemble the FULL missing-edition list, each with `cheapest_ask` + `cheapest_ask_source`.
3. Sums available `cheapest_ask` values for `total_completion_usd` (different from the backing RPC's FMV-based `estimatedCostToComplete` — both are returned so the agent sees both lenses).

**Ask sources**:
- TopShot: `badge_editions.low_ask` (canonical TS ask source; `get_collection_stats.listing_count` reads from here). `cheapest_ask_source = 'topshot'`.
- AllDay: `badge_editions.low_ask` coverage is ~0% (known issue). Uses `cached_listings min(ask_price)` grouped by `(collection_id, set_name, player_name)`. `cheapest_ask_source = 'flowty' | 'topshot' | null` from the source column.

**Per-edition gap rule**: a missing edition with no current ask is NOT dropped from the result. Instead, a `cheapest_ask_unavailable_for_<external_id>` entry is appended to `gaps`. Agents that want to buy what's available see the full set.

**Unsupported collections** (return `{supported: false, reason: <text>}`):
- `disney_pinnacle` / `ufc_strike` → `deferred_pending_consistent_signature`. RPCs exist but with inconsistent signatures (Pinnacle has no `collection_id` arg; UFC needs separate verification). Track C-prime will add these once signatures are normalized.
- `laliga_golazos` → `set_progress_rpc_not_implemented`. No backing RPC exists.

**Known gaps**:
- `set_id_not_uuid_full_missing_list_skipped` — `set_id` couldn't be parsed as uuid; overview returned from upstream but full missing list skipped.
- `set_not_in_wallet_progress_payload` — overview RPC didn't include the requested set (wallet owns zero pieces, or set_id doesn't exist).
- `cheapest_ask_unavailable_for_<external_id>` — per missing edition with no current ask.

**Example invocation**:
```sql
select public.mcp_find_set_completion(
  '0xbd94cade097e50ac',
  'nba_top_shot',
  '5b218b5e-4897-4a06-a60f-a40ef2c40ff9'
);
-- returns {
--   supported: true, set_name: 'Rookie Debut', set_tier: 'COMMON', series: 8,
--   owned_count: 58, total_count: 61, missing_count: 3, completion_pct: 95.1,
--   total_completion_usd: 3757,
--   estimated_cost_to_complete_rpc: 199.1,
--   missing_editions: [
--     { external_id, player_name: 'Maxime Raynaud', cheapest_ask: 77, cheapest_ask_source: 'topshot', ... },
--     { external_id, player_name: 'Dylan Harper', cheapest_ask: 448, cheapest_ask_source: 'topshot', ... },
--     { external_id, player_name: 'Cooper Flagg', cheapest_ask: 3232, cheapest_ask_source: 'topshot', ... }
--   ],
--   gaps: []
-- }
```

The `total_completion_usd` ($3757) is much higher than the upstream RPC's `estimated_cost_to_complete_rpc` ($199.10) because the adapter uses current ASK prices while the RPC uses average FMV. Both are returned so agents can choose the appropriate lens.

---

## `get_sniper_deals` *(no adapter — worker wraps directly)*

**MCP tool signature**:
```
get_sniper_deals(collection_slug: string, min_discount_pct?: number,
                 max_price?: number, limit?: integer, ...) -> array
```

**Backing RPCs** (the worker dispatches by `collection_slug`):
- **TopShot** → `public.get_top_deals(p_player text, p_team text, p_tier text, p_max_price numeric, p_min_discount numeric, p_has_badge boolean, p_limit integer, p_collection_id uuid) returns TABLE(player_name, team, tier, set_name, series_number, low_ask, fmv_usd, confidence, discount_pct, circulation_count, play_tags, external_id)`
- **AllDay** → `public.get_allday_sniper_deals(p_min_discount numeric, p_max_price numeric, p_rarity text, p_team text, p_sort_by text, p_limit integer) returns TABLE(flow_id, moment_id, player_name, team_name, set_name, series_name, tier, serial_number, circulation_count, ask_price, fmv_usd, discount_pct, confidence, buy_url, thumbnail_url, listing_resource_id, source, listed_at)`

**No adapter** because the worker can translate `collection_slug → collection_id` inline (it already has the slug→uuid map for `get_fmv`), and the rest of the parameters are first-class.

**Known gaps** (worker-emitted):
- `golazos_no_sniper_rpc_yet` / `pinnacle_no_sniper_rpc_yet` / `ufc_no_sniper_rpc_yet` — only TopShot and AllDay have backing RPCs today. The worker will return `{ supported: false, reason: 'no_sniper_rpc_for_<slug>' }` for the others.

---

## `lookup_wallet` *(no adapter — worker wraps directly)*

**MCP tool signature**:
```
lookup_wallet(wallet_address: string, collection_slug?: string) -> object
```

**Backing RPCs**:
- `public.holdings_summary(p_wallet text) returns jsonb` — cross-collection rollup
- `public.get_wallet_portfolio(p_wallet_address text) returns jsonb` — full portfolio with per-collection breakouts

**No adapter** because `wallet_address` is already the external key — no uuid translation needed. The worker calls both RPCs (or one, depending on the `collection_slug` filter) and composes the response.

**Known gaps** (worker-emitted):
- `wallet_never_indexed` — wallet has no rows in `wallet_moments_cache`.
- `parent_child_linkage_not_collapsed` — if the agent wants canonical-owner-collapsed totals, the worker should also query `linked_accounts` + `analytics_sales_resolved` (see RPC_DESIGN_SYSTEM §6).

---

## Coverage matrix at a glance

| | TS | AllDay | Golazos | Pinnacle | UFC |
|---|---|---|---|---|---|
| `get_fmv` | ✅ | ✅ | ✅ (sparse) | ✅ (sparse, no direct ASK in snapshots) | ✅ (sparse) |
| `compute_pack_ev` | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| `get_badge_data` | ⚠️ blocked by backing-RPC bug | ⚠️ thin coverage | ⚠️ thin | ⚠️ thin | ⚠️ thin |
| `find_set_completion` | ✅ | ✅ | ❌ no upstream RPC | ⏸ deferred | ⏸ deferred |
| `get_sniper_deals` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `lookup_wallet` | ✅ | ✅ | ✅ | ✅ | ✅ |

✅ supported · ⚠️ supported with degraded coverage (always reflected in gaps) · ⏸ deferred (returns `supported:false`) · ❌ unsupported

---

## Migration history

The adapters were applied to the live DB across three migrations on 2026-05-12:

| Version | File | Purpose |
|---|---|---|
| `20260512171327` | `mcp_phase1c_wrap_adapters.sql` | Original migration creating all four adapters |
| `20260512171636` | `mcp_phase1c_wrap_adapters_fix_gaps_operator.sql` | Hot-fix: replaced `text[] \|\| 'literal'` with `array_append` to dodge Postgres operator-resolution ambiguity (22P02 malformed-array-literal) |
| `20260512171732` | `mcp_phase1c_badge_adapter_exception_guard.sql` | Wrapped the `get_edition_badges_unified` call in an EXCEPTION block so the backing RPC's `unaccent`/search_path bug doesn't crash the adapter |

A future migration will tighten `get_edition_badges_unified` to qualify `unaccent` against the `extensions` schema. Once that ships, the gap `backing_rpc_get_edition_badges_unified_raised_function_unaccent_text_does_not_exist` will stop appearing.

---

*Living doc — update when adapters change, backing RPCs are renamed, or coverage gaps close.*
