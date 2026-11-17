# Design — Parent-signed Top Shot gifting (FCL single-signer flow)

**Date:** 2026-07-13 · **Author:** Claude Code (interactive) · **Status:** design, not yet built
**Depends on:** [Task 1 withdraw-filter probe](../research/hybrid-custody-filter-withdraw-probe-2026-07-13.md)

## The one insight that makes this buildable

A gift = withdraw a moment from the user's Hybrid-Custody **child** account (Dapper-custodied,
holds the moments) and deposit it to a recipient, authorized by the user's **parent** account.

Withdraw authority was **pre-granted by Dapper's `CapabilityFilter` at link time** (Task 1: the
filter is an `AllowlistFilter` that includes `A.0b2a3299cc857e29.TopShot.Collection`, and the
provider capability is live-resolvable end-to-end). So the gift transaction has **exactly one
signer — the parent.** There is **no Dapper co-signer.**

This is the entire reason gifting clears the wall that shelved Cart (Open #1) and Trade Hub (Open #3).
Those need Dapper's meta-tx co-signer because they spend DUC / touch Dapper's marketplace escrow
(see `lib/chains/flow/cadence/purchase-moment.ts`: two `prepare` signers, `buyer` **and**
`dapperAccount`, plus the DUC-leak post-condition). A gift moves an NFT the user already controls
via a capability Dapper already authorized — single self-custody signature, done.

## Account topology (verified live)

Standard Top Shot account-linking shape:

```
 PARENT  (self-custody wallet — Flow Wallet / Blocto / Dapper Self-Custody)   ← SIGNS
   │  holds HybridCustody.Manager, FlowToken vault (pays gas), 1 key, no DUC vault
   │  (verified on 0xaa40b06e5c62d145: has_hc_manager=true, has_flowTokenVault=true,
   │   has_ducVault=false, num_keys=1)
   ▼  link (relationship='restricted', AllowlistFilter)
 CHILD   (Dapper-custodied Top Shot account — holds the moments)
        /storage/MomentCollection  ← provider withdrawn through the parent's Manager
```

**Availability (honest):** this works for any parent whose wallet is **FCL-discoverable**. In the
normal Top Shot topology the parent is a **self-custody Flow wallet** → standard FCL discovery,
parent pays gas, **works today, no Dapper developer access needed.** A parent that is itself a
*Dapper-custodial* account is gated on the pending Dapper FCL connector (CLAUDE.md Open #0 — "Sign in
with Dapper" request pending).

**Addressable population — do NOT gate on `linked_accounts`.** The eligible set is *every Top Shot
user who has linked their account to a Flow wallet* — a large, growing population, not a handful.
RPC's `linked_accounts` table is only the **indexed subset** (seeded from `seeded_wallets` + recent
buyers/sellers via the hybrid-custody-events ingest + one-shot backfill); it undercounts the real
population badly and must not be the eligibility gate. **Discovery is live, per-connected-wallet:**
when a parent connects via FCL, read their `HybridCustody.Manager` **on-chain** to enumerate their
child accounts (the existing `cadence/scripts/get-hybrid-custody-state.cdc` does exactly this —
`getAuthAccount → borrow Manager → getChildAddresses()`), indexed or not. The "~9 pairs" figure from
Task 1 was RPC's *indexed* count, not the population — corrected here.

## The transaction (single signer) — legs individually verified on live contracts

`lib/chains/flow/cadence/gift-moment.ts` (put it here so `npm run test:cadence` lints it):

```cadence
import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29

/// Parent-signed gift of a Top Shot moment out of a Hybrid-Custody child account.
/// SINGLE signer (the parent). No Dapper co-signer.
transaction(childAddress: Address, providerControllerID: UInt64, momentID: UInt64, recipient: Address) {
    let provider: auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}
    let recipientReceiver: &{NonFungibleToken.Receiver}

    prepare(parent: auth(BorrowValue) &Account) {
        let manager = parent.storage
            .borrow<auth(HybridCustody.Manage) &HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath)
            ?? panic("No HybridCustody Manager in signer wallet — this account has no linked children")

        let child = manager.borrowAccount(addr: childAddress)
            ?? panic("Signer is not the parent of ".concat(childAddress.toString()))

        let cap = child.getCapability(
            controllerID: providerControllerID,
            type: Type<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>()
        ) ?? panic("Withdraw capability unavailable — Dapper filter blocked it or controllerID is stale")

        self.provider = (cap as! Capability<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>).borrow()
            ?? panic("Could not borrow provider from child collection")

        self.recipientReceiver = getAccount(recipient).capabilities
            .borrow<&{NonFungibleToken.Receiver}>(/public/MomentCollection)
            ?? panic("Recipient has no Top Shot collection to receive into")
    }

    execute {
        let moment <- self.provider.withdraw(withdrawID: momentID)
        assert(moment.getType() == Type<@TopShot.NFT>(), message: "Withdrawn NFT is not a Top Shot moment")
        self.recipientReceiver.deposit(token: <-moment)
    }
}
```

**Verification status (per CLAUDE.md Cadence rule):**
- `HybridCustody.Manager` borrow with `auth(HybridCustody.Manage)`, `borrowAccount(addr)`,
  `getCapability(controllerID, type)` — **all ran successfully** in the Task 1 probe against live
  `0xd8a7e05a7ac670c0`.
- Provider borrow `auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}` at
  `/storage/MomentCollection` + `withdraw(withdrawID:)` — proven live.
- Recipient `&{NonFungibleToken.Receiver}` at `/public/MomentCollection`, `getSupportedNFTTypes()`
  includes `@TopShot.NFT`, `deposit(token:)` — proven live; identical deposit path to the
  live-tx-verified `purchase-moment.ts`.
- `cadence_check` cannot resolve mainnet imports (local checker, no network fetch), so **final
  end-to-end validation must be an actual signed low-value-moment gift on mainnet** (or a
  testnet/emulator deploy of the contracts). Every member/path used is individually live-verified;
  the only unverified thing is the assembled tx executing as one unit.
- **`limit`/gas:** set `999` (HybridCustody factory borrow adds overhead vs the 1000 purchase tx).

## FCL client flow (single-sig)

Reuse `initFcl()` from `lib/flow.ts` (transaction-signing config, no account-proof resolver — the
gift needs signing, not identity proof). Do **not** use `lib/chains/flow/fcl-config.ts` (that one is
for account-proof auth).

```ts
import * as fcl from "@onflow/fcl";
import { initFcl } from "@/lib/flow";
import { GIFT_MOMENT_CADENCE } from "@/lib/chains/flow/cadence/gift-moment";

initFcl();
// parent connects via discovery (Flow Wallet / Dapper Self-Custody / Blocto)
await fcl.authenticate();

// args come verbatim from POST /api/gift/quote (server-validated, never client-built)
const txId = await fcl.mutate({
  cadence: GIFT_MOMENT_CADENCE,
  args: (arg, t) => [
    arg(childAddress,               t.Address),
    arg(String(providerControllerID), t.UInt64),
    arg(String(momentID),           t.UInt64),
    arg(recipient,                  t.Address),
  ],
  proposer: fcl.authz,        // parent
  payer: fcl.authz,           // parent pays gas (v1) — see Gas section
  authorizations: [fcl.authz],// parent
  limit: 999,
});
const sealed = await fcl.tx(txId).onceSealed();
// sealed.status === 4 && sealed.errorMessage === "" → success
```

Single `fcl.authz` everywhere = one signer. (Contrast `purchase-moment.ts`, which would need a
second `dapperAccount` authorizer.)

## Server-side validation — `POST /api/gift/quote`

Read-only preflight so the client only ever signs **server-verified** args, and the user gets a
clean "can't gift because X" instead of a mid-transaction panic that still burns gas. All reads go
through the **hybrid-custody-proxy** worker `POST /script` (never direct to Flow; never echo the
secret) — same path Task 1 used.

Request: `{ parentAddress, childAddress, momentID, recipient }`. **Recipient = any Dapper or Flow
wallet** — accept a raw Flow address (`0x`+16 hex), or an RPC username resolved to an address via the
`profiles` table (reverse TS-username→address is not reliably available — `searchUsers` doesn't
exist, [[topshot-address-to-username-query]] — so support raw address + RPC username; TS username
only if cached in `wallet_usernames`).

One Cadence read (via proxy) returns everything:
1. parent has a `HybridCustody.Manager` and `childAddress ∈ getChildAddresses()` — else `not_your_link`.
2. the child's filter allows the TopShot provider **and** a provider controller exists on
   `/storage/MomentCollection` — return its `capabilityID` as `providerControllerID`
   (scan controllers for `.capability.check<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>()`;
   Task 1 found id 76 this way) — else `withdraw_not_permitted`.
3. the child actually owns `momentID` (borrow child `&{NonFungibleToken.CollectionPublic}` public
   path, or cross-check `wallet_moments_cache`) — else `moment_not_owned`.
4. recipient has a TopShot `&{NonFungibleToken.Receiver}` at `/public/MomentCollection` accepting
   `@TopShot.NFT` — return `recipient_ready: true`; else `recipient_ready: false` with
   `recipient_needs_setup` (see next section — **not** a hard block).

Response: `{ ok, recipient_ready, args: { childAddress, providerControllerID, momentID, recipient },
summary: { momentTitle, serial, recipientLabel } }` or `{ ok: false, reason }`.

### Recipient readiness (any Dapper or Flow wallet)

- **Dapper recipient** — always ready: a Dapper Top Shot account already publishes the
  `/public/MomentCollection` receiver (they hold moments). Verified live. Deposit works directly.
- **Flow-wallet recipient** — ready **iff** they've set up a Top Shot collection. Many TS-ecosystem
  Flow wallets already have one; a brand-new wallet does not. **A gift transaction cannot create the
  recipient's collection** (you can't write another account's storage without their signature — hard
  Cadence constraint), so a not-ready recipient must run a **one-time, self-signed** TopShot
  `setup_account` transaction first (creates `/storage/MomentCollection` + publishes the public
  receiver — the same setup every collector already has; `TopShot.createEmptyCollection` confirmed on
  the deployed contract). Flow: `quote` returns `recipient_ready:false` → UI shows "This wallet needs
  a Top Shot collection first" with a shareable setup link the *recipient* signs (or, if the
  recipient is the connected user gifting to their own second wallet, an inline setup step). The
  gift itself is unchanged and lands once they're set up. This keeps "gift to any Dapper or Flow
  wallet" true without the escrow/claim complexity.

