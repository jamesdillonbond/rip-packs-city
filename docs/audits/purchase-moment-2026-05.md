# Cadence audit — `lib/cadence/purchase-moment.ts`

**Audit date:** 2026-05-09
**Auditor:** Claude (cadence-audit skill, Flow Claude Code Plugin v1.0.0)
**Target:** `lib/cadence/purchase-moment.ts` (transaction string `PURCHASE_MOMENT_CADENCE`)
**Mode:** Read-only — no source modifications made.
**Verification:** `mcp__cadence-mcp__cadence_check` + live mainnet contract reads via Cadence MCP.

This is the only transaction in the repo that moves real value (DUC out of buyer wallet, NFT in, Dapper co-signer required), so the bar is "must compile, must not panic on real listings, must not lose buyer funds." The transaction in its current form **fails the first two of those three criteria** — it does not compile and would also panic at runtime even if the compile bugs were fixed. Cart execution is already listed as blocked in `CLAUDE.md` (Known Issues §1) on WalletConnect / Dapper registration; this audit shows the Cadence body itself also needs work before any live purchase can succeed.

---

## Findings

### Critical

#### C1. Field `self.listing` accessed before initialization

- **Location:** [`lib/cadence/purchase-moment.ts:65`](../../lib/cadence/purchase-moment.ts#L65) (inside `prepare`).
- **Excerpt:**
  ```cadence
  let price = self.listing.getDetails().salePrice
  ```
  Line 65 reads `self.listing`, but the field is not assigned until line 90:
  ```cadence
  self.listing = self.storefront.borrowListing(...)
  ```
- **Issue:** Cadence 1.0 forbids reading a transaction/contract field before it has been written. `cadence_check` reports: *"cannot access uninitialized field: `listing`. fields must be initialized before they are accessed; initialize the field before accessing it."* This is a hard compile-time error — the transaction will never reach Flow.
- **Fix:** Move the `borrowListing` assignment above the price-validation block. Suggested ordering inside `prepare`:
  1. `assert(dapperAccount.address == merchantAccountAddress, …)`
  2. Borrow `self.storefront`.
  3. Borrow `self.listing` from `self.storefront`.
  4. Read `self.listing.getDetails().salePrice` and assert against `expectedPrice`.
  5. Borrow `self.buyerCollection`.
  6. Borrow buyer DUC vault and withdraw `expectedPrice` into `self.paymentVault` *last*, so we never withdraw funds when an earlier check could still fail.

#### C2. Missing `import FungibleToken` — entitlement type unresolved

- **Location:** [`lib/cadence/purchase-moment.ts:40-44`](../../lib/cadence/purchase-moment.ts#L40-L44) (imports) and [`lib/cadence/purchase-moment.ts:72`](../../lib/cadence/purchase-moment.ts#L72) (usage).
- **Excerpt:**
  ```cadence
  let ducVault = buyer.storage.borrow<auth(FungibleToken.Withdraw) &DapperUtilityCoin.Vault>(
    from: /storage/dapperUtilityCoinVault
  ) ?? panic("Cannot borrow DapperUtilityCoin vault from buyer")
  ```
- **Issue:** Confirmed against the live `DapperUtilityCoin` contract at `0xead892083b3e2c6c`: `withdraw(amount:)` is declared `access(FungibleToken.Withdraw)`, where `FungibleToken.Withdraw` is the entitlement defined in the `FungibleToken` standard contract at `0xf233dcee88fe0abe`. The transaction never imports `FungibleToken`, so `cadence_check` reports *"cannot find type in this scope: `FungibleToken`"* on line 72. Hard compile error.
- **Fix:** Add `import FungibleToken from 0xf233dcee88fe0abe` alongside the other imports.

### High

#### H1. `commissionRecipient: nil` panics on listings with non-zero commission

- **Location:** [`lib/cadence/purchase-moment.ts:96-99`](../../lib/cadence/purchase-moment.ts#L96-L99).
- **Excerpt:**
  ```cadence
  let nft <- self.listing.purchase(
    payment: <-self.paymentVault,
    commissionRecipient: nil
  )
  ```
- **Issue:** Verified against the live `NFTStorefrontV2` contract at `0x4eb8a10cb9f87357`:
  ```cadence
  if self.details.commissionAmount > 0.0 {
    let commissionReceiver = commissionRecipient ?? panic("Commission recipient can't be nil")
    …
  }
  ```
  Top Shot listings published through the Dapper marketplace path on NFTStorefrontV2 routinely carry a non-zero `commissionAmount` (the marketplace cut routed through `0xc1e4f4f4c4257510`). For any such listing this transaction reverts with `"Commission recipient can't be nil"` *after* the buyer's DUC has been moved into `self.paymentVault`. The transaction reverts cleanly so funds aren't lost, but every purchase against a commissioned listing (i.e. virtually all of them) fails.
- **Fix:** Inspect `self.listing.getDetails().commissionAmount` and `getAllowedCommissionReceivers()` in `prepare`. When commission is non-zero, build a `Capability<&{FungibleToken.Receiver}>` for the merchant DUC receiver (`/public/dapperUtilityCoinReceiver` on `0xc1e4f4f4c4257510`) and pass that capability instead of `nil`. The receiver capability must match an entry in `getAllowedCommissionReceivers()` if the listing supplies a non-nil whitelist (NFTStorefrontV2 enforces both type and address match).

#### H2. No `post {}` block — Dapper co-signer policy will reject

- **Location:** [`lib/cadence/purchase-moment.ts:46-104`](../../lib/cadence/purchase-moment.ts#L46-L104) (transaction body).
- **Issue:** `CLAUDE.md` (`Cadence purchase transaction rules`) explicitly states: *"DUC leak check in `post{}` block required by Dapper co-signer."* The Dapper meta-tx signing service inspects the transaction body before co-signing and refuses to sign transactions that lack the conventional invariants (typically: no DUC residue in the buyer's vault, NFT count delta = +1 in buyer's collection). This transaction has no `post {}` block at all. Even after fixing C1/C2/H1 the transaction will not be co-signed — it will fail to even broadcast.
- **Fix:** Add a `post {}` block that captures DUC balance pre-execute (via a `let` in `prepare`) and asserts the post-execute balance equals `pre - expectedPrice`. The conventional pattern Dapper accepts is:
  ```cadence
  pre {
    // capture DUC balance snapshot
  }
  post {
    // assert DUC balance went down by exactly expectedPrice
    // assert NFT now in buyer's MomentCollection
  }
  ```
  Cross-reference Dapper's published purchase-transaction template (the same shape Flowty + Top Shot's official mobile flow use) before locking in the exact wording.

### Medium

#### M1. `merchantAccountAddress` parameter is decorative

- **Location:** [`lib/cadence/purchase-moment.ts:47, 59-62`](../../lib/cadence/purchase-moment.ts#L47-L62).
- **Excerpt:**
  ```cadence
  assert(
    dapperAccount.address == merchantAccountAddress,
    message: "Merchant account does not match expected address"
  )
  ```
- **Issue:** The check is a tautology against caller-supplied data. Both `dapperAccount.address` and `merchantAccountAddress` are inputs the caller chose — if a malicious caller picks wrong values they only hurt themselves; if they pick consistent wrong values the check passes. The merchant identity is already enforced by the fact that only the real Dapper service can produce a co-signature.
- **Fix:** Drop the `merchantAccountAddress` parameter and hardcode the assertion against the literal `0xc1e4f4f4c4257510` so the contract address is on-chain-visible and unforgeable from the caller side. This also reduces the FCL `args` array by one entry.

#### M2. Listing payment-vault type not pre-validated

- **Location:** [`lib/cadence/purchase-moment.ts:64-69`](../../lib/cadence/purchase-moment.ts#L64-L69).
- **Issue:** The transaction assumes the listing accepts DUC. NFTStorefrontV2's `purchase` precondition `payment.isInstance(self.details.salePaymentVaultType)` will reject a non-DUC listing, but only after DUC has already been withdrawn into the payment vault and the price assertion has passed. Pre-validating in `prepare` short-circuits with a clearer error before any vault movement.
- **Fix:** Add to `prepare`:
  ```cadence
  assert(
    self.listing.getDetails().salePaymentVaultType == Type<@DapperUtilityCoin.Vault>(),
    message: "Listing does not accept DUC"
  )
  ```

#### M3. Listing NFT type not pre-validated

- **Location:** [`lib/cadence/purchase-moment.ts:96-102`](../../lib/cadence/purchase-moment.ts#L96-L102).
- **Issue:** The transaction assumes the listing is a `TopShot.NFT`. If a non-TopShot listing is passed, NFTStorefrontV2 returns `@{NonFungibleToken.NFT}` of the wrong concrete type, and `MomentCollection.deposit` (verified on chain — line 1196-1199 of `TopShot`) force-casts via `let token <- token as! @NFT` which panics. The buyer's funds are returned by tx revert, but the failure mode is opaque.
- **Fix:** Add to `prepare`:
  ```cadence
  assert(
    self.listing.getDetails().nftType == Type<@TopShot.NFT>(),
    message: "Listing is not a TopShot moment"
  )
  ```
  This also doubles as a guard against accidentally pointing this transaction at AllDay/Pinnacle/UFC listings on the Flowty fork of NFTStorefrontV2 at `0x3cdbb3d569211ff3`, which would otherwise compile cleanly because the contract interface is identical.

#### M4. Listing expiry not pre-validated

- **Location:** [`lib/cadence/purchase-moment.ts:88-92`](../../lib/cadence/purchase-moment.ts#L88-L92).
- **Issue:** NFTStorefrontV2's `purchase` enforces `self.details.expiry > UInt64(getCurrentBlock().timestamp)`, but only inside `purchase()` — after DUC withdrawal. Pre-validating gives a cleaner error path.
- **Fix:** Add to `prepare` after listing borrow:
  ```cadence
  assert(
    self.listing.getDetails().expiry > UInt64(getCurrentBlock().timestamp),
    message: "Listing has expired"
  )
  ```

### Low

#### L1. Unused imports `TopShot` and `MetadataViews`

- **Location:** [`lib/cadence/purchase-moment.ts:43-44`](../../lib/cadence/purchase-moment.ts#L43-L44).
- **Issue:** `cadence_check` reports both as unused. They cost nothing functionally but inflate the cadence body and clutter the dependency surface.
- **Fix:** Either remove the imports, or use them for the H1/M3 fixes (e.g. `Type<@TopShot.NFT>()` requires the `TopShot` import to resolve; `MetadataViews.getRoyalties` would justify the MetadataViews import). The recommended H1+M3 fixes consume the `TopShot` import and leave only `MetadataViews` to remove.

#### L2. Redundant downcast on DUC withdraw

- **Location:** [`lib/cadence/purchase-moment.ts:76`](../../lib/cadence/purchase-moment.ts#L76).
- **Excerpt:**
  ```cadence
  self.paymentVault <- ducVault.withdraw(amount: expectedPrice) as! @DapperUtilityCoin.Vault
  ```
- **Issue:** `DapperUtilityCoin.Vault.withdraw` is declared returning `@DapperUtilityCoin.Vault` (concrete type, verified in the live contract), so the `as!` is a no-op. Force-casts are also a defect-magnet — if the upstream return type ever changes, this hides the bug instead of surfacing it.
- **Fix:** Drop `as! @DapperUtilityCoin.Vault`. The assignment becomes:
  ```cadence
  self.paymentVault <- ducVault.withdraw(amount: expectedPrice)
  ```

#### L3. Panic on missing buyer collection lacks remediation hint

- **Location:** [`lib/cadence/purchase-moment.ts:79-81`](../../lib/cadence/purchase-moment.ts#L79-L81).
- **Issue:** `panic("Cannot borrow buyer TopShot collection")` doesn't tell the buyer they need to run `setup_topshot_account` first. For first-time buyers this is the most likely failure mode.
- **Fix:** `panic("Buyer is missing /public/MomentCollection — run setup_topshot_account first")`. Same shape applies to the storefront and listing panics, though those are less buyer-actionable.

#### L4. `merchantAccountAddress` constant comment is wrong

- **Location:** [`lib/cadence/purchase-moment.ts:29`](../../lib/cadence/purchase-moment.ts#L29) and `108`.
- **Issue:** The header comment labels `0xc1e4f4f4c4257510` as `TopShotMarketV3 ← merchant address`. While Dapper's service account does host TopShotMarketV3 there, this transaction does **not** invoke TopShotMarketV3 — the trade is settled via NFTStorefrontV2 at `0x4eb8a10cb9f87357`. The role of `0xc1e4f4f4c4257510` here is purely as the Dapper meta-tx co-signer / commission recipient. The misleading label has propagated into `CLAUDE.md` ("Dapper merchant: `0xc1e4f4f4c4257510`"), and to the constant name `DAPPER_MERCHANT_ADDRESS` — which is at least directionally correct.
- **Fix:** Update the comment header to: `// 0xc1e4f4f4c4257510 ← Dapper meta-tx co-signer & marketplace commission recipient (also hosts TopShotMarketV3, unrelated)`.

### Informational

#### I1. `dapperAccount: auth(BorrowValue) &Account` requests unused entitlement

- **Location:** [`lib/cadence/purchase-moment.ts:57`](../../lib/cadence/purchase-moment.ts#L57).
- **Issue:** The `BorrowValue` entitlement is requested on `dapperAccount` but the transaction body never borrows from `dapperAccount.storage` or its capabilities — it only reads `.address`. Requesting unused authority is a soft anti-pattern in Cadence 1.0 (least-privilege principle).
- **Fix:** Change the parameter to plain `dapperAccount: &Account`. Buyer signer must keep `auth(BorrowValue)` because it borrows the DUC vault. After the H1 fix, if commission requires looking up a receiver via the merchant account's published capabilities, the entitlement is still not strictly needed (`getAccount(merchantAddr).capabilities.borrow(…)` is unauthenticated), so plain `&Account` continues to suffice.

#### I2. Cadence body is a TS template literal — Windows CRLF risk

- **Location:** [`lib/cadence/purchase-moment.ts:39-105`](../../lib/cadence/purchase-moment.ts#L39-L105).
- **Issue:** `CLAUDE.md` flags CRLF-driven silent breakage on Windows for multi-line literals. Cadence is whitespace-tolerant but `.cdc` files version better, can be `cadence-check`'d in CI, and survive CRLF normalization roundtrips more gracefully.
- **Fix (optional):** Move the body to `cadence/transactions/purchase-moment.cdc` and load it via Next.js asset import or a build-time `readFileSync`. Not blocking.

#### I3. Listing event indexing — confirm DB persists `listingResourceID`

- **Issue:** When `purchase` succeeds, NFTStorefrontV2 emits `ListingCompleted(listingResourceID, storefrontResourceID, purchased: true, …)`. RPC's reconciliation path needs `listingResourceID` to match the on-chain event back to the cart row. Verify the cart-execution path persists the listing resource ID before submitting the tx.
- **Fix:** Pre-deployment checklist item; not a code change to the transaction itself.

---

## Overall risk summary

In its current state this transaction does not compile (C1, C2) and even with those fixed would fail to broadcast (H2, no `post{}` block) and fail to settle on virtually every real Top Shot listing (H1, nil commission recipient). C1 in particular is striking — it's a deterministic Cadence 1.0 violation that would have been caught by any pre-deploy `cadence-check`, suggesting the transaction has never been compiled against a Cadence 1.0 toolchain. None of the issues represent fund-loss vectors at runtime (the storefront and Cadence runtime both revert cleanly on failure, returning the buyer's DUC), but the practical impact is that the cart cannot execute against any real listing today. Before re-attempting integration: fix C1 and C2 to compile, add the post-condition required by Dapper (H2), wire up a real commission receiver (H1), and add the listing-side pre-validations (M2/M3/M4) so failure paths surface human-readable errors instead of contract-level preconditions firing after DUC has already moved.

## Live contract sources fetched via Cadence MCP

The Flow Cadence MCP server returns live mainnet bytecode by account+contract-name, not by Git SHA or block height; the only freshness anchor it exposes is the network it was queried against (`mainnet`) and the time of the read. All five reads below were performed on **2026-05-09** against `mainnet` via `mcp__cadence-mcp__get_contract_code` / `get_contract_source`.

1. **`NFTStorefrontV2`** at `0x4eb8a10cb9f87357` — full source returned inline (~600 lines). Verified: `StorefrontPublicPath = /public/NFTStorefrontV2`, `purchase(payment, commissionRecipient)` preconditions, `commissionAmount > 0.0 → nil panic`.
2. **`DapperUtilityCoin`** at `0xead892083b3e2c6c` — full source returned inline (~210 lines). Verified: `withdraw` is `access(FungibleToken.Withdraw)`; storage path `/storage/dapperUtilityCoinVault`; receiver path `/public/dapperUtilityCoinReceiver`.
3. **`TopShot`** at `0x0b2a3299cc857e29` — 81,446-byte source (saved to `tool-results/mcp-cadence-mcp-get_contract_code-1778329944983.txt`, extracted to a local `.cdc` for searching). Verified: `MomentCollection` storage/public paths at `/storage/MomentCollection` and `/public/MomentCollection`; `Collection.deposit(token: @{NonFungibleToken.NFT})` with internal force-cast to `@NFT`; published cap type is concrete `&Collection`.
4. **`NonFungibleToken`** at `0x1d7e57aa55817448` — full source returned inline (~280 lines). Verified: `CollectionPublic.deposit(token: @{NFT})` interface signature; `Withdraw` entitlement.
5. **`MetadataViews`** at `0x1d7e57aa55817448` — manifest fetched (size 30,543 bytes). Imported but not referenced in the transaction body, so no per-symbol verification was needed.

The Cadence MCP server is a development-time verification tool only; production reads must continue to route through the existing `topshot-proxy` / `pinnacle-proxy` / `spork-proxy` / `allday-proxy` / `hybrid-custody-proxy` Cloudflare workers (Vercel and Supabase egress is blocked at Flow public endpoints).
