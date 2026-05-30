# Chain Abstraction — Phases C, D, E (Claude Code Handoff)

**Created 2026-05-30.** Phases A and B shipped via Cowork on the same date (migration `audit_20260530_collection_chains_view_and_chain_index`).

**Context.** Trevor approved Thesis B on 2026-05-30: RPC is a sports/IP collectibles intelligence platform, Flow is chain one of N. Chain two = Solana / Candy Digital, gated on a July-8-or-later audit. The schema additions live in production with zero behavior change (chain column preexisted as `chain_type` enum; only the `collection_chains` view, the `idx_collections_chain` index, and column/view comments actually shipped).

This handoff covers the three remaining code-side phases. None of them ship from Cowork because routes and `lib/*` modules need git push.

**Strategy + plan:**
- [docs/strategy/multi-chain-thesis-2026-05-30.md](strategy/multi-chain-thesis-2026-05-30.md)
- [docs/migrations/chain-abstraction-plan-2026-05-30.md](migrations/chain-abstraction-plan-2026-05-30.md)

**Rules (non-negotiable):**
- Direct-to-main, no PRs.
- Verify Supabase row counts and Vercel deploy status before considering a phase done.
- Do NOT change route handler behavior, cron behavior, or public API shapes in any of these phases.
- Do NOT add Solana code. Chain-two implementation is gated on the July-8 audit.
- Do NOT change the public tagline.

---

## Phase C — `lib/collections.ts` chain field

**Goal:** every registry entry carries an explicit `chain: 'flow'`. TS compile pass is the only smoke needed.

**Files:**
- `lib/collections.ts` (the registry array + the entry type definition).

**Changes:**

1. Update the entry-type definition to require `chain` from the `chain_type` enum union:

   ```ts
   export type ChainType =
     | 'flow'
     | 'ethereum'
     | 'polygon'
     | 'solana'
     | 'flow_evm';

   export type CollectionRegistryEntry = {
     slug: string;
     chain: ChainType;
     collectionId: string;
     // ...existing fields
   };
   ```

   Match the field name your registry already uses (`CollectionDefinition`, `CollectionConfig`, whatever — read first).

2. Add `chain: 'flow' as const,` to every entry in the registry array. All 8 entries (5 published, 3 unpublished placeholders) get `'flow'`.

3. Export `ChainType` for downstream consumers.

**Smoke:** `npx tsc --noEmit` clean. No runtime tests needed — the field is unread.

**Commit message:** `feat(collections): add chain field to registry entries (chain one of N)`

**Rollback:** revert commit.

---

## Phase D — `lib/chains/flow/` reorganization

