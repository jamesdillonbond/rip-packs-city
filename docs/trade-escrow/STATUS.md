# Trade Escrow — Status & Handoff

**Last updated:** Sat May 16, 2026 (post HTTP smoke test, off-chain plumbing E2E green locally)
**Owner:** Trevor (single dev)
**Phase:** 1 (atomic NFT-for-NFT swap via escrow contract)
**Read this before working on anything in `cadence/contracts/RPCTradeEscrow.cdc` or `app/dashboard/trade-hub/` or `lib/trade-escrow/`.**

---

## What this is

Peer-to-peer atomic NFT swap feature for Rip Packs City. Two users propose
a trade through the UI (Trade Hub), each signs a deposit transaction that
puts their NFTs into a Cadence escrow contract, and once both sides
deposit the backend triggers an atomic execute that routes NFTs across.

The off-chain layer mirrors the on-chain lifecycle: a `trade_chain_state`
row tracks `proposed → partial_a → partial_b → ready → executed | cancelled | expired`.

Spiritual reference: evaluate.xyz, which Magic Eden shut down. They never
open-sourced anything. We're building from scratch.

---

## Where to find things

| Artifact | Location |
|---|---|
| Cadence escrow contract | `cadence/contracts/RPCTradeEscrow.cdc` |
| Cadence test suite (14 tests) | `cadence/tests/RPCTradeEscrow_test.cdc` |
| Test fixture transactions | `cadence/tests/transactions/*.cdc` |
| Test fixture scripts | `cadence/tests/scripts/*.cdc` |
| Production tx templates (TBD per collection) | `cadence/transactions/` |
| Deployment guide (on-chain side) | `docs/trade-escrow/DEPLOYMENT.md` |
| TypeScript types | `lib/trade-escrow/types.ts` |
| FCL submit (stubs) | `lib/trade-escrow/fcl-submit.ts` |
| Client-side sign helper (stub) | `lib/trade-escrow/sign-deposit.ts` |
| API routes | `app/api/trade-chain/*` + `app/api/admin/reclaim-expired-trades` |
| UI panel | `app/dashboard/trade-hub/TradeChainPanel.tsx` (or similar) |

---

## What's done

**Contract.** `RPCTradeEscrow.cdc` drafted. Generic over standard `NonFungibleToken`
interface, works for all 5 collections unchanged. Resource model: `Trade` resources
held in a `Registry` on the contract account. No drain path — Admin has zero
NFT-withdraw authority. Lifecycle: propose → deposit (×2) → execute, with cancel
and expiry-reclaim as recovery paths. Min expiry 10 min, max 7 days.

**Test suite.** 14 active tests covering all 12 audit scenarios from §5 of the
deployment guide + 2 bonus (same-party rejection, admin surface tripwire).
Two scenarios stubbed as TODO (type-mismatch needs second NFT fixture,
receiver-cap invalidation easier to exercise on testnet).

**On-chain verification (May 13, 2026).** All 5 target NFT contracts inspected
via `rest-mainnet.onflow.org`. All conform to `NonFungibleToken`. All expose
`NFT.id: UInt64`. Path conventions confirmed: TopShot uses literal
`/storage/MomentCollection`, the other 4 use `<Contract>.CollectionStoragePath`
constants. `CompositeType(_:)` Cadence 1.0 builtin verified. Golazos address
corrected to `0x87ca73a41bb50ad5` (previously had typo `c5e`).

**DB schema.** Two migrations applied to Supabase (`bxcqstmqfzmuolpuynti`):
- `trade_chain_state` — 19 cols, FK to `trade_matches.id`, regex check on
  Flow addresses, parties-must-differ check, status enum check, 4 indexes,
  `updated_at` trigger.
- `trade_matches.partya_offer_id` + `partyb_offer_id` — nullable UUID FKs to
  `user_trade_offers(id)`, ON DELETE SET NULL, partial indexes, distinct-offers
  CHECK. Existing `offer_id` column preserved for legacy cash-purchase matches.

**Off-chain plumbing (stub mode).** Handed to Claude Code in prior session.
Status: TBD — needs verification that stub-mode E2E smoke test is green now
that both DB migrations are in.

---

## What's next

In priority order:

1. **Verify stub-mode E2E smoke is green.** Both DB unblockers landed. The
   propose → partial_a → partial_b → ready → executed transitions should run
   end-to-end against stubbed FCL.

