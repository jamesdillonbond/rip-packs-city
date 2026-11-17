// Disney Pinnacle edition-key resolver.
// Validated against nft_id 43980467162686 @ 0x84387b2cd4617bf3
//   -> "STAR-OEV1-MAND:Brushed Silver:2"

import Pinnacle from 0xedf9df96c92f4595
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448

access(all) struct Resolved {
    access(all) let nftID: UInt64
    access(all) let royaltyCode: String?
    access(all) let variant: String?
    access(all) let printing: UInt64?
    access(all) let setName: String?
    access(all) let editionKey: String?
    access(all) let rawRoyaltyCodeType: String?

    init(
        nftID: UInt64,
        royaltyCode: String?,
        variant: String?,
        printing: UInt64?,
        setName: String?,
        editionKey: String?,
        rawRoyaltyCodeType: String?
    ) {
        self.nftID = nftID
        self.royaltyCode = royaltyCode
        self.variant = variant
        self.printing = printing
        self.setName = setName
        self.editionKey = editionKey
        self.rawRoyaltyCodeType = rawRoyaltyCodeType
    }
}

access(all) fun main(nftID: UInt64, ownerAddress: Address): Resolved {
    let account = getAccount(ownerAddress)
    let collectionCap = account.capabilities.get<&{NonFungibleToken.Collection}>(
        Pinnacle.CollectionPublicPath
    )

    if !collectionCap.check() {
        return Resolved(nftID: nftID, royaltyCode: nil, variant: nil, printing: nil, setName: nil, editionKey: nil, rawRoyaltyCodeType: "no_capability")
    }

    let collection = collectionCap.borrow()!
    let nftRef = collection.borrowNFT(nftID)
    if nftRef == nil {
        return Resolved(nftID: nftID, royaltyCode: nil, variant: nil, printing: nil, setName: nil, editionKey: nil, rawRoyaltyCodeType: "borrow_nil")
    }
    let nft = nftRef!

    var royaltyCode: String? = nil
    var variant: String? = nil
    var printing: UInt64? = nil
    var setName: String? = nil
    var rawTypeInfo: String? = nil

    if let traits = MetadataViews.getTraits(nft) {
        for trait in traits.traits {
            if trait.name == "RoyaltyCodes" {
                rawTypeInfo = trait.value.getType().identifier
                if let arr = trait.value as? [String] {
                    if arr.length > 0 {
                        royaltyCode = arr[0]
                    }
                }
            } else if trait.name == "Variant" {
                if let v = trait.value as? String {
                    variant = v
                }
            } else if trait.name == "Printing" {
                if let p = trait.value as? Int {
                    printing = UInt64(p)
                } else if let p2 = trait.value as? UInt64 {
                    printing = p2
                } else if let p3 = trait.value as? Int32 {
                    printing = UInt64(p3)
                } else if let p4 = trait.value as? UInt32 {
                    printing = UInt64(p4)
                }
            } else if trait.name == "SetName" {
                if let s = trait.value as? String {
                    setName = s
                }
            }
        }
    }

    var editionKey: String? = nil
    if royaltyCode != nil && variant != nil && printing != nil {
        editionKey = royaltyCode!.concat(":").concat(variant!).concat(":").concat(printing!.toString())
    }

    return Resolved(
        nftID: nftID,
        royaltyCode: royaltyCode,
        variant: variant,
        printing: printing,
        setName: setName,
        editionKey: editionKey,
        rawRoyaltyCodeType: rawTypeInfo
    )
}
