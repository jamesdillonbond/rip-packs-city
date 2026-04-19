import Pinnacle from "Pinnacle"
import MetadataViews from "MetadataViews"
import ViewResolver from "ViewResolver"
import NonFungibleToken from "NonFungibleToken"

access(all) fun main(nftID: UInt64, ownerAddress: Address): {String: AnyStruct} {
    let account = getAccount(ownerAddress)
    let result: {String: AnyStruct} = {}

    let collectionCap = account.capabilities.get<&{NonFungibleToken.Collection}>(/public/PinnacleCollection)

    if !collectionCap.check() {
        result["error"] = "PinnacleCollection capability not found"
        return result
    }

    let collection = collectionCap.borrow()!
    let ids = collection.getIDs()
    result["total_nfts_in_collection"] = ids.length
    result["contains_target_nft"] = ids.contains(nftID)

    let nftRef = collection.borrowNFT(nftID)
    if nftRef == nil {
        result["error"] = "borrowNFT returned nil"
        return result
    }

    let nft = nftRef!
    result["nft_uuid"] = nft.uuid
    result["nft_id_field"] = nft.id
    result["nft_type"] = nft.getType().identifier

    let viewTypes = nft.getViews()
    let viewNames: [String] = []
    for v in viewTypes {
        viewNames.append(v.identifier)
    }
    result["available_views"] = viewNames

    if let display = MetadataViews.getDisplay(nft) {
        result["display_name"] = display.name
        result["display_description"] = display.description
    }

    if let editions = MetadataViews.getEditions(nft) {
        let editionList: [{String: AnyStruct}] = []
        for ed in editions.infoList {
            editionList.append({
                "name": ed.name ?? "",
                "number": ed.number,
                "max": ed.max ?? (0 as UInt64)
            })
        }
        result["editions"] = editionList
    }

    if let serial = MetadataViews.getSerial(nft) {
        result["serial_number"] = serial.number
    }

    if let traits = MetadataViews.getTraits(nft) {
        let traitList: [{String: String}] = []
        for trait in traits.traits {
            traitList.append({
                "name": trait.name,
                "value": trait.value as? String ?? "(non-string)"
            })
        }
        result["traits"] = traitList
    }

    return result
}