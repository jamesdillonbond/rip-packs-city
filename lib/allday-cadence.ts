// Cadence scripts for NFL All Day (AllDay contract on Flow mainnet)
// Contract address: 0xe4cf4bdc1751c65d

// Get all edition IDs in a set → returns an array of edition IDs
export const GET_EDITIONS_IN_SET = `
  import AllDay from 0xe4cf4bdc1751c65d
  access(all)
  fun main(setID: UInt64): [UInt64] {
    let setData = AllDay.getSetData(id: setID) ?? panic("no set")
    return setData.editionIDs
  }
`

// Get edition data (playID, setID, tier, etc.)
export const GET_EDITION_DATA = `
  import AllDay from 0xe4cf4bdc1751c65d
  access(all)
  fun main(editionID: UInt64): {String: String} {
    let ed = AllDay.getEditionData(id: editionID) ?? panic("no edition")
    return {
      "playID": ed.playID.toString(),
      "setID": ed.setID.toString(),
      "tier": ed.tier ?? "COMMON",
      "maxMintSize": ed.maxMintSize?.toString() ?? "0",
      "numMinted": ed.numMinted.toString()
    }
  }
`

// Get play metadata (player name, team, etc.)
export const GET_PLAY_DATA = `
  import AllDay from 0xe4cf4bdc1751c65d
  access(all)
  fun main(playID: UInt64): {String: String} {
    let play = AllDay.getPlayData(id: playID) ?? panic("no play")
    return play.metadata
  }
`

export const GET_OWNED_MOMENT_IDS = `
  import AllDay from 0xe4cf4bdc1751c65d
  import NonFungibleToken from 0x1d7e57aa55817448
  access(all)
  fun main(address: Address): [UInt64] {
    let ref = getAccount(address).capabilities.borrow<&{NonFungibleToken.Collection}>(/public/AllDayNFTCollection)
    if ref == nil { return [] }
    return ref!.getIDs()
  }
`

// Returns [[nftID, editionID, serialNumber], ...] for all UNLOCKED moments in the wallet.
// Locked moments are moved to Dapper custodial infrastructure and are NOT present on-chain.
// Compare these nftIDs to a Flowty-sourced full list to determine is_locked.
export const GET_UNLOCKED_MOMENT_DETAILS = `
  import AllDay from 0xe4cf4bdc1751c65d
  import NonFungibleToken from 0x1d7e57aa55817448
  access(all) fun main(addr: Address): [[UInt64]] {
    let r: [[UInt64]] = []
    let ref = getAccount(addr).capabilities.borrow<&{NonFungibleToken.Collection}>(/public/AllDayNFTCollection)
    if ref == nil { return r }
    for id in ref!.getIDs() {
      let nft = ref!.borrowNFT(id)!
      let ad = nft as! &AllDay.NFT
      r.append([id, ad.editionID, ad.serialNumber])
    }
    return r
  }
`

export const GET_MOMENT_METADATA = `
  import AllDay from 0xe4cf4bdc1751c65d
  import MetadataViews from 0x1d7e57aa55817448
  access(all)
  fun main(address: Address, id: UInt64): {String:String} {
    let acct = getAccount(address)
    let col = acct.capabilities.borrow<&{AllDay.MomentNFTCollectionPublic}>(/public/AllDayMomentNFTCollection)
      ?? panic("no collection")
    let nft = col.borrowMomentNFT(id: id) ?? panic("no nft")
    let editionData = AllDay.getEditionData(id: nft.editionID) ?? panic("no edition")
    let playData = AllDay.getPlayData(id: editionData.playID) ?? panic("no play")
    let setData = AllDay.getSetData(id: editionData.setID) ?? panic("no set")
    let seriesData = AllDay.getSeriesData(id: setData.seriesID) ?? panic("no series")
    return {
      "player": playData.metadata["playerFullName"] ?? "",
      "team": playData.metadata["teamName"] ?? "",
      "setName": setData.name,
      "series": seriesData.name,
      "serial": nft.serialNumber.toString(),
      "mint": editionData.maxMintSize?.toString() ?? editionData.numMinted.toString(),
      "playID": editionData.playID.toString(),
      "setID": editionData.setID.toString(),
      "tier": editionData.tier ?? "COMMON",
      "playCategory": playData.metadata["playType"] ?? "",
      "jerseyNumber": playData.metadata["playerJerseyNumber"] ?? "",
      "dateOfMoment": playData.metadata["dateOfMoment"] ?? ""
    }
  }
`
