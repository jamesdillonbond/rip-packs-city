// transactions/mint_example_nft.cdc
//
// Mint a single ExampleNFT to the given recipient. Signed by admin
// (the ExampleNFT contract account, which holds the NFTMinter resource).

import "NonFungibleToken"
import "ExampleNFT"
import "MetadataViews"

transaction(recipient: Address) {
    let minter: &ExampleNFT.NFTMinter
    let receiver: &{NonFungibleToken.Receiver}

    prepare(signer: auth(BorrowValue) &Account) {
        self.minter = signer.storage.borrow<&ExampleNFT.NFTMinter>(
            from: ExampleNFT.MinterStoragePath
        ) ?? panic("Could not borrow ExampleNFT minter")

        let recipientAcct = getAccount(recipient)
        self.receiver = recipientAcct.capabilities.borrow<&{NonFungibleToken.Receiver}>(
            ExampleNFT.CollectionPublicPath
        ) ?? panic("Recipient missing ExampleNFT collection")
    }

    execute {
        self.minter.mintNFT(
            recipient: self.receiver,
            name: "Test NFT",
            description: "A test NFT for RPCTradeEscrow tests",
            thumbnail: "https://example.test/nft.png",
            royalties: []
        )
    }
}
