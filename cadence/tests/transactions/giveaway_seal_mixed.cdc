// transactions/giveaway_seal_mixed.cdc — tries to seal an ExampleNFT and an ExampleNFT2 together (must fail).
import "NonFungibleToken"
import "ExampleNFT"
import "ExampleNFT2"
import "RPCGiveawayPacks"

transaction(id1: UInt64, id2: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let sponsor = signer.storage.borrow<auth(RPCGiveawayPacks.Manage) &RPCGiveawayPacks.Sponsor>(from: RPCGiveawayPacks.SponsorStoragePath)
            ?? panic("No Sponsor")
        let c1 = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &ExampleNFT.Collection>(from: ExampleNFT.CollectionStoragePath)!
        let c2 = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &ExampleNFT2.Collection>(from: ExampleNFT2.CollectionStoragePath)!
        let nfts: @[{NonFungibleToken.NFT}] <- [<- c1.withdraw(withdrawID: id1), <- c2.withdraw(withdrawID: id2)]
        sponsor.seal(dropID: "mixed", packNo: 1, receiverPath: ExampleNFT.CollectionPublicPath, nfts: <- nfts)
    }
}
