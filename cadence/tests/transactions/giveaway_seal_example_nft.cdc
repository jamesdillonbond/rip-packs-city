// transactions/giveaway_seal_example_nft.cdc — seal the signer's ExampleNFTs into one pack.
import "NonFungibleToken"
import "ExampleNFT"
import "RPCGiveawayPacks"

transaction(dropID: String, packNo: UInt32, ids: [UInt64]) {
    prepare(signer: auth(BorrowValue) &Account) {
        let sponsor = signer.storage.borrow<auth(RPCGiveawayPacks.Manage) &RPCGiveawayPacks.Sponsor>(from: RPCGiveawayPacks.SponsorStoragePath)
            ?? panic("No Sponsor")
        let col = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &ExampleNFT.Collection>(from: ExampleNFT.CollectionStoragePath)
            ?? panic("No collection")
        let nfts: @[{NonFungibleToken.NFT}] <- []
        for id in ids {
            nfts.append(<- col.withdraw(withdrawID: id))
        }
        sponsor.seal(dropID: dropID, packNo: packNo, receiverPath: ExampleNFT.CollectionPublicPath, nfts: <- nfts)
    }
}
