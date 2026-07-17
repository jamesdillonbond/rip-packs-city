// scripts/get_example_nft2_ids.cdc
//
// Returns the list of ExampleNFT2 IDs currently held by an account.

import "NonFungibleToken"
import "ExampleNFT2"

access(all) fun main(addr: Address): [UInt64] {
    let acct = getAccount(addr)
    let collRef = acct.capabilities.borrow<&{NonFungibleToken.Collection}>(
        ExampleNFT2.CollectionPublicPath
    )
    if collRef == nil {
        return []
    }
    return collRef!.getIDs()
}
