#!/usr/bin/env node

/**
 * UFC Strike on-chain discovery — probes Flow contract and Flowty.
 * Note: UFC Strike migrated to Aptos mid-2025; Flow contract may have limited/no NFTs.
 *
 * Usage: node scripts/ufc-strike-discovery.mjs
 */

import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"

fcl.config()
  .put("accessNode.api", "https://rest-mainnet.onflow.org")
  .put("flow.network", "mainnet")

const WALLET = "0xbd94cade097e50ac"
const CONTRACT = "0x329feb3ab062d289"

async function script1_getOwnedIds() {
  console.log("\n══ Script 1: Get owned UFC Strike NFT IDs ══")
  // UFC_NFT uses a different collection path pattern
  const paths = [
    "/public/UFCStrikeNFTCollection",
    "/public/UFC_NFTCollection",
    "/public/UFCCollection",
  ]

  for (const path of paths) {
    const cadence = `
      import NonFungibleToken from 0x1d7e57aa55817448

      access(all) fun main(addr: Address): [UInt64] {
        let acct = getAccount(addr)
        let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(${path})
        if ref == nil { return [] }
        return ref!.getIDs()
      }
    `
    try {
      const ids = await fcl.query({ cadence, args: (arg, t2) => [arg(WALLET, t2.Address)] })
      console.log(`Path ${path}: Found ${ids.length} UFC NFTs`)
      if (ids.length > 0) {
        console.log("First 10 IDs:", ids.slice(0, 10))
        return ids
      }
    } catch (err) {
      console.log(`Path ${path} failed: ${err.message}`)
    }
  }

  // Also try with contract import
  try {
    const cadence = `
      import UFC_NFT from ${CONTRACT}
      import NonFungibleToken from 0x1d7e57aa55817448

      access(all) fun main(addr: Address): [UInt64] {
        let acct = getAccount(addr)
        let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(UFC_NFT.CollectionPublicPath)
        if ref == nil { return [] }
        return ref!.getIDs()
      }
    `
    const ids = await fcl.query({ cadence, args: (arg, t2) => [arg(WALLET, t2.Address)] })
    console.log(`Contract path: Found ${ids.length} UFC NFTs`)
    if (ids.length > 0) console.log("First 10 IDs:", ids.slice(0, 10))
    return ids
  } catch (err) {
    console.log("Contract path failed:", err.message)
  }

  console.log("No UFC Strike NFTs found (expected — migrated to Aptos)")
  return []
}

async function script2_getMetadata(nftId) {
  console.log(`\n══ Script 2: Get metadata for NFT #${nftId} ══`)
  const cadence = `
    import UFC_NFT from ${CONTRACT}
    import NonFungibleToken from 0x1d7e57aa55817448
    import MetadataViews from 0x1d7e57aa55817448

    access(all) fun main(addr: Address, id: UInt64): {String: AnyStruct} {
      let acct = getAccount(addr)
      let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(UFC_NFT.CollectionPublicPath)
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

async function script3_probeFlowty() {
  console.log("\n══ Script 3: Probe Flowty for UFC Strike ══")
  try {
    const res = await fetch("https://api2.flowty.io/collection/0x329feb3ab062d289/UFC_NFT", {
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
  console.log("  UFC STRIKE ON-CHAIN DISCOVERY")
  console.log("  Wallet:", WALLET)
  console.log("  Contract:", CONTRACT)
  console.log("  Note: UFC Strike migrated to Aptos mid-2025")
  console.log("═══════════════════════════════════════════")

  const ids = await script1_getOwnedIds()
  if (ids.length > 0) {
    await script2_getMetadata(ids[0])
  } else {
    console.log("\nSkipping metadata — no NFTs found")
  }
  // No GQL endpoint for UFC Strike
  console.log("\n══ Script 3 (GQL): Skipped — no known public GQL for UFC Strike ══")
  await script3_probeFlowty()

  console.log("\n═══ DISCOVERY COMPLETE ═══")
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
