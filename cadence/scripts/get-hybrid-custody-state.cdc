// HybridCustody state probe.
// Returns whether a Flow address has a HybridCustody.Manager in storage and,
// if so, lists its child + owned accounts.
//
// Used by the one-shot hybrid-custody-backfill edge function to enumerate
// historical account-linking state across known addresses (seeded_wallets +
// recent buyers/sellers) since event subscriptions only catch new links.
//
// Resilience:
//   - Uses authAccount.storage.borrow so we read storage directly without
//     depending on the public capability being published. Some manager owners
//     never publish a public cap.
//   - Returns a fully-populated empty struct when no Manager exists (rather
//     than panicking) so the caller can mark the address as scanned.

import HybridCustody from 0xd8a7e05a7ac670c0

access(all) struct LinkedAccountState {
    access(all) let address: Address
    access(all) let hasManager: Bool
    access(all) let childAddresses: [Address]
    access(all) let ownedAddresses: [Address]

    init(address: Address, hasManager: Bool, childAddresses: [Address], ownedAddresses: [Address]) {
        self.address = address
        self.hasManager = hasManager
        self.childAddresses = childAddresses
        self.ownedAddresses = ownedAddresses
    }
}

access(all) fun main(addr: Address): LinkedAccountState {
    let acct = getAuthAccount<auth(BorrowValue) &Account>(addr)
    let managerRef = acct.storage.borrow<&HybridCustody.Manager>(
        from: HybridCustody.ManagerStoragePath
    )

    if managerRef == nil {
        return LinkedAccountState(
            address: addr,
            hasManager: false,
            childAddresses: [],
            ownedAddresses: []
        )
    }

    let manager = managerRef!
    return LinkedAccountState(
        address: addr,
        hasManager: true,
        childAddresses: manager.getChildAddresses(),
        ownedAddresses: manager.getOwnedAddresses()
    )
}
