import TopShot from "TopShot"
import NonFungibleToken from "NonFungibleToken"

access(all) fun main(address: Address): [UInt64] {
    let account = getAccount(address)
    let collectionRef = account.capabilities
        .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("Could not borrow TopShot collection from address")
    return collectionRef.getIDs()
}