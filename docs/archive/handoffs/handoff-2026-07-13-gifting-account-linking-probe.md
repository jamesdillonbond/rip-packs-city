# Cowork handoff — Top Shot gifting/"Transfer" precursor: confirm the Hybrid Custody withdraw capability, then decide build

**For:** a Cowork session (has push clone, Supabase MCP read+write, the worker proxy secrets, Chrome — the tools a policy-restricted Claude Code web session lacks).
**Prereq reading:** `docs/research/topshot-gifting-account-linking-feasibility-2026-07-13.md` (the full verification finding this handoff acts on).

## Why this exists

We're scoping a gifting/sending feature as a low-complexity precursor to the shelved Trade
Hub — the clean wallet-to-wallet "Transfer" that Flowty offered and that Top Shot's own app
only does in a gated/buried way (identity check OR 10+ moments + 7-day hold; plus gift links).

**Already verified (docs + existence proof, high confidence):** Flow Account Linking
(Hybrid Custody) grants the parent (self-custody) wallet the `NonFungibleToken.Provider`
(withdraw) capability over the linked Dapper child collection — a different mechanism from
the Dapper co-signer wall that shelved Cart/Trade Hub, and one that needs **no** Dapper
developer account. Flowty's list/sell/rent/lend all required that same capability, so a
gift (withdraw+deposit) is strictly inside the granted set.

**What's left = the one empirical check a Claude Code web session can't run** (Flow
endpoints egress-blocked, proxy secret not provisioned there): a live read-only Cadence
probe against a REAL linked account, via the `hybrid-custody-proxy` worker, to confirm the
production `CapabilityFilter` actually returns a usable `Provider` cap today.

---

## TASK 1 (do this first) — Live capability probe

Goal: for a known parent→child link, confirm the parent can retrieve an
`auth(NonFungibleToken.Withdraw) &TopShot.Collection` (Provider) capability on the child.

Steps:
1. Pick a real link from `linked_accounts` (Supabase MCP):
   `select parent_addr, child_addr from linked_accounts limit 10;`
   Prefer Trevor's if present (`0xbd94cade097e50ac`). The child must hold TopShot moments.
2. **Before writing/running any Cadence, per CLAUDE.md's non-negotiable rule, use the
   Cadence MCP to fetch the DEPLOYED source of `HybridCustody` (`0xd8a7e05a7ac670c0`) on
   mainnet** and verify the exact current signatures of `Manager.borrowAccount(...)` and the
   child account's `getCapability(...)` (the arg is `controllerID: UInt64` vs
   `path: StoragePath` across versions — confirm which the live contract exposes), plus
   `ManagerStoragePath` and the `Manage` entitlement name.
3. Run a **read-only script** (scripts may use `getAuthAccount<auth(...) &Account>(addr)` in
   Cadence 1.0; transactions may not) through the `hybrid-custody-proxy` worker
   (Flow public endpoints block Vercel/Supabase egress — route via the worker, do NOT hit
   rest-mainnet.onflow.org directly). Draft to VERIFY-then-adjust against step 2:

   ```
   import HybridCustody from 0xd8a7e05a7ac670c0
   import NonFungibleToken from 0x1d7e57aa55817448
   import TopShot from 0x0b2a3299cc857e29

   // Returns true if the parent can retrieve a withdraw-entitled TopShot.Collection
   // capability on the linked child — i.e. a gift/transfer is executable.
   access(all) fun main(parent: Address, child: Address): Bool {
       let acct = getAuthAccount<auth(Storage) &Account>(parent)
       let manager = acct.storage.borrow<auth(HybridCustody.Manage) &HybridCustody.Manager>(
           from: HybridCustody.ManagerStoragePath
       ) ?? panic("no HybridCustody Manager in parent storage")

       let childAcct = manager.borrowAccount(addr: child)
           ?? panic("child not linked to this parent")

       let wantType = Type<auth(NonFungibleToken.Withdraw) &TopShot.Collection>()

       // Adjust the getCapability signature to the live contract (controllerID vs path).
       let cap = childAcct.getCapability(/* per verified sig */, type: wantType)
       if cap == nil { return false }
       // Confirm it actually resolves to a live, borrowable provider:
       let provider = (cap as! Capability<auth(NonFungibleToken.Withdraw) &TopShot.Collection>).borrow()
       return provider != nil
   }
   ```
4. Record the result in `docs/overnight/ledger.md` and in the research doc's "next steps":
   **true** = production filter grants withdraw → account-linked gifting is buildable and
   RPC-executable today. **false / cap not retrievable** = Dapper's filter is read-only for
   this collection → the RPC-executed path is dead and only the observe-and-orchestrate
   option (Task 2b) survives.

Guardrails: read-only script only in this task (no withdraw/transfer). Never echo the
`hybrid-custody-proxy` secret. Don't broad-read any secret-bearing console/DOM.

---

## TASK 2 (only after Task 1 = true) — pick a build direction with Trevor

- **2a — Account-linked RPC-executed gift.** New Cadence tx (parent-signed via FCL): borrow
  child `Provider` → `TopShot.Collection.withdraw(withdrawID:)` → deposit to recipient's
  public collection cap. Qualifying-user detection off `linked_accounts` (only linked
  parents can use it). Surface the Top-Shot-Score/Set/Challenge caveat in the UX. This is the
  same Hybrid Custody signing model Trade Hub will need — de-risks it at minimum complexity
  (no payment vault, no escrow contract).
- **2b — Co-signer-free "observe-and-orchestrate" layer** (works regardless of Task 1):
  build on top of Top Shot's native gift/gift-links — FMV-of-gift, "safe to gift?"
  score/tax warnings, username address book (we already resolve usernames), gift receipts +
  social/OG cards, recipient notify. Ships with zero blocker.
- Recommend surfacing both to Trevor; 2a is the differentiator, 2b is the always-shippable
  companion.

## Working rules for the Cowork session

- Commit + push directly to `main`; no feature branches, no PRs (CLAUDE.md).
- Cadence MCP verification before any `.cdc` / inline-Cadence / FCL change (non-negotiable).
- All production Flow reads via the worker proxies, never direct to public Flow/TS endpoints.
- Log anything shipped (with a revert path) in `docs/overnight/ledger.md`.
