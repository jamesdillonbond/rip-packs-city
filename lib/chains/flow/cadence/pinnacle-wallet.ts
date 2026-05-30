/**
 * lib/cadence/pinnacle-wallet.ts
 *
 * Cadence 1.0 scripts for fetching Disney Pinnacle NFTs from a wallet.
 * Contract: A.0xedf9df96c92f4595.Pinnacle (Flow mainnet)
 *
 * Pinnacle NFTs use MetadataViews for on-chain metadata.
 * Key metadata traits (confirmed from Flowty API probe 2026-04-12):
 *   - Characters (stringified array like "[Grogu]")
 *   - Franchises (stringified array like "[Star Wars]")
 *   - Studios (stringified array like "[Lucasfilm Ltd.]")
 *   - Categories (stringified array, not always present)
 *   - SetName (plain string)
 *   - SeriesName ("2024" etc)
 *   - Variant ("Standard" | "Brushed Silver" etc -- DIRECT, no derivation)
 *   - EditionType ("Open Edition" | "Limited Edition")
 *   - Printing ("1" or "2" as string)
 *   - Materials (stringified array)
 *   - Effects (stringified array, "[NONE]" on some)
 *   - Size, Color, Thickness (plain strings)
 *   - IsChaser ("false" as string)
 *   - RoyaltyCodes (stringified like "[STAR-OEV1-MAND]")
 *   - MintingDate (unix timestamp as string)
 *
 * Usage with FCL:
 *   import * as fcl from "@onflow/fcl"
 *   import { GET_PINNACLE_IDS, GET_PINNACLE_METADATA } from "@/lib/cadence/pinnacle-wallet"
 *
 *   const ids = await fcl.query({ cadence: GET_PINNACLE_IDS, args: (arg, t) => [arg(address, t.Address)] })
 *   const metadata = await fcl.query({ cadence: GET_PINNACLE_METADATA, args: (arg, t) => [arg(address, t.Address)] })
 */

// ── Script 1: Get owned Pinnacle NFT IDs (lightweight, fast) ─────────────────

export const GET_PINNACLE_IDS = `
import NonFungibleToken from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) fun main(address: Address): [UInt64] {
    let account = getAccount(address)

    let collectionRef = account.capabilities
        .borrow<&{NonFungibleToken.CollectionPublic}>(
            /public/PinnacleCollection
        )

    if collectionRef == nil {
        return []
    }

    return collectionRef!.getIDs()
}
`

// ── Script 2: Get Pinnacle NFT metadata (full details) ──────────────────────

export const GET_PINNACLE_METADATA = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) struct PinnaclePin {
    access(all) let id: UInt64
    access(all) let name: String
    access(all) let description: String
    access(all) let thumbnail: String
    access(all) let traits: {String: AnyStruct}
    access(all) let serial: UInt64?
    access(all) let editionName: String?
    access(all) let editionNumber: UInt64?
    access(all) let editionMax: UInt64?

    init(
        id: UInt64,
        name: String,
        description: String,
        thumbnail: String,
        traits: {String: AnyStruct},
        serial: UInt64?,
        editionName: String?,
        editionNumber: UInt64?,
        editionMax: UInt64?
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.thumbnail = thumbnail
        self.traits = traits
        self.serial = serial
        self.editionName = editionName
        self.editionNumber = editionNumber
        self.editionMax = editionMax
    }
}

