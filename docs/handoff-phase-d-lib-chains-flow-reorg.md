# Phase D — `lib/chains/flow/` reorganization (CORRECTED execution plan)

**Created 2026-05-30 by Claude Code, from a just-verified `lib/` inventory.**
Supersedes the Phase D section in
[docs/handoff-2026-05-30-chain-abstraction-phases-cde.md](handoff-2026-05-30-chain-abstraction-phases-cde.md),
which named files that **do not exist** in the repo (see "Handoff corrections" below).

**Prereq:** Phase C is shipped (`d9323f9`, Vercel `dpl_BZLeeiot4EYSQo6qPeBQENN9cno3` READY).
Phase D depends on nothing in C, but the sequencing in the plan doc is C → D → F.

**Goal (unchanged):** *move* (never rewrite) Flow-specific primitives under `lib/chains/flow/`,
leaving a backward-compat shim re-export at every old path so zero callers break. Pure
relocation + re-export. No behavior change. No public API/route/cron change.

---

## Why this is now low-risk: the import-alias finding

Every import in the repo uses the `@/lib/...` path alias — **833 `@/lib/` imports, 0 relative
`../lib/` imports** (`tsconfig.json` → `"paths": { "@/*": ["./*"] }`, baseUrl = repo root).

That means a shim file left at the **old path** (`lib/topshot.ts`) re-exporting from the
**new path** (`@/lib/chains/flow/topshot`) resolves identically for every caller — no caller
edits required in this phase. The alias also makes the eventual caller-rename follow-up a
mechanical find/replace.

**Verified 2026-05-30 (`grep -c "export default"`):** exactly ONE Tier-1 file has a default export
— **`lib/flow.ts` (default-exports=1)**. Every other Tier-1 file (topshot, topshot-graphql,
topshot-username-resolve, allday, alldayGraphql, allday-cadence, dapper-v1-tx-decode,
wallet-backfill-helpers, flow-resolve, fcl-config, and all 7 `cadence/*`) has **zero** defaults.

Consequence for shims: `export *` does NOT re-export a default. So:
- For all zero-default files, the shim is a single line: `export * from "@/lib/chains/flow/<name>"`.
- **For `lib/flow.ts` ONLY**, the shim needs BOTH lines, or its ~25 `import flow from "@/lib/flow"`
  callers break:
  ```ts
  export * from "@/lib/chains/flow/flow";
  export { default } from "@/lib/chains/flow/flow";
  ```
  Before writing it, confirm callers actually use the default: `grep -rE "import .* from ['\"]@/lib/flow['\"]" app components lib scripts` — any `import flow from` or `import X, { ... } from` needs the default line. (Re-run `grep -c "export default"` on every file at execution time regardless — a file could gain a default between now and then.)

---

## Handoff corrections (do not chase ghosts)

The original handoff's relocation table listed these — **neither exists**, do not look for them:

- `lib/flowty-tx-classifier.ts` — **gone** (removed in the Flowty teardown; CLAUDE.md still
  references it under "schema facts / flowty_transactions" but the file is deleted).
- `lib/flow-helpers.ts` — **never existed** under that name. The Flow core helpers live in
  `lib/flow.ts` (44 lines) + `lib/flow-resolve.ts`.

The handoff was also vague on `lib/topshot-graphql.ts` ("or equivalent") and `lib/alldayGraphql.ts`
(correct name is camelCase `alldayGraphql.ts`, not `allday-graphql.ts`).

---

## Tier 1 — move these (clear chain primitives)

Caller counts are # of importing files (verified 2026-05-30 via `grep -rl "@/lib/<name>"` across
`app components lib scripts`). All are `@/lib/...` imports, so shims cover them all.

