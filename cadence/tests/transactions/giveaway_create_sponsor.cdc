// transactions/giveaway_create_sponsor.cdc — store a Sponsor on the signer (idempotent).
import "RPCGiveawayPacks"

transaction {
    prepare(signer: auth(BorrowValue, SaveValue) &Account) {
        if signer.storage.borrow<&RPCGiveawayPacks.Sponsor>(from: RPCGiveawayPacks.SponsorStoragePath) == nil {
            signer.storage.save(<- RPCGiveawayPacks.createSponsor(), to: RPCGiveawayPacks.SponsorStoragePath)
        }
    }
}
