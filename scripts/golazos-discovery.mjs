#!/usr/bin/env node

/**
 * La Liga Golazos on-chain discovery — probes Flow contract, MetadataViews, GQL, and Flowty.
 *
 * Usage: node scripts/golazos-discovery.mjs
 */

import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"

fcl.config()
  .put("accessNode.api", "https://rest-mainnet.onflow.org")
  .put("flow.network", "mainnet")

const WALLET = "0xbd94cade097e50ac"
const CONTRACT = "0x87ca73a41bb50ad5"

async function script1_getOwnedIds() {
  console.log("\n══ Script 1: Get owned Golazos NFT IDs ══")
  const cadence = `
    import Golazos from ${CONTRACT}
    import NonFungibleToken from 0x1d7e57aa55817448

    access(all) fun main(addr: Address): [UInt64] {
      let acct = getAccount(addr)
      let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(Golazos.CollectionPublicPath)
      if ref == nil { return [] }
      return ref!.getIDs()
    }
  `
  try {
    const ids = await fcl.query({ cadence, args: (arg, t2) => [arg(WALLET, t2.Address)] })
    console.log(`Found ${ids.length} Golazos NFTs`)
    console.log("First 10 IDs:", ids.slice(0, 10))
    return ids
  } catch (err) {
    console.log("Cadence query failed:", err.message)
    // Try alternate path
    try {
      const cadence2 = `
        import NonFungibleToken from 0x1d7e57aa55817448

        access(all) fun main(addr: Address): [UInt64] {
          let acct = getAccount(addr)
          let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/GolazosNFTCollection)
          if ref == nil { return [] }
          return ref!.getIDs()
        }
      `
      const ids = await fcl.query({ cadence: cadence2, args: (arg, t2) => [arg(WALLET, t2.Address)] })
      console.log(`Found ${ids.length} Golazos NFTs (alt path)`)
      return ids
    } catch (err2) {
      console.log("Alt path also failed:", err2.message)
      return []
    }
  }
}

async function script2_getMetadata(nftId) {
  console.log(`\n══ Script 2: Get metadata for NFT #${nftId} ══`)
  const cadence = `
    import Golazos from ${CONTRACT}
    import NonFungibleToken from 0x1d7e57aa55817448
    import MetadataViews from 0x1d7e57aa55817448

    access(all) fun main(addr: Address, id: UInt64): {String: AnyStruct} {
      let acct = getAccount(addr)
      let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(Golazos.CollectionPublicPath)
        ?? panic("No collection")
      let nft = ref.borrowNFT(id)
      let result: {String: AnyStruct} = {}

      if let display = nft.resolveView(Type<MetadataViews.Display>()) as? MetadataViews.Display {
        result["display_name"] = display.name
        result["display_description"] = display.description
      }
      if let serial = nft.resolveView(Type<MetadataViews.Serial>()) as? MetadataViews.Serial {
        result["serial"] = serial.number
      }
      if let editions = nft.resolveView(Type<MetadataViews.Editions>()) as? MetadataViews.Editions {
        if editions.infoList.length > 0 {
          let ed = editions.infoList[0]
          result["edition_name"] = ed.name
          result["edition_number"] = ed.number
          result["edition_max"] = ed.max
        }
      }
      if let traits = nft.resolveView(Type<MetadataViews.Traits>()) as? MetadataViews.Traits {
        let traitMap: {String: AnyStruct} = {}
        for trait in traits.traits {
          traitMap[trait.name] = trait.value
        }
        result["traits"] = traitMap
      }
      return result
    }
  `
  try {
    const meta = await fcl.query({
      cadence,
      args: (arg, t2) => [arg(WALLET, t2.Address), arg(String(nftId), t2.UInt64)],
    })
    console.log(JSON.stringify(meta, null, 2))
    return meta
  } catch (err) {
    console.log("Metadata fetch failed:", err.message)
    return null
  }
}

async function script3_probeGql() {
  console.log("\n══ Script 3: Probe La Liga Golazos GQL ══")
  try {
    const res = await fetch("https://public-api.laligagolazos.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "sports-collectible-tool/0.1" },
      body: JSON.stringify({
        query: `{ __schema { queryType { name } types { name fields { name } } } }`,
      }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      console.log(`GQL response: HTTP ${res.status}`)
      const text = await res.text()
      console.log(text.slice(0, 500))
      return
    }
    const json = await res.json()
    const types = json?.data?.__schema?.types ?? []
    const queryFields = types.find(t2 => t2.name === "Query")?.fields?.map(f => f.name) ?? []
    console.log("Query root fields:", queryFields.slice(0, 30))
    console.log(`Total types: ${types.length}`)
    const interesting = types.filter(t2 => !t2.name.startsWith("__") && t2.fields?.length > 0).map(t2 => t2.name)
    console.log("Notable types:", interesting.slice(0, 30))
  } catch (err) {
    console.log("GQL probe failed:", err.message)
  }
}

async function script4_probeFlowty() {
  console.log("\n══ Script 4: Probe Flowty for Golazos ══")
  try {
    const res = await fetch("https://api2.flowty.io/collection/0x87ca73a41bb50ad5/Golazos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.flowty.io",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({
        filters: {},
        sort: { field: "blockTimestamp", direction: "desc" },
        searchQuery: "",
        limit: 5,
        cursor: "",
      }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      console.log(`Flowty response: HTTP ${res.status}`)
      return
    }
    const json = await res.json()
    const items = json?.items ?? json?.data ?? []
    console.log(`Flowty returned ${items.length} listings`)
    if (items.length > 0) {
      console.log("First listing (full):", JSON.stringify(items[0], null, 2))
    }
  } catch (err) {
    console.log("Flowty probe failed:", err.message)
  }
}

async function main() {
  console.log("═══════════════════════════════════════════")
  console.log("  LA LIGA GOLAZOS ON-CHAIN DISCOVERY")
  console.log("  Wallet:", WALLET)
  console.log("  Contract:", CONTRACT)
  console.log("═══════════════════════════════════════════")

  const ids = await script1_getOwnedIds()
  if (ids.length > 0) {
    await script2_getMetadata(ids[0])
  } else {
    console.log("\nSkipping metadata — no NFTs found")
  }
  await script3_probeGql()
  await script4_probeFlowty()

  console.log("\n═══ DISCOVERY COMPLETE ═══")
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