access(all) fun main(address: Address): [PinnaclePin] {
    let account = getAccount(address)
    let pins: [PinnaclePin] = []

    let collectionRef = account.capabilities
        .borrow<&{NonFungibleToken.CollectionPublic, MetadataViews.ResolverCollection}>(
            /public/PinnacleCollection
        )

    if collectionRef == nil {
        return pins
    }

    let ids = collectionRef!.getIDs()

    for id in ids {
        let nft = collectionRef!.borrowViewResolver(id: id)
        if nft == nil { continue }

        // Display view
        var name = ""
        var description = ""
        var thumbnail = ""
        if let display = MetadataViews.getDisplay(nft!) {
            name = display.name
            description = display.description
            thumbnail = display.thumbnail.uri()
        }

        // Traits view
        var traits: {String: AnyStruct} = {}
        if let traitsView = MetadataViews.getTraits(nft!) {
            for trait in traitsView.traits {
                traits[trait.name] = trait.value
            }
        }

        // Edition view -- serial number for Limited Edition pins
        var serial: UInt64? = nil
        var editionName: String? = nil
        var editionNumber: UInt64? = nil
        var editionMax: UInt64? = nil
        if let editions = MetadataViews.getEditions(nft!) {
            if editions.infoList.length > 0 {
                let edition = editions.infoList[0]
                editionName = edition.name
                editionNumber = edition.number
                editionMax = edition.max
                serial = edition.number
            }
        }

        pins.append(PinnaclePin(
            id: id,
            name: name,
            description: description,
            thumbnail: thumbnail,
            traits: traits,
            serial: serial,
            editionName: editionName,
            editionNumber: editionNumber,
            editionMax: editionMax
        ))
    }

    return pins
}
`

// ── Script 3: Get Pinnacle NFT count only (cheapest call) ───────────────────

export const GET_PINNACLE_COUNT = `
import NonFungibleToken from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) fun main(address: Address): Int {
    let account = getAccount(address)

    let collectionRef = account.capabilities
        .borrow<&{NonFungibleToken.CollectionPublic}>(
            /public/PinnacleCollection
        )

    if collectionRef == nil {
        return 0
    }

    return collectionRef!.getIDs().length
}
`

// ── Script 4: Per-NFT details for write-time enrichment ─────────────────────
//
// Returns [{id, editionKey, serial}] for every Pinnacle NFT in the wallet
// in a single Cadence call. editionKey mirrors the formula used by the
// per-NFT resolve-pinnacle-nft.cdc script:
//   royaltyCode + ":" + variant + ":" + printing
// Returns null editionKey for NFTs missing any of the three traits.
//
// Used by wallet-backfill-pinnacle's runPinnacleDetailsBackfill so each
// wallet_moments_cache row lands with edition_key populated at write time
// — closing the gap where stable-holding wallets (no recent Deposit
// events) were never reached by the pinnacle-nft-resolver path.

export const GET_PINNACLE_UNLOCKED_DETAILS = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) struct PinnacleDetail {
    access(all) let id: UInt64
    access(all) let editionKey: String?
    access(all) let serial: UInt64?
    init(id: UInt64, editionKey: String?, serial: UInt64?) {
        self.id = id
        self.editionKey = editionKey
        self.serial = serial
    }
}

// Mirrors the per-NFT resolve-pinnacle-nft.cdc pattern: borrow a plain
// NonFungibleToken.Collection capability, iterate getIDs(), call borrowNFT
// for each id and pass the NFT ref directly to MetadataViews.getTraits /
// getEditions (NFT itself implements ViewResolver). Avoids the
// ResolverCollection interface which is not present at the
// 0x1d7e57aa55817448 MetadataViews address on Pinnacle's contract surface.
access(all) fun main(addr: Address): [PinnacleDetail] {
    let out: [PinnacleDetail] = []
    let acct = getAccount(addr)
    let cap = acct.capabilities.get<&{NonFungibleToken.Collection}>(/public/PinnacleCollection)
    if !cap.check() { return out }
    let col = cap.borrow()!
    for id in col.getIDs() {
        let nftRef = col.borrowNFT(id)
        if nftRef == nil { continue }
        let nft = nftRef!

        var royaltyCode: String? = nil
        var variant: String? = nil
        var printing: UInt64? = nil
        if let traits = MetadataViews.getTraits(nft) {
            for trait in traits.traits {
                if trait.name == "RoyaltyCodes" {
                    if let arr = trait.value as? [String] {
                        if arr.length > 0 { royaltyCode = arr[0] }
                    }
                } else if trait.name == "Variant" {
                    if let v = trait.value as? String { variant = v }
                } else if trait.name == "Printing" {
                    if let p = trait.value as? Int { printing = UInt64(p) }
                    else if let p2 = trait.value as? UInt64 { printing = p2 }
                    else if let p3 = trait.value as? Int32 { printing = UInt64(p3) }
                    else if let p4 = trait.value as? UInt32 { printing = UInt64(p4) }
                }
            }
        }

        var editionKey: String? = nil
        if royaltyCode != nil && variant != nil && printing != nil {
            editionKey = royaltyCode!.concat(":").concat(variant!).concat(":").concat(printing!.toString())
        }

        var serial: UInt64? = nil
        if let editions = MetadataViews.getEditions(nft) {
            if editions.infoList.length > 0 {
                serial = editions.infoList[0].number
            }
        }

        out.append(PinnacleDetail(id: id, editionKey: editionKey, serial: serial))
    }
    return out
}
`

