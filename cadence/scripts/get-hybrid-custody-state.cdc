// HybridCustody state probe — reads BOTH sides of the link for one address.
//
//   Parent side: whether the address has a HybridCustody.Manager in storage
//   and, if so, its child + owned accounts.
//   Child side:  whether the address is itself a HybridCustody OwnedAccount
//   and, if so, which parents have REDEEMED it (pending, unredeemed parents
//   are excluded — they hold no capability yet).
//
// Used by the hybrid-custody-backfill edge function to enumerate account-
// linking state across known addresses (seeded_wallets, saved_wallets, recent
// buyers/sellers) since the event ingester only sees links made after its
// cursor started (block 151,110,101, 2026-05-10).
//
// ⚠ Why the child side exists (2026-09-29): the candidate set is almost all
// Dapper addresses, which are CHILDREN. Their parents are Flow Wallet
// addresses that are in no candidate list, so a parent-side-only probe found
// 6 pairs in total and linked_accounts missed 140 of 147 redeemed links held
// by saved+seeded wallets (0xbd94cade097e50ac among them).
//
// Resilience:
//   - Uses authAccount.storage.borrow so we read storage directly without
//     depending on a public capability being published.
//   - Returns a fully-populated empty struct when neither resource exists
//     (rather than panicking) so the caller can mark the address as scanned.

import HybridCustody from 0xd8a7e05a7ac670c0

access(all) struct LinkedAccountState {
    access(all) let address: Address
    access(all) let hasManager: Bool
    access(all) let childAddresses: [Address]
    access(all) let ownedAddresses: [Address]
    access(all) let isOwnedAccount: Bool
    access(all) let redeemedParents: [Address]

    init(
        address: Address,
        hasManager: Bool,
        childAddresses: [Address],
        ownedAddresses: [Address],
        isOwnedAccount: Bool,
        redeemedParents: [Address]
    ) {
        self.address = address
        self.hasManager = hasManager
        self.childAddresses = childAddresses
        self.ownedAddresses = ownedAddresses
        self.isOwnedAccount = isOwnedAccount
        self.redeemedParents = redeemedParents
    }
}

access(all) fun main(addr: Address): LinkedAccountState {
    let acct = getAuthAccount<auth(BorrowValue) &Account>(addr)

    var hasManager = false
    var children: [Address] = []
    var owned: [Address] = []
    if let manager = acct.storage.borrow<&HybridCustody.Manager>(from: HybridCustody.ManagerStoragePath) {
        hasManager = true
        children = manager.getChildAddresses()
        owned = manager.getOwnedAddresses()
    }

    var isOwnedAccount = false
    let redeemed: [Address] = []
    if let ownedAcct = acct.storage.borrow<&HybridCustody.OwnedAccount>(from: HybridCustody.OwnedAccountStoragePath) {
        isOwnedAccount = true
        for parent in ownedAcct.getParentStatuses().keys {
            if ownedAcct.getRedeemedStatus(addr: parent) == true {
                redeemed.append(parent)
            }
        }
    }

    return LinkedAccountState(
        address: addr,
        hasManager: hasManager,
        childAddresses: children,
        ownedAddresses: owned,
        isOwnedAccount: isOwnedAccount,
        redeemedParents: redeemed
    )
}