| # | From | To | Callers | LOC | Notes |
|---|---|---|---|---|---|
| 1 | `lib/flow.ts` | `lib/chains/flow/flow.ts` | 25* | 44 | Flow core (FCL/REST primitives). Highest fan-in **and the only file with a `export default`** — its shim needs the extra `export { default } from` line. Shim must be perfect. |
| 2 | `lib/flow-resolve.ts` | `lib/chains/flow/flow-resolve.ts` | 1 | — | Flow address/name resolve. |
| 3 | `lib/fcl-config.ts` | `lib/chains/flow/fcl-config.ts` | 1 | — | FCL client config. |
| 4 | `lib/topshot.ts` | `lib/chains/flow/topshot.ts` | 24* (16 exact `@/lib/topshot`) | 47 | TS helpers. The fuzzy 24 includes substring hits (topshot-badges etc.); 16 is the exact-path count. |
| 5 | `lib/topshot-graphql.ts` | `lib/chains/flow/topshot-graphql.ts` | 1 | 344 | TS GraphQL client. |
| 6 | `lib/topshot-username-resolve.ts` | `lib/chains/flow/topshot-username-resolve.ts` | 7 | — | TS username → wallet. |
| 7 | `lib/allday.ts` | `lib/chains/flow/allday.ts` | 6 (3 exact) | 48 | AllDay helpers. |
| 8 | `lib/alldayGraphql.ts` | `lib/chains/flow/alldayGraphql.ts` | 0 | 93 | **Keep camelCase filename** so the shim path matches. 0 callers — but per CLAUDE.md `lib/alldayGraphql.ts` hits consumer/graphql directly; confirm it's truly unused before assuming dead (grep may miss dynamic refs). |
| 9 | `lib/allday-cadence.ts` | `lib/chains/flow/allday-cadence.ts` | 4 | — | AllDay Cadence scripts. |
| 10 | `lib/dapper-v1-tx-decode.ts` | `lib/chains/flow/dapper-v1-tx-decode.ts` | 4 | 180 | V1 Dapper NFTStorefront tx decode. |
| 11 | `lib/wallet-backfill-helpers.ts` | `lib/chains/flow/wallet-backfill-helpers.ts` | 5 | 1339 | Cadence wallet walks (`runPaginatedDetailsBackfill` etc.). Biggest file; pure move so risk is shim-only. |
| 12 | `lib/cadence/` (whole dir, 7 files) | `lib/chains/flow/cadence/` | see below | — | Per-collection Cadence. Move dir, shim each file. |

**`lib/cadence/` per-file caller counts** (for shim verification):

| File | Callers |
|---|---|
| `cadence/purchase-moment.ts` | 5 |
| `cadence/break-transactions.ts` | 4 |
| `cadence/pinnacle-wallet.ts` | 3 |
| `cadence/purchase-moment-flow-wallet.ts` | 3 |
| `cadence/wallet-preflight.ts` | 2 |
| `cadence/make-offer-flowty.ts` | 1 |
| `cadence/make-offer-topshot.ts` | 0 |

\* Counts 1 and 4 are fuzzy (the bare token `flow` / `topshot` substring-matches sibling files
like `flow-resolve`, `topshot-badges`). Treat them as upper bounds; the shim makes the exact
count irrelevant for correctness, but use the exact figure when sanity-checking the post-move grep.

---

## Tier 2 — DEFER this phase (borderline; expands scope/risk without clear payoff)

Document the decision in the commit body; don't move these now.

- **Badges** — `lib/topshot-badges.ts`, `lib/allday-badges.ts`, `lib/golazos-badges.ts` (1 caller
  each). Collection *taxonomy*, not chain primitives. They parse Flow GQL `play_tags` but the
  abstraction is per-collection, not per-chain. Leave at top level (mirrors the Phase-E call that
  left `lib/fmv-confidence.ts` top-level).
- **Flowty** — `lib/flowty-username.ts` (4), `lib/flowty-flags.ts` (7). Flowty is mid-teardown
  (dead marketplace). Moving dying code into the canonical chain dir is churn; let the teardown
  delete them instead.
- **Collection-scoped Flow subdirs** — `lib/pinnacle/*`, `lib/ufc/ufcFlowty.ts`,
  `lib/sniper/pinnacle.ts`, `lib/concierge/pinnacle-router.ts`. All Flow, but moving them is a
  much larger blast radius and they're collection- not chain-shaped. Future phase.
- **Flow React hooks** — `lib/hooks/useFlowUser.ts`, `lib/hooks/useFlowWalletBalances.ts`.
  Client-side; low value to relocate. Defer.
- **`lib/marketplace-status.ts`** (2 callers) — reframed to outbound links in the May 23 pass;
  mostly inert. Defer.

---

## STAY at top level (chain-agnostic by design — do NOT move)

`lib/collections.ts` (multi-chain registry, the Phase-C home of `ChainType`/`dbChain`),
`lib/fmv-confidence.ts`, `lib/cart/*`, `lib/format.ts`, `lib/supabase.ts`, `lib/logger.ts`,
`lib/admin-auth.ts`, `lib/evm-rpc.ts` (this is the **EVM/Base** plane — explicitly NOT Flow;
leaving it at top level keeps the parallel-plane separation honest), and all generic utils.

---

## Procedure (per file)

For each Tier-1 entry:

1. **Confirm contents + default-export status:**
   `grep -c "export default" lib/<name>.ts` → expect 0 for every file EXCEPT `lib/flow.ts`
   (which is 1). A nonzero count needs `export { default } from "@/lib/chains/flow/<name>"` added
   to the shim alongside the `export *` line (see the import-alias section for the `flow.ts` shim).
