// transactions/giveaway_assign.cdc — the signer's Sponsor names a pack's winner.
import "RPCGiveawayPacks"

transaction(packID: UInt64, recipient: Address) {
    prepare(signer: auth(BorrowValue) &Account) {
        let sponsor = signer.storage.borrow<auth(RPCGiveawayPacks.Manage) &RPCGiveawayPacks.Sponsor>(from: RPCGiveawayPacks.SponsorStoragePath)
            ?? panic("No Sponsor")
        sponsor.assign(packID: packID, recipient: recipient)
    }
}
