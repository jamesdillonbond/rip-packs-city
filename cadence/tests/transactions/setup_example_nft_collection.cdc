// transactions/setup_example_nft_collection.cdc
//
// Idempotent: sets up an ExampleNFT.Collection on the signer if missing,
// and publishes the standard public capability.

import "NonFungibleToken"
import "ExampleNFT"

transaction {
    prepare(signer: auth(BorrowValue, SaveValue, IssueStorageCapabilityController, PublishCapability) &Account) {
        if signer.storage.borrow<&ExampleNFT.Collection>(from: ExampleNFT.CollectionStoragePath) == nil {
            let collection <- ExampleNFT.createEmptyCollection(nftType: Type<@ExampleNFT.NFT>())
            signer.storage.save(<- collection, to: ExampleNFT.CollectionStoragePath)
            let cap = signer.capabilities.storage
                .issue<&{NonFungibleToken.Collection, NonFungibleToken.Receiver}>(ExampleNFT.CollectionStoragePath)
            signer.capabilities.publish(cap, at: ExampleNFT.CollectionPublicPath)
        }
    }
}
