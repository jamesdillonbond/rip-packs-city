import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"

// GET /api/owned-flow-ids?wallet=0x...
//
// Returns the raw on-chain Flow NFT IDs owned by the given Flow address.
// No metadata, no FMV, no enrichment — just the array of moment IDs as
// strings, suitable for client-side ownership checks against the sniper feed.
//
// Replicates the Cadence script used by /api/wallet-search → getOwnedMomentIds.

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""

  if (!wallet) {
    return NextResponse.json({ error: "wallet query param is required" }, { status: 400 })
  }
  if (!/^0x[a-fA-F0-9]{16}$/.test(wallet)) {
    return NextResponse.json({ error: "wallet must be a Flow 0x address" }, { status: 400 })
  }

  try {
    const cadence = `
      import TopShot from 0x0b2a3299cc857e29
      access(all)
      fun main(address: Address): [UInt64] {
        let acct = getAccount(address)
        let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        if col == nil { return [] }
        return col!.getIDs()
      }
    `
    const result = await fcl.query({
      cadence,
      args: (arg: any) => [arg(wallet, t.Address)],
    })

    const ids: string[] = Array.isArray(result) ? result.map((id: unknown) => String(id)) : []

    return NextResponse.json(
      { wallet, ids, count: ids.length },
      { headers: { "Cache-Control": "public, max-age=600" } }
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.log(`[owned-flow-ids] FCL failure for ${wallet}: ${message}`)
    return NextResponse.json({ error: "Failed to fetch owned IDs", detail: message }, { status: 500 })
  }
}
