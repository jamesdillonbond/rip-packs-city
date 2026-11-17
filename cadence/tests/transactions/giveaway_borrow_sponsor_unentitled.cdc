// transactions/giveaway_borrow_sponsor_unentitled.cdc — a stranger can't reach a sponsor's Manage functions
// through a published capability: borrowing someone else's Sponsor needs their storage, which only they can sign for.
// Here the signer borrows THEIR OWN Sponsor WITHOUT the entitlement and must fail to type-check a call to assign().
import "RPCGiveawayPacks"

transaction(packID: UInt64, recipient: Address) {
    prepare(signer: auth(BorrowValue) &Account) {
        let sponsor = signer.storage.borrow<&RPCGiveawayPacks.Sponsor>(from: RPCGiveawayPacks.SponsorStoragePath)!
        sponsor.assign(packID: packID, recipient: recipient)
    }
}