2. **Reconcile Cadence test API names.** The test suite was written against
   best-guess API names (`Test.moveTime`, `Test.beSucceeded`, `Test.TestAccount`).
   First `flow test` run will surface any drift; corrections are mechanical
   (~15 min).

3. **Live storage-path spot-check.** Contracts declare paths via constants;
   confirm an actual NFT-holding wallet on mainnet has those public caps
   published at the expected paths. 5 min per collection via Flow REST.

4. **Testnet contract account setup.** `flow accounts create --network testnet`,
   fund from faucet, save key. Trevor executes physically; can be spec'd ahead
   of time.

5. **Testnet deploy + exercise.** Deploy contract, run real-collection
   end-to-end with two throwaway wallets. ExampleNFT first, then a real
   collection if a testnet fixture is available.

6. **Real FCL wiring** in `fcl-submit.ts` and `sign-deposit.ts`. Stubs become
   `fcl.mutate(...)` calls using the transaction templates from
   `DEPLOYMENT.md §3`. Requires familiarity with the existing FCL config —
   Claude Code job.

7. **Cron-job.org janitor entry** for `/api/admin/reclaim-expired-trades`.
   Every 5 min, `INGEST_SECRET_TOKEN` auth.

8. **Mainnet deploy** — dedicated Flow account (NOT the hot wallet
   `0x3aa11c84d776838f`). Smoke test with two of Trevor's own wallets and
   a low-value moment before announcing.

Phase 2 (deferred): Hybrid Custody support, sweetener (FLOW + NFT bundles),
multi-collection swap UX polish, reputation derived from on-chain events.

---

## Known issues / things to verify

- **Test API drift — RESOLVED Sat May 16, 2026.** Reconciled
  `cadence/tests/RPCTradeEscrow_test.cdc` against canonical Cadence
  Testing Framework docs at cadence-lang.org. Five corrections: removed
  bogus `import BlockchainHelpers`; rewrote event-extraction in
  `mintExampleNFT` and `proposeTrade` to use set-difference and
  `getNextTradeId()` respectively (canonical event API can't downcast to
  specific event types); `Test.moveTime(by:)` takes `Fix64`, not `UFix64`;
  bumped two 600.0 expiry literals off the MIN_EXPIRY boundary. See
  `docs/trade-escrow/CADENCE_TEST_RECONCILIATION.md` for the full diff.
  Three minor items remain unverified until first `flow test` run
  (ExampleNFT minter signature, type-identifier resolution timing,
  `Fix64(700.0)` cast syntax) — all 5-min fixes at the relevant compile
  error line.
- **DB column-naming alignment — RESOLVED Sat May 16, 2026.** `trade_chain_state`
  columns originally landed as `party_a_address` (snake_case with underscore
  between `party` and `a`/`b`), while route code and `trade_matches.partya_offer_id`
  used no-underscore. The prior STATUS.md entry incorrectly said "both work" —
  they don't, because the propose route's INSERT targeted no-underscore names.
  Caught by Claude Code's static audit before the first smoke test. Resolved
  by renaming all 8 affected `trade_chain_state` columns to the no-underscore
  convention plus the 2 partial-index names. CHECK-constraint expressions
  auto-rewrote; constraint *labels* still reference old convention but that's
  cosmetic. Migration: `rename_trade_chain_state_columns_to_match_route_code`.
- **README fixture paths + flow.json imports — RESOLVED Sat May 16, 2026.**
  README path correction committed in d623403. Three import contracts
  (NonFungibleToken, MetadataViews, ExampleNFT) downloaded to
  `cadence/contracts/imports/` and confirmed Cadence 1.0. Note:
  `flow.json` is still gitignored (plaintext hot-wallet key), so its
  contracts-block edits live only on Trevor's machine. Dependency-manager
  side-effect: re-running `flow dependencies install` rewrites the
  dependencies block's aliases (sets NonFungibleToken alias to `{}`).
  Two-source-of-truth concern that may bite a future test run; consolidate
  to a single contracts-block declaration when convenient.
