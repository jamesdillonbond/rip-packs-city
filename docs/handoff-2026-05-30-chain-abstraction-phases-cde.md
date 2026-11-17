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

## Phase C — `lib/collections.ts` two-field model (SHIPPED 2026-05-30, `d9323f9`)

**Status:** complete. Commit `d9323f9` on `main`, deploy `dpl_BZLeeiot4EYSQo6qPeBQENN9cno3` READY in production. What actually landed in [lib/collections.ts](../lib/collections.ts): `ChainType` export mirrors the Postgres `chain_type` enum exactly; `dbChain?: ChainType | null` added to the `Collection` interface (optional, not the non-optional shape the spec below described — safer against any Collection literal in the file not visible at write time); `dbChain: 'flow'` on the 5 published entries (Top Shot, All Day, Pinnacle, Golazos, UFC); `dbChain: null` on the 3 unpublished placeholders (panini, candy, rwa). Existing `chain` field untouched.

**Handoff inaccuracies Trevor caught and adapted around:**

- The spec below described an entry shape with `slug`/`status`/`CollectionRegistryEntry`/`Record` — none of which exist. The real file uses `id`/`published: boolean`/the `Collection` interface and a `COLLECTIONS` array.
- The spec showed `dbChain: ChainType | null` (non-optional). Trevor shipped it optional (`dbChain?: ChainType | null`) for safety against Collection literals not visible mid-edit. Strictly safer; fully delivers the intent.

The spec below is retained for context but reads as a record of what was asked, not what shipped.

---

**Original framing (now historical):** the handoff that preceded the actual ship.

