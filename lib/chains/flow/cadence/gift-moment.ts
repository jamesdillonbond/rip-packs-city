// lib/chains/flow/cadence/gift-moment.ts
//
// Parent-signed gift of an NBA Top Shot moment OUT of a Hybrid-Custody child
// account, deposited into any recipient's Top Shot collection.
//
// SINGLE signer — the parent. There is NO Dapper co-signer (unlike
// purchase-moment.ts, which needs the buyer + dapperAccount meta-tx co-signer to
// spend DUC). Withdraw authority was pre-granted by Dapper's CapabilityFilter at
// account-link time — the child's AllowlistFilter includes
// A.0b2a3299cc857e29.TopShot.Collection and the provider capability is
// live-resolvable end-to-end (verified 2026-07-13, see
// docs/design/parent-signed-gifting-fcl-flow-2026-07-13.md +
// docs/research/hybrid-custody-filter-withdraw-probe-2026-07-13.md).
//
// Every leg is verified against the live deployed contracts:
//   - HybridCustody.Manager borrow (auth Manage) + borrowAccount + getCapability(controllerID,type)
//   - Provider.withdraw at /storage/MomentCollection
//   - Receiver.deposit at /public/MomentCollection (accepts @TopShot.NFT)
//
// providerControllerID is discovered off-chain by /api/gift/quote (scans the
// child's /storage/MomentCollection capability controllers for the withdraw
// provider) and passed in. It is stable but re-discovered on failure.
//
// FCL usage (single signer, parent pays gas):
//   const txId = await fcl.mutate({
//     cadence: GIFT_MOMENT_CADENCE,
//     args: (arg, t) => [
//       arg(childAddress,               t.Address),
//       arg(String(providerControllerID), t.UInt64),
//       arg(String(momentID),           t.UInt64),
//       arg(recipient,                  t.Address),
//     ],
//     proposer: fcl.authz, payer: fcl.authz, authorizations: [fcl.authz],
//     limit: 999,
//   })

export const GIFT_MOMENT_CADENCE = `
import HybridCustody from 0xd8a7e05a7ac670c0
import NonFungibleToken from 0x1d7e57aa55817448
import TopShot from 0x0b2a3299cc857e29

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
`;

export const GIFT_MOMENT_GAS_LIMIT = 999;
