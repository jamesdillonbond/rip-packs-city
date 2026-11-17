// transactions/giveaway_reclaim.cdc — the signer's Sponsor takes a pack's NFTs back into its ExampleNFT collection.
import "NonFungibleToken"
import "ExampleNFT"
import "RPCGiveawayPacks"

transaction(packID: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let sponsor = signer.storage.borrow<auth(RPCGiveawayPacks.Manage) &RPCGiveawayPacks.Sponsor>(from: RPCGiveawayPacks.SponsorStoragePath)
            ?? panic("No Sponsor")
        let receiver = signer.capabilities.borrow<&{NonFungibleToken.Receiver}>(ExampleNFT.CollectionPublicPath)
            ?? panic("No receiver")
        sponsor.reclaim(packID: packID, to: receiver)
    }
}
