// transactions/mint_example_nft2.cdc
//
// Mint a single ExampleNFT2 to the given recipient. Signed by admin
// (the ExampleNFT2 contract account, which holds the NFTMinter resource).

import "NonFungibleToken"
import "ExampleNFT2"

transaction(recipient: Address) {
    let minter: &ExampleNFT2.NFTMinter
    let receiver: &{NonFungibleToken.Receiver}

    prepare(signer: auth(BorrowValue) &Account) {
        self.minter = signer.storage.borrow<&ExampleNFT2.NFTMinter>(
            from: ExampleNFT2.MinterStoragePath
        ) ?? panic("Could not borrow ExampleNFT2 minter")

        let recipientAcct = getAccount(recipient)
        self.receiver = recipientAcct.capabilities.borrow<&{NonFungibleToken.Receiver}>(
            ExampleNFT2.CollectionPublicPath
        ) ?? panic("Recipient missing ExampleNFT2 collection")
    }

    execute {
        self.minter.mintNFT(recipient: self.receiver)
    }
}
