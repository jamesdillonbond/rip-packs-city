// transactions/deposit_to_trade_example_nft2.cdc
//
// Test-only deposit transaction that withdraws ExampleNFT2 tokens and
// submits them to a trade. Exists solely for testTypeMismatchRejected:
// the trade under test commits the ExampleNFT type, so this deposit must
// be rejected by the contract's NFT-type check.

import "NonFungibleToken"
import "ExampleNFT2"
import "RPCTradeEscrow"

transaction(tradeId: UInt64, nftIds: [UInt64]) {
    prepare(
        signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability) &Account
    ) {
        // 1. Provider: withdraw the NFTs.
        let provider = signer.storage.borrow<auth(NonFungibleToken.Withdraw) &ExampleNFT2.Collection>(
            from: ExampleNFT2.CollectionStoragePath
        ) ?? panic("Could not borrow ExampleNFT2.Collection with Withdraw entitlement")

        let withdrawn: @[{NonFungibleToken.NFT}] <- []
        for id in nftIds {
            withdrawn.append(<- provider.withdraw(withdrawID: id))
        }

        // 2. Refund receiver: back to signer's own ExampleNFT2 collection.
        var refundCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
            ExampleNFT2.CollectionPublicPath
        )
        if !refundCap.check() {
            let issued = signer.capabilities.storage
                .issue<&{NonFungibleToken.Receiver}>(ExampleNFT2.CollectionStoragePath)
            signer.capabilities.publish(issued, at: ExampleNFT2.CollectionPublicPath)
            refundCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
                ExampleNFT2.CollectionPublicPath
            )
        }
        assert(refundCap.check(), message: "Refund receiver invalid")

        // 3. Incoming receiver: same path — never reached, the deposit
        // must revert on the type check before receivers matter.
        let incomingCap = signer.capabilities.get<&{NonFungibleToken.Receiver}>(
            ExampleNFT2.CollectionPublicPath
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