`providerControllerID` is stable but not eternal (only changes if Dapper deletes/reissues the cap on
re-link). Re-discover on a signing failure and retry once.

Route auth: goes under the `/api/gift/*` public-ish carve-out in `proxy.ts` (reads only; the real
gate is the wallet signature, which RPC cannot forge). Optional: rate-limit + require the caller's
session to own `parentAddress` (verified-wallet link) to reduce scraping.

## Optional — `POST /api/gift/record`

After `onceSealed()` success, record `{ txId, parentAddress, childAddress, momentID, recipient,
sealed_at }` for analytics/funnel (new `moment_gifts` table, RLS service-role writes, or a
`funnel_events` row). Not required for the transfer to work.

## UI/UX

- On any moment the connected user owns **through a linked child account** (surfaced in
  wallet/portfolio views), show a **"Gift"** action next to "View on Top Shot".
- Modal: recipient input (address / TS username / RPC username, with live resolution + a
  green "can receive ✓" / red "needs a Top Shot collection" check from `/api/gift/quote`), moment
  preview, plain-language summary ("Send *LeBron James · Series 4 · #1234* to *@collector*").
- "Send gift" → `fcl.mutate` → wallet prompt (user sees the exact moment + recipient there too, the
  real trust boundary) → pending/sealed toast with a Flowscan link.
