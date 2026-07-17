// transactions/setup_example_nft2_collection.cdc
//
// Idempotent: sets up an ExampleNFT2.Collection on the signer if missing,
// and publishes the standard public capability. Mirrors
// setup_example_nft_collection.cdc for the second (type-mismatch) fixture.

import "NonFungibleToken"
import "ExampleNFT2"

transaction {
    prepare(signer: auth(BorrowValue, SaveValue, IssueStorageCapabilityController, PublishCapability) &Account) {
        if signer.storage.borrow<&ExampleNFT2.Collection>(from: ExampleNFT2.CollectionStoragePath) == nil {
            let collection <- ExampleNFT2.createEmptyCollection(nftType: Type<@ExampleNFT2.NFT>())
            signer.storage.save(<- collection, to: ExampleNFT2.CollectionStoragePath)
            let cap = signer.capabilities.storage
                .issue<&{NonFungibleToken.Collection, NonFungibleToken.Receiver}>(ExampleNFT2.CollectionStoragePath)
            signer.capabilities.publish(cap, at: ExampleNFT2.CollectionPublicPath)
        }
    }
}
