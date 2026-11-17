# Gifting / "Transfer" feasibility — account-linked (Hybrid Custody) path is the unlock

**Date:** 2026-07-13
**Question:** As a precursor to the shelved Trade Hub, can RPC build a gifting/sending
mechanism for Top Shot moments — the way Flowty's "Transfer" worked — given it hasn't
been cleanly stood up on the new Top Shot site?
**Verdict:** **Yes, RPC-executable — for the account-linked subset of users**, via Flow
Account Linking (Hybrid Custody). This is a *different* mechanism from the Dapper
co-signer wall that shelved Cart (Open #1) and Trade Hub (Open #3), and it does **not**
require the pending Dapper developer account (Open #0).

---

## 1. Premise correction — Top Shot DOES have native transfer today (but gated)

The framing "hasn't been stood up on the new Top Shot site" is only partly right. Top
Shot's own app already offers three native paths:

1. **Withdraw to a connected wallet** — send a moment out to a self-custody wallet you
   connected to your Dapper account.
2. **Collector-to-collector gifting** — send to another user *by username*, but gated:
   sender/recipient must have passed an **identity check**, *or* hold **10+ moments** and
   have owned the moment **7+ days**. If an identity check is in progress, gifting is
   blocked.
3. **Gift Links** — shareable claim links.

Caveat on withdrawal: a withdrawn moment no longer counts toward Top Shot Score, Set
completions, or Challenges — a real disincentive worth surfacing in any RPC gift UX.

What Flowty's "Transfer" actually delivered was a **clean, ungated, wallet-to-wallet
send**. That low-friction experience is the genuine gap — not the absence of any transfer.

## 2. The co-signer wall — and the path around it

| Signing path | RPC can execute? | Why |
|---|---|---|
| Direct Dapper-custodial FCL auth | **No** | Dapper is an opt-in FCL wallet requiring a **Dapper developer account** to enable; `components/SignInWithDapper.tsx` confirms it "returns no address." This is the Cart (`usePurchaseQueue.ts` `dapper_not_supported`) / Trade Hub wall. |
| **Account-linked (Hybrid Custody)** | **Yes (verified)** | User links Dapper → their own FCL wallet once; that parent wallet holds a `NonFungibleToken.Provider` capability on the Dapper child collection and can withdraw. No per-tx Dapper co-signer, no Dapper dev account. |
| Fully self-custody | Yes | Trivial withdraw+deposit, but ~no TS moments are held self-custody. |

## 3. Capability verification (the "verify first" result)

**Confirmed that Dapper's production `CapabilityFilter` allow-lists `NonFungibleToken.Provider`
(withdraw), not just read/metadata:**

- **Flow developer docs (Account Linking with Dapper):** "The user can sign a transaction
  with their authenticated account that retrieves a reference to a child account's
  `NonFungibleToken.Provider`, enabling **withdrawal from the child account** having signed
  as the parent account." Linked wallets may "view **and even manipulate** NFTs and assets."
- **Flowty is the production proof:** Flowty listed, sold, rented, and collateral-lent
  account-linked Top Shot moments for years. Every one of those requires the
  `Provider`/withdraw capability. A gift (withdraw + deposit) is strictly simpler, so it is
  unquestionably inside the granted set.

Confidence: **high**, on documentation + existence proof.

## 4. Real-world constraint — per-user opt-in, not universal

The capability is grantable, but only for users who have:
1. **Account Linking enabled** on their Dapper wallet (historically request/allowlist-gated
   by Dapper — not every collector has it).
2. **Linked** Dapper → a self-custody FCL wallet (Flow Wallet / Blocto / Dapper Self Custody).
3. **Signed into RPC** with that FCL wallet.

The constraint on reach is **account-linking adoption**, not the co-signer wall.

## 5. What RPC already has (read-side) vs. what's missing

Already built (read-only): `hybrid-custody-events` + `hybrid-custody-backfill` edge fns,
`hybrid-custody-proxy` worker against the HybridCustody contract `0xd8a7e05a7ac670c0`,
`linked_accounts` table (6 active links), `resolve_canonical_owner` /
`get_linked_parents` / `get_linked_children`, and `/api/profile/verify-link`. This lets us
**detect** which users qualify for account-linked transfer.

Missing: any transaction that borrows a **child** account's withdraw capability. Today the
only withdraw-entitled TopShot transfer is the hot-wallet break distributor
(`lib/chains/flow/cadence/break-transactions.ts` `BREAK_MULTI_TRANSFER_TS`). The
account-linked withdraw path has never been exercised.

## 6. Why gifting is a good Trade-Hub precursor

It exercises the **exact Hybrid Custody signing model Trade Hub needs**, at the lowest
complexity tier:
- **Gift** = borrow child `Provider` → `withdraw` → `deposit`. No payment vault, no escrow.
- **Buy** (Cart) adds a DUC payment vault + `post{}` DUC-leak check.
- **Trade** (Hub) adds a deployed `RPCTradeEscrow` contract + two-sided deposit/settle.

## 7. Recommended next steps

1. **(operator/Cowork) Live probe** — run a Cadence script via `hybrid-custody-proxy`
   against one real linked account (e.g. Trevor's `0xbd94cade097e50ac` if linked) to
   confirm the production filter empirically returns a usable `Provider` capability.
   (Not runnable from a policy-restricted Claude Code web egress — Flow endpoints blocked,
   proxy secret not provisioned.)
2. If confirmed, decide direction: (a) build the account-linked RPC-executed gift flow
   (withdraw+deposit + qualifying-user detection off `linked_accounts`), and/or (b) build a
   co-signer-free "observe-and-orchestrate" layer over Top Shot's native gift/gift-links
   (FMV-of-gift, "safe to gift?" score/tax warnings, username address-book, gift receipts +
   social cards, recipient notify).

## Sources

- Flow Developer Portal — Account Linking with NBA Top Shot:
  https://developers.flow.com/build/guides/account-linking-with-dapper
- Flow Developer Portal — Working With Parent Accounts:
  https://developers.flow.com/build/guides/account-linking/parent-accounts
- Dapper Services — Account Linking and FAQ:
  https://support.meetdapper.com/hc/en-us/articles/20744347884819-Account-Linking-and-FAQ
- Flowty — Account Linking on Flowty:
  https://flowty.substack.com/p/account-linking-on-flowty
- Flowty — All Top Shot Moments Are Now Non-Custodial (What That Means for YOU and Flowty):
  https://flowty.medium.com/all-top-shot-moments-are-now-non-custodial-what-that-means-for-you-and-flowty-6c178b3601d3
- NBA Top Shot — Sending Moments from Dapper to a Connected Wallet:
  https://support.nbatopshot.com/hc/en-us/articles/4408650629523
- NBA Top Shot — Gifting Guidelines / Gift Links:
  https://support.nbatopshot.com/hc/en-us/articles/1500007573422-Gifting-Guidelines