- Failure copy maps 1:1 to the `quote` reasons + `user_rejected` (wallet cancel) + `insufficient_gas`.

## Gas / payer strategy

- **v1 — parent pays.** The self-custody parent has a FlowToken vault (verified) and gas is a few
  µFLOW. `payer: fcl.authz`. Zero new infra.
- **v2 — RPC-sponsored (optional).** Swap `payer` for a backend authorization function that signs
  with the RPC Cadence payer wallet `0x73f55c4450b8d466` via a server endpoint (`/api/flow/payer-authz`).
  **Blocked today:** that wallet is intentionally empty and its balance-check cron is paused
  (CLAUDE.md Open #9). Reviving = fund it >0.05 FLOW + un-pause + build the payer authz. Nice UX,
  not required.

## Security model & invariants

- **RPC never holds the parent's keys.** It cannot gift without the parent's wallet signature —
  consistent with the rewards no-server-moves-assets invariant ([[rewards-points-economy-invariant]]).
- **Fixed, audited Cadence template.** The only thing the client submits is `GIFT_MOMENT_CADENCE`;
  args are server-validated in `/api/gift/quote` **and** shown in the wallet prompt.
- **Scoped withdrawal.** Exactly one moment (`withdrawID: momentID`), with an `assert` that the
  withdrawn NFT is a `@TopShot.NFT`. No funds, no DUC, no marketplace escrow → no leak post-condition
  needed.
- **Signer-is-parent gate is on-chain.** The `Manager` borrow + `borrowAccount(childAddress)` panic
  unless the signer is the real parent of that child. RPC cannot coerce a different signer into
  gifting someone else's moment.
- **No arbitrary-Cadence path.** `/api/gift/*` never accepts caller-supplied Cadence.

## Failure modes → handling

| Failure | On-chain result | Mitigation |
|---|---|---|
| Signer wallet ≠ link parent | `borrowAccount` panic | `quote` requires connected addr == `parentAddress` |
| Stale/wrong `providerControllerID` | `getCapability` → nil → panic | `quote` re-discovers fresh; retry once |
| Filter doesn't allow (non-TS) | `getCapability` → nil → panic | `quote` checks filter first; Pinnacle excluded |
| Recipient (Flow wallet) has no TS collection | `borrow` receiver panic | `quote` returns `recipient_ready:false`; recipient runs one-time self-signed setup, then gift lands (Dapper recipients never hit this) |
| Child doesn't own `momentID` | `withdraw` panic | `quote` verifies ownership |
| Parent out of FLOW | pre-exec gas failure | show balance hint; or v2 sponsorship |
| User rejects in wallet | fcl throws | toast "gift cancelled" |

## Build phasing

- **Phase 1 (buildable now, no external deps):** `gift-moment.ts` template · `/api/gift/quote`
  (proxy reads: link + filter + controllerID + ownership + recipient + username resolution) ·
  client `fcl.mutate` (parent-pays) · "Gift" button on linked-account-owned moments ·
  `/api/gift/record`. Validate with one real low-value-moment gift on mainnet using a controlled
  linked pair (final end-to-end proof `cadence_check` can't give).
- **Phase 2 (optional):** RPC gas sponsorship · batch gifting (array of `momentID`s, single sig) ·
  Dapper-custodial-parent support once the Dapper FCL connector lands · gift-to-RPC-user
  claim/escrow flow for recipients without a wallet (materially more complex; likely out of scope
  for an intelligence-first product).

## Files this touches (new + reused)

- **New:** `lib/chains/flow/cadence/gift-moment.ts` · `app/api/gift/quote/route.ts` ·
  `app/api/gift/record/route.ts` · a `GiftMomentModal` component · optional `moment_gifts` table.
- **Reused:** `initFcl()` (`lib/flow.ts`) · hybrid-custody-proxy `/script` · `useFlowUser` (wallet
  connect + provider detection) · `wallet_moments_cache` (ownership) · username resolution.
- **Precedent (do not copy the co-signer):** `lib/chains/flow/cadence/purchase-moment.ts` is the
  two-signer shape; the gift is deliberately the single-signer inverse.

## Decisions

- **Recipient scope — DECIDED (Trevor, 2026-07-13): any Dapper or Flow wallet.** Raw Flow address
  accepted; RPC-username convenience resolution; not-ready Flow wallets get the one-time setup path
  above. No restriction to RPC/TS users.
- **Eligibility — DECIDED: live per-connected-wallet on-chain read, NOT `linked_accounts`.** The
  addressable population is all Flow-wallet-linked TS users, large and growing.

Still open for Trevor:
1. Parent-pays gas (v1, zero infra) vs revive the payer wallet for RPC-sponsored gas (nicer UX)?
2. Ship Phase 1 now, or bundle it with a push to promote account linking (which grows the eligible
   population)?
