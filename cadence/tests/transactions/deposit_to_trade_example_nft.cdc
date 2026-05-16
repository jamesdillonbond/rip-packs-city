// transactions/deposit_to_trade_example_nft.cdc
//
// Test-only deposit transaction targeting ExampleNFT. The production
// versions (one per real collection, see RPCTradeEscrow_DEPLOYMENT.md §3b)
// follow the same shape, substituting the collection's contract and
// storage/public paths.

import "NonFungibleToken"
import "ExampleNFT"
import "RPCTradeEscrow"

transaction(tradeId: UInt64, nftIds: [UInt64]) {
    prepare(
        signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability) &Account
    ) {
        // 1. Provider: withdraw the NFTs.
        let provider = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &ExampleNFT.Collection>(
            from: ExampleNFT.CollectionStoragePath
        ) ?? panic("Could not borrow ExampleNFT.Collection with Withdraw entitlement")

        let withdrawn: @[{NonFungibleToken.NFT}] <- []
        for id in nftIds {
            withdrawn.append(<- provider.withdraw(withdrawID: id))
        }

        // 2. Refund receiver: back to signer's own collection.
        var refundCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
            ExampleNFT.CollectionPublicPath
        )
        if !refundCap.check() {
            let issued = signer.capabilities.storage
                .issue<&{NonFungibleToken.Receiver}>(ExampleNFT.CollectionStoragePath)
            signer.capabilities.publish(issued, at: ExampleNFT.CollectionPublicPath)
            refundCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
                ExampleNFT.CollectionPublicPath
            )
        }
        assert(refundCap.check(), message: "Refund receiver invalid")

        // 3. Incoming receiver: same path since all test NFTs are ExampleNFT.
        // In production, the depositor's tx knows the OTHER party's NFT type
        // and resolves that contract's public path instead.
        let incomingCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
            ExampleNFT.CollectionPublicPath
        )
        assert(incomingCap.check(), message: "Incoming receiver not configured")

        // 4. Submit.
        RPCTradeEscrow.depositToTrade(
            tradeId: tradeId,
            depositor: signer.address,
            nfts: <- withdrawn,
            refundReceiver: refundCap,
            incomingReceiver: incomingCap
        )
    }
}