// ── Script 5: Paginated per-NFT details (mega-wallet recovery path) ─────────
//
// Identical output shape to GET_PINNACLE_UNLOCKED_DETAILS but walks only
// getIDs()[start..start+count] instead of every owned NFT. Used by
// runPaginatedDetailsBackfill when a single-shot details call hits Cadence
// 1110 (computation_limit_exceeded) on mega-wallets like
// 0x5f71947aea94eb43 (~7,700 Pinnacle NFTs). Per-NFT MetadataViews work
// (getTraits + getEditions) is the dominant compute cost here, so capping
// the window at ~1000 NFTs keeps each call comfortably under the 100k
// computation budget. args: address (Address), start (Int), count (Int).

export const GET_PINNACLE_UNLOCKED_DETAILS_RANGE = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) struct PinnacleDetail {
    access(all) let id: UInt64
    access(all) let editionKey: String?
    access(all) let serial: UInt64?
    init(id: UInt64, editionKey: String?, serial: UInt64?) {
        self.id = id
        self.editionKey = editionKey
        self.serial = serial
    }
}

access(all) fun main(addr: Address, start: Int, count: Int): [PinnacleDetail] {
    let out: [PinnacleDetail] = []
    let acct = getAccount(addr)
    let cap = acct.capabilities.get<&{NonFungibleToken.Collection}>(/public/PinnacleCollection)
    if !cap.check() { return out }
    let col = cap.borrow()!
    let ids = col.getIDs()
    let total = ids.length
    if start >= total { return out }
    var endVal = start + count
    if endVal > total { endVal = total }
    let window = ids.slice(from: start, upTo: endVal)
    for id in window {
        let nftRef = col.borrowNFT(id)
        if nftRef == nil { continue }
        let nft = nftRef!

        var royaltyCode: String? = nil
        var variant: String? = nil
        var printing: UInt64? = nil
        if let traits = MetadataViews.getTraits(nft) {
            for trait in traits.traits {
                if trait.name == "RoyaltyCodes" {
                    if let arr = trait.value as? [String] {
                        if arr.length > 0 { royaltyCode = arr[0] }
                    }
                } else if trait.name == "Variant" {
                    if let v = trait.value as? String { variant = v }
                } else if trait.name == "Printing" {
                    if let p = trait.value as? Int { printing = UInt64(p) }
                    else if let p2 = trait.value as? UInt64 { printing = p2 }
                    else if let p3 = trait.value as? Int32 { printing = UInt64(p3) }
                    else if let p4 = trait.value as? UInt32 { printing = UInt64(p4) }
                }
            }
        }

        var editionKey: String? = nil
        if royaltyCode != nil && variant != nil && printing != nil {
            editionKey = royaltyCode!.concat(":").concat(variant!).concat(":").concat(printing!.toString())
        }

        var serial: UInt64? = nil
        if let editions = MetadataViews.getEditions(nft) {
            if editions.infoList.length > 0 {
                serial = editions.infoList[0].number
            }
        }

        out.append(PinnacleDetail(id: id, editionKey: editionKey, serial: serial))
    }
    return out
}
`

// ── Constants ───────────────────────────────────────────────────────────────

export const PINNACLE_COLLECTION_PUBLIC_PATH = "/public/PinnacleCollection"
