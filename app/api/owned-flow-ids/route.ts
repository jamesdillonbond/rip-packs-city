import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/chains/flow/flow"
import * as t from "@onflow/types"
import { getCollection } from "@/lib/collections"
import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"

/** Where the `editions` list came from. "chain" is the live per-moment script;
 *  "cache" is the wallet's last synced snapshot (wallet_moments_cache), used
 *  when the script dies — Flow's 100k computation limit kills it on a large
 *  collection ("[Error Code: 1110]", 4× in 90 min on a 15,527-moment wallet,
 *  2026-09-24); "none" means both failed and the list is NOT an answer. */
export type EditionsSource = "chain" | "cache" | "none"

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
  // ⛔ A NAMED collection with no Flow contract (unknown, or a non-Flow chain such
  // as candy-mlb / panini-blockchain) is refused (2026-09-26). The `??` defaults
  // below used to turn it into the Top Shot walk, so the caller got the wallet's
  // Top Shot moments under the collection it asked for. An ABSENT param still
  // defaults to Top Shot — the in-app callers send none.
  if (!col?.contractName || !col.contractAddress) {
    return NextResponse.json(
      { error: `collection '${collectionSlug}' has no Flow contract to walk` },
      { status: 400 },
    )
  }
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

  const editionsPromise: Promise<{ keys: string[]; source: EditionsSource }> = (async () => {
    if (!cadenceEditions) return { keys: [], source: "chain" } // Non-TopShot collections don't support edition keys
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
        return { keys: Object.keys(result as Record<string, unknown>), source: "chain" as const }
      }
      return { keys: [], source: "chain" as const }
    } catch (e) {
      console.warn(`[owned-flow-ids] editions script failed for ${wallet}: ${e instanceof Error ? e.message : String(e)}`)
      // ⚠ This used to `return []` — a failed read published as "owns no
      // editions" under max-age=600, and the sniper cached it in localStorage
      // for 10 minutes. Fall back to the wallet's last synced snapshot (same
      // subject, different depth); if that fails too, say so.
      return cachedEditionKeys(wallet, col?.supabaseCollectionId ?? null)
    }
  })()

  try {
    const [ids, editionsRes] = await Promise.all([idsPromise, editionsPromise])
    const editions = editionsRes.keys
    const editionsComplete = editionsRes.source !== "none"
    return NextResponse.json(
      { wallet, ids, count: ids.length, editions, editions_source: editionsRes.source, editions_complete: editionsComplete },
      {
        headers: {
          // A read that could not answer must not be pinned at the CDN.
          "Cache-Control": editionsComplete ? "public, max-age=600" : "no-store",
        },
      }
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.log(`[owned-flow-ids] FCL failure for ${wallet}: ${message}`)
    return NextResponse.json({ error: "Failed to fetch owned IDs" }, { status: 500 })
  }
}

/** The wallet's owned edition keys from its last synced snapshot, via
 *  get_wallet_owned_edition_keys (distinct set:play, subedition suffix
 *  stripped). `source: "none"` when the read fails — never an empty list
 *  dressed as an answer. */
export async function cachedEditionKeys(
  wallet: string,
  collectionId: string | null,
): Promise<{ keys: string[]; source: EditionsSource }> {
  if (!collectionId) return { keys: [], source: "none" }
  try {
    // Bounded like every other read-only route: a hung snapshot read must not
    // hold the sniper's first paint; a timeout is `source: "none"`, never [].
    const { data, error } = await boundedRead(
      supabaseAdmin.rpc("get_wallet_owned_edition_keys", {
        p_wallet: wallet,
        p_collection_id: collectionId,
      }),
      "api/owned-flow-ids/get_wallet_owned_edition_keys",
    )
    if (error) {
      console.warn(`[owned-flow-ids] cache fallback failed for ${wallet}: ${error.message}`)
      return { keys: [], source: "none" }
    }
    return { keys: Array.isArray(data) ? data.map((k: unknown) => String(k)) : [], source: "cache" }
  } catch (e) {
    console.warn(`[owned-flow-ids] cache fallback threw for ${wallet}: ${e instanceof Error ? e.message : String(e)}`)
    return { keys: [], source: "none" }
  }
}