**Goal:** move (don't rewrite) Flow-specific primitives under `lib/chains/flow/`. Maintain re-exports at the original import paths so no caller breaks. Zero behavior change.

**Files to relocate:**

| From | To | Notes |
|---|---|---|
| `lib/flow-helpers.ts` (if it exists by that or similar name — grep first) | `lib/chains/flow/helpers.ts` | |
| `lib/cadence/*.ts` | `lib/chains/flow/cadence/*.ts` | Whole directory; ~per-collection Cadence scripts |
| `lib/wallet-backfill-helpers.ts` | `lib/chains/flow/wallet-backfill.ts` | |
| `lib/topshot-graphql.ts` (or equivalent) | `lib/chains/flow/topshot-graphql.ts` | |
| `lib/alldayGraphql.ts` | `lib/chains/flow/allday-graphql.ts` | |
| `lib/dapper-v1-tx-decode.ts` | `lib/chains/flow/dapper-v1-tx-decode.ts` | |
| `lib/flowty-tx-classifier.ts` | `lib/chains/flow/flowty-tx-classifier.ts` | Historical archive, but Flow-specific |

**Files that STAY at top level (chain-agnostic):**

- `lib/fmv-confidence.ts` — calibration is Flow-tuned today but the abstraction is chain-agnostic; chain-two work may add chain-aware calibration as a future change.
- `lib/collections.ts` — registry; multi-chain by design.
- `lib/cart/CartContext.tsx` — UI-side cart (shelved anyway).
- Anything under `lib/utils/`, generic schemas, or non-chain-specific helpers.

**Procedure per file:**

1. Read the file to confirm contents.
2. Create the new location with identical content (use `git mv` when possible to preserve blame).
3. Replace the old file's contents with a shim re-export:

   ```ts
   // Backward-compat shim — see lib/chains/flow/<name>.ts for the canonical implementation.
   export * from './chains/flow/<new-name>';
   ```

4. Do NOT touch any caller's import path in this phase. Shims keep them green.

**After all moves:**

- `npx tsc --noEmit` clean.
- `npm run build` clean.
- Smoke-deploy to preview, confirm `/api/health` returns 200, hit `/api/sniper-feed` and `/api/edition-stats` against production data, watch for any 500s.

**24-hour soak check (post-deploy to production):**

- All 23 cron pipelines green (check `pipeline_runs` for `ok=false` rate vs. the prior 7-day baseline — if elevated, suspect a shim that broke a type-narrow inference).
- Sentinel tripwires unchanged.
- No new error rate on Vercel runtime logs.

**Commit message:** `refactor(lib/chains/flow): relocate Flow-specific primitives, keep shims for back-compat`

**Rollback:** revert commit. Shims mean rollback is a no-op for callers.

**Follow-up (not in this phase):** add a task to rename callers to canonical paths after chain two ships. The shims should be temporary.

---

## Phase E — Chain-aware reads audit

**Goal:** classify every surface that filters by collection so we know what changes (and what doesn't) when chain two arrives. No code change in this phase.

**Output:** `docs/audits/chain-aware-reads-2026-05-30.md` with a single big table:

| File / surface | Filter shape | Classification | Notes |
|---|---|---|---|

**Three classifications:**

- **chain-internal** — reads collection by `collection_id` (FK) or registry slug; chain is implicit. Solana data flowing through the same query path Just Works because chain is reached via FK. No change needed when chain two arrives.
- **assumes-Flow** — explicitly relies on Flow shapes (Cadence event parsing, FCL wallet auth, Top Shot GQL fetches, `setID:playID` integer-pair external_id format, Flow `0x16`-hex wallet addresses, etc.). Stays Flow-scoped by design. Chain two = parallel Solana equivalents under `lib/chains/solana/`, not a shared dispatch.
- **needs-chain-dispatch** — generic enough that it should branch on chain when chain two arrives. Annotate with `TODO(chain-dispatch)` and defer the dispatch to chain-two work.

**Surfaces to walk (non-exhaustive — pad as you find more):**

- All `/api/*` routes — focus on: `sniper-feed`, `fmv*`, `listing*`, `market*`, `sales*`, `sniper*`, `wallet-backfill*`, `seed-wallet-refresh`, `moment-market`, `pack-ev`, `badges`, `edition-stats`, `collection-snapshot`, `overview-stats`.
- All `/api/cron/*` handlers (`stale-fmv-monitor`, `refresh-pack-grail-metrics-mv`, `backfill-pack-rip-metadata`, etc.).
- All `/api/public/*` routes (`/api/public/insights/squeeze`, `/api/public/profile/[username]`, etc.).
- All files moved under `lib/chains/flow/` post-Phase-D — these are by definition assumes-Flow, document that briefly.
- The concierge tools in `/api/support-chat/route.ts` (5 tools — `get_fmv`, etc.).
- Edge functions in `supabase/functions/*` — currently all Flow / sports-data; classify.
- The 18+ Supabase RPCs that read `wmc.tier` directly — Flow-internal because `wmc` is keyed by `collection_id`; tier vocabulary is per-collection so this is fine.
- `generateMetadata` exports in `app/(collections)/*` pages.

**Important — do not gate Phase F on this audit being comprehensive.** Phase E is a planning artifact; Phase F (drop the DEFAULT) only requires that `lib/collections.ts` enforces chain at the type level, which Phase C delivers.

**Commit message:** `docs(audits): chain-aware reads classification (Phase E)`

---

## Phase F gating (do NOT do in this handoff)

After Phases C and D are stable for 48h in production:

```sql
-- audit_20260XXX_collections_chain_drop_default
ALTER TABLE collections ALTER COLUMN chain DROP DEFAULT;
```

This forces every future collection insert to specify chain explicitly. Rollback: `SET DEFAULT 'flow'::chain_type`. Apply via MCP from Cowork — no code coupling.

---

## What this handoff does NOT touch

- Adding a Solana indexer.
- Building a Helius / Triton proxy worker.
- Metaplex Core asset model integration.
- Any change to the `chain_type` enum (the current values cover what's needed).
- The public site tagline.
- UI/UX shape for multi-chain (`/[collection]` route segment stays as-is).
- FMV-confidence per-chain calibration.
- Cron-pipeline expansion (no new chain pipelines added).
- Brand identity or domain.

---

## Verification checklist (for Trevor to gate "phase complete")

- [ ] Phase C: `npx tsc --noEmit` clean; `lib/collections.ts` shows `chain: 'flow' as const` on every entry; `ChainType` exported.
- [ ] Phase D: `lib/chains/flow/` exists; original import paths still resolve via shims; production deploy green; 24h cron soak clean.
- [ ] Phase E: `docs/audits/chain-aware-reads-2026-05-30.md` exists with the full surface table; CLAUDE.md "Chain strategy" section updated with the link.
- [ ] Phase F (separate, deferred): DEFAULT dropped post-soak.

## Rough estimate

| Phase | Estimate |
|---|---|
| C | ~1 hour |
| D | 2-3 days reorg + 1-day smoke + 24h soak |
| E | ~1 day |
| F | ~10 min (separate Cowork session post-soak) |

Total: ~1 week from Phase C start to Phase F apply.
