// transactions/deposit_to_trade_example_nft_revocable.cdc
//
// Test-only deposit variant for testReceiverCapInvalidation: identical to
// deposit_to_trade_example_nft.cdc EXCEPT the incoming receiver is a
// freshly ISSUED (never published) capability whose controller is tagged
// so revoke_tagged_receiver_caps.cdc can delete it later — invalidating
// only the incoming receiver while the refund receiver (the published
// cap, a separate controller) stays valid.

import "NonFungibleToken"
import "ExampleNFT"
import "RPCTradeEscrow"

transaction(tradeId: UInt64, nftIds: [UInt64]) {
    prepare(
        signer: auth(
            BorrowValue,
            IssueStorageCapabilityController,
            GetStorageCapabilityController,
            PublishCapability
        ) &Account
    ) {
        // 1. Provider: withdraw the NFTs.
        let provider = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &ExampleNFT.Collection>(
            from: ExampleNFT.CollectionStoragePath
        ) ?? panic("Could not borrow ExampleNFT.Collection with Withdraw entitlement")

        let withdrawn: @[{NonFungibleToken.NFT}] <- []
        for id in nftIds {
            withdrawn.append(<- provider.withdraw(withdrawID: id))
        }

        // 2. Refund receiver: the signer's PUBLISHED collection cap —
        // deliberately a different controller than the incoming cap below,
        // so revoking the incoming cap leaves refunds working.
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

        // 3. Incoming receiver: fresh issued cap, controller tagged for
        // later revocation.
        let incomingCap = signer.capabilities.storage
            .issue<&{NonFungibleToken.Receiver}>(ExampleNFT.CollectionStoragePath)
        signer.capabilities.storage
            .getController(byCapabilityID: incomingCap.id)!
            .setTag("rpc-test-revocable-incoming")
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
