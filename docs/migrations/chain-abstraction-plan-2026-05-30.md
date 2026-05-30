# Chain-Abstraction Schema Plan (Draft 2026-05-30)

**Status:** Approved 2026-05-30. Phases A + B shipped (see below). Phases C/D/E in [docs/handoff-2026-05-30-chain-abstraction-phases-cde.md](../handoff-2026-05-30-chain-abstraction-phases-cde.md). CLAUDE.md updated.

**Companion doc:** [docs/strategy/multi-chain-thesis-2026-05-30.md](../strategy/multi-chain-thesis-2026-05-30.md)

---

## Pre-state discovery (added 2026-05-30 post-verify)

Before applying Phase A, the verification query found that the `collections` table **already had** a `chain` column — typed as a `chain_type` enum (not `text`), NOT NULL, DEFAULT `'flow'::chain_type`. The enum already carried values `flow | ethereum | polygon | solana | flow_evm`. All 5 published collections were already seeded `chain='flow'`.

This is *better* than the original plan's `text` + CHECK approach because (a) enum is type-safe at the column level, (b) it covers `flow_evm` which the plan missed (Flow's EVM-compatible sidechain — relevant if future Flow-ecosystem collections launch on that path).

**What actually shipped (migration `audit_20260530_collection_chains_view_and_chain_index`):**

- `idx_collections_chain` index on the existing column.
- Column comment documenting the multi-chain strategy.
- `collection_chains` view (Phase B as planned).
- Grants to `anon`, `authenticated`, `service_role`.
- View comment.

**What did NOT need to ship (already present):**

- `ALTER TABLE collections ADD COLUMN chain` — column existed.
- CHECK constraint — redundant with the enum.

The original Phase A SQL in this doc below is left in place for historical reference but should be read as "would have applied if column hadn't existed." Phase B is unchanged and shipped as written.

If a future chain target needs an enum value (e.g. `starknet`, `base`), expand via `ALTER TYPE chain_type ADD VALUE '<name>'` rather than rewriting the enum.

---

## Goal

Make `chain` a first-class concept across the schema and data pipeline so that adding chain two (Candy/Solana, conditional on the June 22 audit) is bounded engineering, not architectural rework. **Achieve this with zero behavior change for current Flow operations.**

## Non-goals (this phase)

- Adding a second chain. That's gated on the thesis-doc tripwire.
- Rewriting any FMV / fmv-recalc / badges / squeeze logic.
- Brand or UI changes.
- Retiring Pinnacle's separate FMV pipeline. The parallel-table pattern stays.
- Retiring the long-form/short-form collection-string duality. Flowty teardown handles that separately.
- Worker / proxy infrastructure changes.

## Inventory: where current Flow assumptions live

| Surface | Flow assumption | Multi-chain consideration |
|---|---|---|
| `editions.external_id varchar` | TS-family `setId:playId` integer-pair convention; UUID-on-conflict trigger | Solana asset = mint pubkey (base58). Format varies by chain. Stays text; semantics documented per chain |
| `editions.set_id_onchain int / play_id_onchain int` | Flow-native integer ids | Nullable for non-Flow chains; new chains use other fields |
| `pinnacle_editions` | Separate parallel table, 3-tuple `edition_key` | Precedent: "a collection can have its own table." Pattern carries to new chains if needed |
| `collections.slug` | Long-form ("nba_top_shot") | Add `chain` column to `collections`. Slugs stay; `(chain, slug)` becomes the natural compound key |
| `flowty_transactions.collection` (CHECK) | Short-form ("topshot") | Retired alongside Flowty teardown — out of scope here |
| `sales` (year-partitioned) | Flow tx hash 64-char hex | Solana sig is 88-char base58; column is already text. Partition strategy stays year-based; chain reached via `collection_id` FK |
| `wallet_moments_cache` | UNIQUE `(wallet_address, collection_id, moment_id)`; address is Flow 0x16-hex | Address shape varies by chain; UNIQUE composition stays valid because `collection_id` carries chain |
| `fmv_snapshots` (partitioned) | `algo_version` text is Flow-named ("1.7.0", "allday-gql-v1", etc.); `confidence` enum is generic | Chain reached via `collection_id`; no schema change needed |
| `badge_editions` | Joined to editions via `external_id` text | Chain reached via `collection_id`; no schema change needed |
| `linked_accounts` | Flow HybridCustody populator only | Schema is generic text-text; populator is Flow-only. New chain = new populator |
| `cached_listings_v2.source` | "direct" / "direct_v1" / "flowty" / sentinel | Source values extend per chain |
| Workers / proxies | All Flow / sports-data | New chain = new worker auth surface (e.g. `helius-proxy`) — out of scope here |
| `lib/collections.ts` | 8 entries, no chain field | Add `chain` field per entry |
| `/api/*` routes | Filter by `collection_id` or slug | Most are chain-implicit via FK and need no change. Audit pass enumerates the exceptions |
| `/[collection]` route segment | Assumes Flow flavor in some components | UI is later; schema doesn't constrain it |

