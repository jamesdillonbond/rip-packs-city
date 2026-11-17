// scripts/get_example_nft_ids.cdc
//
// Returns the list of ExampleNFT IDs currently held by an account.

import "NonFungibleToken"
import "ExampleNFT"

access(all) fun main(addr: Address): [UInt64] {
    let acct = getAccount(addr)
    let collRef = acct.capabilities.borrow<&ExampleNFT.Collection>(
        ExampleNFT.CollectionPublicPath
    )
    if collRef == nil {
        return []
    }
    return collRef!.getIDs()
}