**Was-blocked-on:** the prior handoff said "set all 8 entries to `chain: 'flow' as const`." That instruction was wrong — `lib/collections.ts` already has a `chain` field typed `"flow" | "evm" | "panini" | "candy" | "rwa"`, where the 3 unpublished placeholders (Panini, Candy MLB, generic RWA) use the non-flow values as roadmap/partner labels. Forcing those to `'flow'` would assert false roadmap info (Candy MLB isn't on Flow).

**Working call (2026-05-30, Trevor approved):** the existing `chain` field stays as the partner/roadmap label. Add a separate `ChainType` export that mirrors the DB `chain_type` enum, plus an optional `dbChain: ChainType | null` field on each entry that mirrors the DB chain for published collections (`null` for unpublished placeholders that aren't seeded in `collections` yet). Two-field model — least disruptive to existing callers of `.chain`, makes the registry honest, and unblocks Phase F.

**Files:**
- `lib/collections.ts` only.

**Changes:**

1. Add a `ChainType` export matching the Postgres `chain_type` enum exactly:

   ```ts
   /**
    * Mirrors the Postgres `chain_type` enum in `public.collections.chain`.
    * Expand via `ALTER TYPE chain_type ADD VALUE '<name>'` when a new
    * target chain is approved (e.g. `'base'` when Beezie is promoted).
    */
   export type ChainType =
     | 'flow'
     | 'ethereum'
     | 'polygon'
     | 'solana'
     | 'flow_evm';
   ```

2. Add an optional `dbChain: ChainType | null` field to the `Collection` interface in the existing definition (around line 25 — alongside `chain`, `partner`, etc.). Keep `chain` exactly as it is:

   ```ts
   export interface Collection {
     id: string
     label: string
     shortLabel: string
     sport: string
     /** Partner / roadmap label — NOT the DB chain. Use `dbChain` for chain dispatch. */
     chain: "flow" | "evm" | "panini" | "candy" | "rwa"
     /**
      * Authoritative chain identifier mirroring `collections.chain` in Postgres.
      * `null` for unpublished placeholders that aren't seeded in the DB yet.
      * Chain-aware code should branch on this, not `chain`.
      */
     dbChain: ChainType | null
     // ...rest of existing fields unchanged
   }
   ```

3. For the 5 published entries (NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, UFC Strike), add `dbChain: 'flow',`. The existing `chain: 'flow'` value already matches the DB so nothing changes semantically; this just makes the field explicit and typed.

4. For the 3 unpublished placeholders (the ones with `chain: 'panini' | 'candy' | 'rwa'`), add `dbChain: null,`. Honest about not being in the DB. When chain two ships, Candy MLB's entry flips to `dbChain: 'solana'`; Beezie if promoted gets `dbChain: 'base'` (and the enum gets `'base'` added first).

5. Export `ChainType` at the top of the file alongside `Collection`.

**Smoke:**

- `npx tsc --noEmit` clean.
- `npm run build` clean.
- No runtime tests required — `dbChain` is additive and unread until chain two ships.

**What NOT to do in this phase:**

- Do NOT rename `chain` to anything else. That's a separate larger refactor touching every caller.
- Do NOT change existing `chain` values (`flow` stays `flow`, `candy` stays `candy`, etc.).
- Do NOT add chain values to the `chain_type` enum (the DB enum doesn't have `'base'` yet — that's deliberately deferred until Beezie is promoted).
- Do NOT touch route or page code. `lib/collections.ts` only.

**Commit message:** `feat(collections): add ChainType export + dbChain field for chain-abstraction Phase C`

**Rollback:** revert commit. `dbChain` is additive so reverts are clean.

---

## Phase D — `lib/chains/flow/` reorganization (SUPERSEDED — see dedicated doc)

**Plan landed 2026-05-30 in commits `ce19f35` (plan) + `4938fbb` (flow.ts default-export shim correction).** The canonical Phase D handoff is now [docs/handoff-phase-d-lib-chains-flow-reorg.md](handoff-phase-d-lib-chains-flow-reorg.md) — execute from THAT doc, not from the stale spec below.

Key things the dedicated doc gets right that the spec below got wrong:

- **Import alias finding:** 833 imports use `@/lib/...`, 0 use relative `../lib/`. Shim strategy is bulletproof — every caller resolves identically through the alias, so zero caller edits needed.
- **Default-export trap:** `lib/flow.ts` is the only Tier-1 file with `export default`. `export *` does NOT carry default exports, so its shim needs an explicit `export { default } from "@/lib/chains/flow/flow"` second line or default-importers silently break.
- **Verified caller counts per file** (highest fan-in: `lib/flow.ts` ~25, `lib/topshot.ts` 16). Shim risk known per file before the reorg starts.
- **Stay-at-top-level list** explicitly excludes `lib/evm-rpc.ts` from the Flow dir — Base/EVM plane must remain separate per the chain-strategy doc.
- **Tier 2 deferrals** (badges, dying Flowty helpers, collection subdirs, hooks) documented with reasons.
- **Execution mechanics tuned to this env's failure modes:** `git mv` for blame, PowerShell `git` for commits (bash silently no-ops on `.git/index.lock`), `git show HEAD:` + Vercel state as ground truth over buffered shell echo, PowerShell `tsc`, `git diff -M` must show pure R100 renames.

The stale spec below is preserved as a record of how the work was originally framed. **Do not execute Phase D from this section.**

---

**Original (stale) spec — historical context only.**

**Goal:** move (don't rewrite) Flow-specific primitives under `lib/chains/flow/`. Maintain re-exports at the original import paths so no caller breaks. Zero behavior change.

**Files to relocate (STALE LIST — two of these don't exist; see verified inventory above):**

| From | To | Notes |
|---|---|---|
| `lib/flow-helpers.ts` ❌ DOES NOT EXIST | `lib/chains/flow/helpers.ts` | Was written from inference; drop |
| `lib/cadence/*.ts` ✓ | `lib/chains/flow/cadence/*.ts` | Whole directory; ~per-collection Cadence scripts |
| `lib/wallet-backfill-helpers.ts` ✓ | `lib/chains/flow/wallet-backfill.ts` | |
| `lib/topshot-graphql.ts` ✓ | `lib/chains/flow/topshot-graphql.ts` | |
| `lib/alldayGraphql.ts` ✓ | `lib/chains/flow/allday-graphql.ts` | |
| `lib/dapper-v1-tx-decode.ts` ✓ | `lib/chains/flow/dapper-v1-tx-decode.ts` | |
| `lib/flowty-tx-classifier.ts` ❌ DOES NOT EXIST | `lib/chains/flow/flowty-tx-classifier.ts` | Likely removed in Flowty teardown; drop |

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

## Phase E — Chain-aware reads audit (SHIPPED 2026-05-30, `205024c`)

**Status:** complete. Audit doc landed at [docs/audits/chain-aware-reads-2026-05-30.md](audits/chain-aware-reads-2026-05-30.md). 168 surfaces classified (80 chain-internal / 85 assumes-Flow / 3 needs-chain-dispatch). DB-side companion at [docs/audits/chain-aware-reads-db-2026-05-30.md](audits/chain-aware-reads-db-2026-05-30.md). CLAUDE.md "Chain strategy" section already updated with both links.

**Headline finding:** the read/serve layer keyed by `collection_id` absorbs a new chain with zero change. The 3 code surfaces that genuinely need chain-dispatch are the squeeze-check + tc-report wallet-paste tools and the `lib/collections.ts` URL builders. Everything else either is chain-internal or stays Flow-scoped by design.

**Discovered during the audit (not in the original handoff scope):** there's a live parallel EVM data plane indexing Beezie Collectibles on Base mainnet (1.01M transfers, 1,828 holders) using its own `evm_chains` / `evm_nft_contracts` / `evm_nft_transfers` registry — outside `collections.chain_type`. Working decision: keep parallel until either Beezie gets a real product consumer or the July 8 Candy/Solana tripwire fails. See CLAUDE.md "Beezie/Base parallel data plane" paragraph.

The detail below is preserved for historical context; the Claude Code run that shipped Phase E adapted from this spec.

---

**Original goal (now satisfied):** classify every surface that filters by collection so we know what changes (and what doesn't) when chain two arrives. No code change in this phase.

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

- [ ] Phase C (revised two-field model): `npx tsc --noEmit` clean; `lib/collections.ts` shows `ChainType` exported, `dbChain: 'flow'` on all 5 published entries, `dbChain: null` on the 3 unpublished placeholders. Existing `chain` field unchanged.
- [ ] Phase D: `lib/chains/flow/` exists; original import paths still resolve via shims; production deploy green; 24h cron soak clean.
- [x] Phase E: shipped 2026-05-30 in `205024c`. Audit doc + DB-side companion + CLAUDE.md updated.
- [ ] Phase F (separate, deferred): DEFAULT dropped post-Phase-D-soak.

## Rough estimate

| Phase | Estimate |
|---|---|
| C | ~30 min (revised two-field model — additive only, no caller changes) |
| D | 2-3 days reorg + 1-day smoke + 24h soak |
| E | ~1 day (SHIPPED 2026-05-30) |
| F | ~10 min (separate Cowork session post-soak) |

Total: ~1 week from Phase C start to Phase F apply.
