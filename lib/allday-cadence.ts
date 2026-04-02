// Cadence scripts for NFL All Day (AllDay contract on Flow mainnet)
// Contract address: 0xe4cf4bdc1751c65d

export const GET_OWNED_MOMENT_IDS = `
  import AllDay from 0xe4cf4bdc1751c65d
  access(all)
  fun main(address: Address): [UInt64] {
    let acct = getAccount(address)
    let col = acct.capabilities.borrow<&{AllDay.MomentNFTCollectionPublic}>(/public/AllDayMomentNFTCollection)
    if col == nil { return [] }
    return col!.getIDs()
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