## Target schema shape

Cheapest viable change to get chain-as-first-class:

1. **Add `collections.chain text NOT NULL DEFAULT 'flow'`.** Backfilled to `'flow'` for all 8 existing rows. CHECK constraint expandable: `chain IN ('flow','solana','ethereum','polygon','starknet','base','arbitrum','optimism')`. If the chain list grows past ~10 within 12 months, promote to a `chains` lookup table.

2. **Chain lives on `collections`, not on every dependent table.** Every dependent row already has `collection_id` (FK to collections). Adding `chain` columns to `editions`, `sales`, `wmc`, `fmv_snapshots`, etc. would just duplicate `collections.chain` via the FK chain. Avoid the duplication.

3. **New view `collection_chains(collection_id, chain, slug, name)`** for ergonomic joins. Anywhere a query needs chain context, it joins this view.

4. **`editions.external_id` semantics stay** — documented as "chain-native canonical id format, varies by chain." Existing format-validation triggers stay collection-scoped, never global.

5. **`lib/collections.ts` gets `chain: 'flow' | 'solana' | ...`** on each entry. Routes and ingest read chain from the registry, not by inferring from slug.

6. **Code organization: introduce `lib/chains/flow/`.** Move (don't rewrite) Flow-specific primitives there. Future chains plug into the same interface shape: `resolveAddress`, `fetchTx`, `normalizeEdition`, `indexEvents`. Re-exports at the old paths keep all callers working without touch.

## Phased migration

Each phase is independently shippable, zero-downtime, and reversible.

### Phase A — schema additions only (DB)

```sql
-- audit_2026XXXX_collections_add_chain
ALTER TABLE collections
  ADD COLUMN chain text NOT NULL DEFAULT 'flow';

ALTER TABLE collections
  ADD CONSTRAINT collections_chain_check
  CHECK (chain IN (
    'flow','solana','ethereum','polygon',
    'starknet','base','arbitrum','optimism'
  ));

CREATE INDEX IF NOT EXISTS idx_collections_chain ON collections(chain);
```

- **Behavior change:** none. Every existing INSERT continues working (DEFAULT).
- **Rollback:** `ALTER TABLE collections DROP COLUMN chain CASCADE` (drops the view from Phase B too — fine because the view is read-only).
- **Smoke:** `SELECT chain, COUNT(*) FROM collections GROUP BY chain` should return one row, `flow=8`.
- **Apply via:** MCP `apply_migration`.

### Phase B — ergonomic view (DB)

```sql
-- audit_2026XXXX_collection_chains_view
CREATE OR REPLACE VIEW collection_chains AS
  SELECT id AS collection_id, chain, slug, name
  FROM collections;

GRANT SELECT ON collection_chains TO anon, authenticated, service_role;
```

- **Behavior change:** none. New view available for read-path joins.
- **Rollback:** `DROP VIEW collection_chains`.
- **Apply via:** MCP `apply_migration`.

### Phase C — `lib/collections.ts` chain field (code, Claude Code)

Each registry entry gains `chain: 'flow' as const`. No callers read it yet. TypeScript compile passes because the field is additive.

```ts
// example shape
{
  slug: 'nba_top_shot',
  chain: 'flow' as const,
  collectionId: '95f28a17-224a-4025-96ad-adf8a4c63bfd',
  // ...existing fields
}
```

- **Behavior change:** none. New field is unread.
- **Rollback:** revert commit.
- **Smoke:** `npx tsc --noEmit` clean.
- **Apply via:** Claude Code (route/.tsx code can't push from Cowork — see memory `cowork-deploy-split`).

### Phase D — ingest module reorganization (code, Claude Code)

- Create `lib/chains/flow/index.ts` exporting the chain primitives.
- Move (don't rewrite) Flow-specific helpers from `lib/flow-helpers.ts`, `lib/cadence/*`, `lib/wallet-backfill-helpers.ts`, etc. under the new dir.
- Existing import paths get re-exports so callers keep working without touch.
- No route or cron behavior change.

This is the largest single PR but has zero runtime risk because nothing is rewritten — just re-located with shim re-exports.

- **Estimate:** 2-3 days reorganization + ~1 day smoke testing.
- **Smoke:** all 23 cron pipelines green for 24h post-deploy; `/api/health` 200; sentinel tripwires unchanged.
- **Rollback:** revert commit (re-exports mean rollback is a no-op for downstream code).
- **Apply via:** Claude Code.

### Phase E — chain-aware reads audit (no code change)

Walk every surface that filters by collection. For each, label one of:

- **chain-internal** — reads collection by `collection_id` or registry slug; chain is implicit via FK. No change needed.
- **assumes-Flow** — explicitly relies on Flow shapes (e.g. Cadence event parsing, FCL wallet auth, Top Shot GQL fetches). Stays Flow-scoped by design.
- **needs-chain-dispatch** — generic enough that it should route by chain when chain two arrives. Annotate with TODO; defer the dispatch to chain-two work.

Output is a checklist committed to `docs/audits/chain-aware-reads-2026-XX-XX.md`, not a code change.

- **Estimate:** ~1 day.
- **Apply via:** Claude Code or Cowork doc-only.

### Phase F — drop the DEFAULT (DB)

After all Flow collections have explicit `chain='flow'` rows, drop the DEFAULT so future inserts must specify chain.

```sql
ALTER TABLE collections ALTER COLUMN chain DROP DEFAULT;
```

- **Behavior change:** none for existing rows. New collection inserts must specify chain.
- **Rollback:** `ALTER TABLE collections ALTER COLUMN chain SET DEFAULT 'flow'`.
- **Apply via:** MCP `apply_migration`.

## Cron impact

**Zero crons change in Phases A-F.** The 23 active cron jobs all run against Flow-specific endpoints; none read `collections.chain` today. New chain crons are added during chain-two work, not this refactor.

## Worker / proxy impact

**Zero worker changes in Phases A-F.** Flow proxies stay (`topshot-proxy`, `allday-proxy`, `pinnacle-proxy`, `spork-proxy`, `hybrid-custody-proxy`, plus the data proxies `rpc-sports-proxy`, `odds-proxy`, `reddit-proxy`). Chain-two worker (e.g. `helius-proxy`) is added during chain-two work and gets its own auth-secret surface — never shared with `TS_PROXY_SECRET`.

## Concierge / public API impact

- **`/api/support-chat` tools:** no immediate change. Tools are collection-aware via `collection_id`; chain is implicit. Chain-aware tools are added during chain-two work.
- **`/api/public/insights/squeeze`** and the live artifact dashboards: chain-implicit via `collection_id`; no change.
- **`/api/fmv`** (public, no auth): no change — keyed by edition, chain-implicit.

## Open risks & mitigations

| Risk | Mitigation |
|---|---|
| CHECK constraint locks chain enum too early | If the chain list grows past ~10 within 12 months, promote to a `chains` lookup table. Defer; CHECK is fine for chain two |
| Flow-specific code paths assume integer-pair external_id (e.g. `editions_block_topshot_uuid_dupe_trg`) | Triggers stay collection-scoped via `WHERE collection_id IN (...)`; no global format change. Already the existing pattern |
| FMV-confidence calibration mismatch when chain two arrives | Chain-aware confidence is a chain-two concern. `algo_version` text absorbs new algos without schema change |
| cron-job.org ceiling | Each new chain adds 5-10 pipelines. Pro plan is the cheap fix; not needed until chain three |
| Tier vocabulary divergence | Tier values are already text per collection (TS uses `tier_type` enum; UFC/Pinnacle use their own). No global enum change required |
| Re-export shims in Phase D get stale and end up imported permanently | Add a follow-up task in Phase E annotations: "rename to canonical import after chain two ships" |

## Estimate

| Phase | Estimate | Deploy surface |
|---|---|---|
| A — schema additions | ~30 min including verify | MCP `apply_migration` |
| B — ergonomic view | ~10 min | MCP `apply_migration` |
| C — collections.ts chain field | ~1 h | Claude Code |
| D — ingest module reorganization | 2-3 days + 1 day smoke | Claude Code |
| E — chain-aware reads audit | ~1 day | Cowork or Claude Code |
| F — drop the DEFAULT | ~10 min | MCP `apply_migration` |

**Total: ~1 week of focused solo work.** Phases A, B, F are MCP-applicable from Cowork. Phase D is the bulk and lands via Claude Code (per the cowork-deploy-split memory).

## What's NOT in this plan

- Solana indexer architecture — chain-two concern, awaiting the June 22 audit.
- Metaplex Core asset model integration — chain-two concern.
- Sorare / Starknet considerations — chain-two fallback design, post-audit.
- EVM-family foundation — deferred; revisit if EVM sports collectibles consolidate.
- New brand domain / sub-brand — none planned. Brand stays "Rip Packs City."
- Tagline change — defers until chain two ships visible product.

## Decisions Trevor owns before execution starts

1. Confirm Thesis B in the strategy doc.
2. Approve the CHECK constraint enum values (or override to lookup-table pattern).
3. Approve `lib/chains/flow/` as the directory convention.
4. Approve order A-F sequential, no skipping.
5. Confirm CLAUDE.md updates wait until Phase A is applied (i.e. real schema lands first, doc updates follow).

## Working assumption

This plan is deliberately conservative. The goal is to make multi-chain *possible* without committing to it. Every phase is reversible. If the June 22 Candy audit fails and Sorare fails its own audit, the chain-abstraction work still has value: a cleaner separation of Flow-specific from chain-generic code is good hygiene even in a single-chain world.
