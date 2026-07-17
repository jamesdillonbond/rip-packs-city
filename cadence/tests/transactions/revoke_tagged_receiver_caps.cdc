// transactions/revoke_tagged_receiver_caps.cdc
//
// Test-only: deletes every capability controller on the signer's
// ExampleNFT collection storage path whose tag matches
// "rpc-test-revocable-incoming" (set by
// deposit_to_trade_example_nft_revocable.cdc). Deleting a controller
// invalidates the issued capability — subsequent borrow()s return nil —
// which is the cap-revocation primitive testReceiverCapInvalidation
// needs. The signer's published collection cap (untagged, separate
// controller) is untouched.

import "ExampleNFT"

transaction {
    prepare(signer: auth(GetStorageCapabilityController) &Account) {
        var revoked = 0
        // Snapshot the array first — deleting while iterating
        // forEachController aborts, per the API contract.
        let controllers = signer.capabilities.storage
            .getControllers(forPath: ExampleNFT.CollectionStoragePath)
        for controller in controllers {
            if controller.tag == "rpc-test-revocable-incoming" {
                controller.delete()
                revoked = revoked + 1
            }
        }
        assert(revoked > 0, message: "No tagged revocable receiver cap found to revoke")
    }
}