2. **Move preserving blame:** `git mv lib/<name>.ts lib/chains/flow/<name>.ts`
   (for the cadence dir: `git mv lib/cadence lib/chains/flow/cadence`, then the shims go in a
   recreated `lib/cadence/`).
3. **Write the shim at the old path** (`lib/<name>.ts`):
   ```ts
   // Back-compat shim — canonical impl at lib/chains/flow/<name>.ts (chain-abstraction Phase D).
   // TODO(chain-rename): repoint callers to @/lib/chains/flow/<name> and delete this shim
   // after chain two ships.
   export * from "@/lib/chains/flow/<name>";
   ```
4. **Do NOT edit any caller import path.** Shims keep them green. (Caller-rename is the explicit
   follow-up, not this phase.)

**Internal cross-imports:** several Tier-1 files import each other (e.g. `topshot-graphql` →
`flow`, `wallet-backfill-helpers` → cadence scripts). Because everything uses `@/lib/...`, a
moved file's internal `@/lib/flow` import keeps resolving through that file's own shim — so the
order of moves doesn't matter and you don't have to rewrite internal imports. (Optional polish:
once all moves are done, rewrite the *moved* files' internal `@/lib/<moved>` imports to
`@/lib/chains/flow/<moved>` so the canonical copies don't bounce through shims. Strictly optional;
do it in a separate commit if at all.)

---

## Verification gates (must pass before commit)

1. **`npx tsc --noEmit`** — clean. ⚠️ Filter output to relevant files: per memory
   `tsc-null-byte-phantom-errors`, the bash-mount baseline shows ~49k phantom null-byte lines
   across ~21 `app/api/**` files that are clean on-disk. Run tsc from **PowerShell**, not the
   bash mount, to avoid the phantom errors entirely (this session confirmed PowerShell tsc is
   clean while bash reads were corrupt).
2. **`npm run build`** — clean (Turbopack).
3. **Grep proof the shims resolve:** for each moved file,
   `grep -rl "@/lib/<name>" app components lib scripts` should still return the original caller
   set (unchanged count), and `lib/chains/flow/<name>.ts` should exist.
4. **No accidental behavior edit:** `git diff -M --stat` should show pure renames (R100) for the
   moved content + small new shim files. Any file showing content delta on a "moved" file means
   you edited instead of moved — revert and redo as `git mv`.

---

## Commit / deploy

- Direct to `main`, no PR (CLAUDE.md rule).
- **Commit via PowerShell git**, not bash git (this session + the 2026-05-29 session both saw
  bash `git commit` silently no-op on this Windows mount). After push, verify:
  `git rev-list --count origin/main..HEAD` → 0, and confirm the pushed blob with
  `git show HEAD:lib/chains/flow/<name>.ts` (don't trust same-turn shell echo — output buffers
  badly on this mount; ground truth is `git show` + Vercel deploy state).
- Commit message:
  `refactor(lib/chains/flow): relocate Flow-specific primitives, keep shims for back-compat (Phase D)`
- After push: poll Vercel `list_deployments` (project `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`,
  team `team_YWGCVToPBJSS60NgVh8jiCFV`) until the Phase-D SHA reaches **READY**. Hit `/api/health`
  (expect 200), `/api/sniper-feed`, `/api/edition-stats` against production.

## 24-hour soak (post-deploy)

- All 23 cron pipelines: compare `pipeline_runs` `ok=false` rate to the prior 7-day baseline. An
  elevated rate suggests a shim broke a type-narrow inference or a dynamic import the grep missed
  (watch `alldayGraphql.ts` — 0 static callers but used via the consumer/graphql path).
- Sentinel tripwires unchanged; no new Vercel runtime error rate.

## Rollback

`git revert` the commit. Shims mean rollback is a no-op for callers — fully clean.

## Gates Phase F

Once Phase D is stable in production for **48h**, Phase F (DB-side, from Cowork) drops the
`collections.chain` DEFAULT:
`ALTER TABLE collections ALTER COLUMN chain DROP DEFAULT;`
(rollback: `... SET DEFAULT 'flow'::chain_type`).

---

## Estimate

~0.5 day for the moves + shims (12 entries / 18 files), ~0.5 day TS/build/smoke, then the 24h +
48h soak windows are wall-clock, not work. The 1339-line `wallet-backfill-helpers.ts` is the only
large file but it's a pure move — size doesn't add risk, only the shim correctness does.

## Follow-up (NOT this phase)

After chain two ships, mechanically repoint every `@/lib/<moved>` caller to
`@/lib/chains/flow/<moved>` (find/replace, ~one commit) and delete the shims. The
`TODO(chain-rename)` markers in each shim mark the work.
