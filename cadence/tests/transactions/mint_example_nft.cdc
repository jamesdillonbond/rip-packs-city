// transactions/mint_example_nft.cdc
//
// Mint a single ExampleNFT to the given recipient. Signed by admin
// (the ExampleNFT contract account, which holds the NFTMinter resource).
//
// Matches the flow-nft v1.2.x (Cadence 1.0) ExampleNFT API, where
// NFTMinter.mintNFT(name:description:thumbnail:royalties:) RETURNS the
// NFT instead of taking a recipient argument.

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
        let nft <- self.minter.mintNFT(
            name: "Test NFT",
            description: "A test NFT for RPCTradeEscrow tests",
            thumbnail: "https://example.test/nft.png",
            royalties: []
        )
        self.receiver.deposit(token: <- nft)
    }
}
