// Disney Pinnacle edition-key resolver
//
// Given a (nftId, owner) pair, borrows the NFT from the owner's Pinnacle
// collection and reconstructs the edition_key used by pinnacle_editions.id,
// formatted as `{royaltyCode}:{variant}:{printing}`.
//
// Validated on nft_id 43980467162686 @ 0x84387b2cd4617bf3 →
//   "STAR-OEV1-MAND:Brushed Silver:2"
//
// The Resolved struct always returns — when the NFT cannot be borrowed or
// its traits cannot be read, every field is nil and the caller should skip.

import Pinnacle from 0xedf9df96c92f4595
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import ViewResolver from 0x1d7e57aa55817448

access(all) struct Resolved {
    access(all) let royaltyCode: String?
    access(all) let variant: String?
    access(all) let printing: UInt64?
    access(all) let editionKey: String?
    access(all) let rawRoyaltyCodeType: String?

    init(
        royaltyCode: String?,
        variant: String?,
        printing: UInt64?,
        editionKey: String?,
        rawRoyaltyCodeType: String?
    ) {
        self.royaltyCode = royaltyCode
        self.variant = variant
        self.printing = printing
        self.editionKey = editionKey
        self.rawRoyaltyCodeType = rawRoyaltyCodeType
    }
}

access(all) fun main(id: UInt64, owner: Address): Resolved {
    let empty = Resolved(
        royaltyCode: nil,
        variant: nil,
        printing: nil,
        editionKey: nil,
        rawRoyaltyCodeType: nil
    )

    let acct = getAccount(owner)
    let colRef = acct.capabilities.borrow<&{NonFungibleToken.Collection}>(
        Pinnacle.CollectionPublicPath
    )
    if colRef == nil {
        return empty
    }

    let nftOpt = colRef!.borrowNFT(id)
    if nftOpt == nil {
        return empty
    }
    let nft = nftOpt!

    let traitsViewOpt = nft.resolveView(Type<MetadataViews.Traits>())
    if traitsViewOpt == nil {
        return empty
    }
    let traits = traitsViewOpt! as! MetadataViews.Traits

    var royaltyCode: String? = nil
    var variant: String? = nil
    var printing: UInt64? = nil
    var rawRoyaltyCodeType: String? = nil

    for trait in traits.traits {
        let raw = trait.value
        let rawType = raw.getType().identifier

        if trait.name == "Royalty Code" || trait.name == "royaltyCode" {
            rawRoyaltyCodeType = rawType
            if let s = raw as? String {
                royaltyCode = s
            }
        } else if trait.name == "Variant" || trait.name == "variant" {
            if let s = raw as? String {
                variant = s
            }
        } else if trait.name == "Printing" || trait.name == "printing" {
            if let u = raw as? UInt64 {
                printing = u
            } else if let i = raw as? Int {
                printing = UInt64(i)
            } else if let u32 = raw as? UInt32 {
                printing = UInt64(u32)
            } else if let s = raw as? String {
                printing = UInt64.fromString(s) ?? nil
            }
        }
    }

    var editionKey: String? = nil
    if royaltyCode != nil && variant != nil && printing != nil {
        editionKey = royaltyCode!
            .concat(":")
            .concat(variant!)
            .concat(":")
            .concat(printing!.toString())
    }

    return Resolved(
        royaltyCode: royaltyCode,
        variant: variant,
        printing: printing,
        editionKey: editionKey,
        rawRoyaltyCodeType: rawRoyaltyCodeType
    )
}
