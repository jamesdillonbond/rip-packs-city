import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { getCollection } from "@/lib/collections"

// GET /api/owned-flow-ids?wallet=0x...
//
// Returns the raw on-chain Flow NFT IDs owned by the given Flow address,
// plus a deduped list of unique edition keys (setID:playID) derived from
// each moment. The edition list is what the sniper page uses for ownership
// matching, since deal flowIds belong to other sellers and never collide
// with the buyer's own moment IDs.
//
// Replicates the Cadence script used by /api/wallet-search → getOwnedMomentIds
// and adds a second per-moment iteration script for edition keys.

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""

  if (!wallet) {
    return NextResponse.json({ error: "wallet query param is required" }, { status: 400 })
  }
  if (!/^0x[a-fA-F0-9]{16}$/.test(wallet)) {
    return NextResponse.json({ error: "wallet must be a Flow 0x address" }, { status: 400 })
  }

  // Collection-aware: look up contract details from registry (default: nba-top-shot)
  const collectionSlug = req.nextUrl.searchParams.get("collection") ?? "nba-top-shot"
  const col = getCollection(collectionSlug)
  const contractAddr = col?.contractAddress ?? "0x0b2a3299cc857e29"
  const contractName = col?.contractName ?? "TopShot"
  const collectionPath = col?.cadenceCollectionPath ?? "/public/MomentCollection"

  // TopShot uses a specific MomentCollectionPublic interface; other collections
  // use the generic NonFungibleToken.CollectionPublic interface.
  const isTopShot = contractName === "TopShot"

  const cadenceIds = isTopShot
    ? `
    import TopShot from ${contractAddr}
    access(all)
    fun main(address: Address): [UInt64] {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(${collectionPath})
      if col == nil { return [] }
      return col!.getIDs()
    }
  `
    : `
    import NonFungibleToken from 0x1d7e57aa55817448
    access(all)
    fun main(address: Address): [UInt64] {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(${collectionPath})
      if col == nil { return [] }
      return col!.getIDs()
    }
  `

  // Edition key extraction is TopShot-specific (setID:playID).
  // Other collections don't have the same structure, so we skip editions for them.
  const cadenceEditions = isTopShot
    ? `
    import TopShot from ${contractAddr}

    access(all) fun main(account: Address): {String: Bool} {
        let acct = getAccount(account)
        let ref = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(${collectionPath})
            ?? panic("Could not borrow collection")
        let ids = ref.getIDs()
        let editions: {String: Bool} = {}
        for id in ids {
            if let moment = ref.borrowMoment(id: id) {
                let key = moment.data.setID.toString().concat(":").concat(moment.data.playID.toString())
                editions[key] = true
            }
        }
        return editions
    }
  `
    : null

  // Wrap each script in its own promise. The editions script can fail under
  // execution-limit pressure for very large collections — we want to still
  // return ids in that case rather than 500 the whole endpoint.
  const idsPromise: Promise<string[]> = (async () => {
    try {
      const result = await fcl.query({
        cadence: cadenceIds,
        args: (arg: any) => [arg(wallet, t.Address)],
      })
      return Array.isArray(result) ? result.map((id: unknown) => String(id)) : []
    } catch (e) {
      console.log(`[owned-flow-ids] ids script failure for ${wallet}: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  })()

  const editionsPromise: Promise<string[]> = (async () => {
    if (!cadenceEditions) return [] // Non-TopShot collections don't support edition keys
    try {
      // 30s soft timeout for the per-moment iteration script.
      const result = await Promise.race([
        fcl.query({
          cadence: cadenceEditions,
          args: (arg: any) => [arg(wallet, t.Address)],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("editions script timeout (30s)")), 30000)
        ),
      ])
      if (result && typeof result === "object") {
        return Object.keys(result as Record<string, unknown>)
      }
      return []
    } catch (e) {
      console.warn(`[owned-flow-ids] editions script failed for ${wallet}: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  })()

  try {
    const [ids, editions] = await Promise.all([idsPromise, editionsPromise])
    return NextResponse.json(
      { wallet, ids, count: ids.length, editions },
      { headers: { "Cache-Control": "public, max-age=600" } }
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.log(`[owned-flow-ids] FCL failure for ${wallet}: ${message}`)
    return NextResponse.json({ error: "Failed to fetch owned IDs", detail: message }, { status: 500 })
  }
}