- **Off-chain plumbing untracked on main — DECISION PENDING.**
  `app/api/trade-chain/`, `app/api/admin/reclaim-expired-trades/`,
  `app/dashboard/trade-hub/TradeChainPanel.tsx`, and `lib/trade-escrow/`
  exist on local disk only. Prod 404s the trade-chain routes. Local
  HTTP smoke test passed end-to-end against Trevor's real prod cookie
  (May 16, 2026) — propose → partial_a → partial_b → ready → executed
  with real moment_ids, clean response shapes, no Sentry errors,
  COLLECTION_META lookup correct, Number() cast safe. Recommendation:
  commit to main. Risk of "half-feature visible" is minimal (lockdown
  allowlist gates, UI doesn't link from anywhere yet). Diff cost grows
  the longer it stays unstable.
- **HTTP auth path returns 307, not 401, on unauthed requests.**
  `proxy.ts` site lockdown redirects to `/login?next=...` before the
  route handler's `requireUser()` 401 path can fire. Fine for browsers,
  awkward for future programmatic clients (mobile, CLI, webhooks). When
  programmatic clients land, exempt `/api/*` from the lockdown redirect
  and let route handlers return clean 401s. ~5-line `proxy.ts` change
  when the time comes.
- **moment_id JS safe-integer headroom.** Verified May 16, 2026:
  `Number(moment_id)` works for all 5 collections today. Pinnacle's
  largest is 280375467707130 (15 digits); JS safe-integer limit is
  9007199254740991 (16 digits). ~32x headroom. Trajectory worth
  watching — Pinnacle's id space is much larger than the others
  (15 digits vs 8). Long-term defense is `BigInt(moment_id)` everywhere
  on the JS side. Not blocking today.
- **`cadence/tests/README.md` has stale fixture paths.** Declares
  `cadence/transactions/` and `cadence/scripts/` but fixtures actually live at
  `cadence/tests/transactions/` and `cadence/tests/scripts/`. 2-line correction
  needed before first `flow test` run.
- **`flow.json` import paths point at non-existent files.** Contracts block
  references `./cadence/contracts/imports/{NonFungibleToken,MetadataViews,ExampleNFT}.cdc`.
  Files not yet downloaded. Run `flow dependencies add mainnet://1d7e57aa55817448.NonFungibleToken`
  and `mainnet://1d7e57aa55817448.MetadataViews` plus a curl for ExampleNFT from
  flow-nft repo. Required before any `flow test` invocation. Note: `flow.json`
  is gitignored (contains plaintext hot-wallet private key); changes live
  only on Trevor's machine.
- **`CLAUDE.md` "Pinnacle uses Int" note is ambiguous.** Refers to
  `editionID/setID/variantID` fields, NOT the standard `NFT.id` field which
  is `UInt64` for Pinnacle (verified on-chain May 13, 2026). The escrow's
  `UInt64` typing works for Pinnacle unchanged. Memory in Claude.ai disambiguates;
  the `CLAUDE.md` line itself was left as-is.

---

## Hard rules (do not violate)

- **No drain path.** The Admin resource must have zero NFT-withdraw authority,
  ever. The `audit_admin_surface.cdc` script is a tripwire — if you add a new
  admin function, update that script and force review.
- **NFTs only escrow in active Trade resources.** The contract never holds NFTs
  outside a Trade. Period.
- **Partial deposits revert.** Either all expected NFTs from a side land in
  one tx, or the tx reverts. Same-side re-deposit without cancel is rejected.
- **All-or-nothing at execute.** Cadence resource semantics guarantee
  atomicity. Do not add manual rollback paths.
- **Expiry is the safety valve.** No NFT can be locked indefinitely. Min 10 min,
  max 7 days. `reclaimExpired` works even when contract is paused.
- **Do NOT deploy to hot wallet `0x3aa11c84d776838f`.** Use a dedicated Flow
  account for the contract. Separate blast radius.
- **Do NOT modify the `RPCTradeEscrow.cdc` contract without updating the
  test suite and the audit script in lockstep.**

---

## Context links

- evaluate.xyz background: shut down by Magic Eden in early 2026. Never
  open-sourced. Used multi-sig envelope pattern; we use simpler escrow.
- Flowty NFTStorefrontV2 fork (cash sales, not swaps): `0x3cdbb3d569211ff3`.
  Not used by this feature; mentioned because they handle AllDay/Golazos/UFC
  trades and exhibit the buyer-address-as-contract-address quirk.
- Phase 2 Hybrid Custody hook point: `HybridCustody @ 0xd8a7e05a7ac670c0`,
  Manager resource. The escrow contract itself doesn't change for Phase 2;
  only the deposit transactions get new variants that borrow from a child.
