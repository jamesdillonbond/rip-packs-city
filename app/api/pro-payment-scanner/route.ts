// app/api/pro-payment-scanner/route.ts
// Scans the RPC treasury wallet for newly received Top Shot moments.
// New moment IDs are logged to pro_payment_log with sender_wallet=null;
// Trevor completes Pro activation manually via /api/pro-activate once the
// sender is attributed (sender resolution from chain events ships in v2).
//
// Auth: Bearer INGEST_SECRET_TOKEN

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TREASURY_WALLET = process.env.RPC_TREASURY_WALLET || "0xbd94cade097e50ac"
const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts"

const TOPSHOT_IDS_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(addr: Address): [UInt64] {
  let acct = getAccount(addr)
  let cap = acct.capabilities
    .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if cap == nil { return [] }
  return cap!.getIDs()
}
`

function encodeBase64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64")
}

async function fetchTreasuryMomentIds(wallet: string): Promise<string[]> {
  const body = {
    script: encodeBase64(TOPSHOT_IDS_SCRIPT),
    arguments: [
      encodeBase64(JSON.stringify({ type: "Address", value: wallet })),
    ],
  }
  const res = await fetch(FLOW_REST, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    throw new Error(`Flow script failed: ${res.status} ${await res.text()}`)
  }
  const raw = await res.text()
  // Flow returns a base64-encoded JSON-CDC payload.
  const decoded = JSON.parse(Buffer.from(raw.replace(/^"|"$/g, ""), "base64").toString("utf8"))
  // decoded shape: { type: "Array", value: [{ type: "UInt64", value: "123" }, ...] }
  const arr: Array<{ value: string }> = decoded?.value ?? []
  return arr.map(v => String(v.value))
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const onChainIds = await fetchTreasuryMomentIds(TREASURY_WALLET)

    // Known moment IDs we've already seen at the treasury
    const { data: known } = await (supabaseAdmin as any)
      .from("pro_payment_log")
      .select("moment_nft_id")
    const knownSet = new Set<string>((known ?? []).map((r: { moment_nft_id: string }) => r.moment_nft_id))

    const newIds = onChainIds.filter(id => !knownSet.has(id))

    let logged = 0
    for (const nftId of newIds) {
      const { error } = await (supabaseAdmin as any)
        .from("pro_payment_log")
        .insert({
          sender_wallet: null,
          moment_nft_id: nftId,
          pro_activated: false,
        })
      if (!error) logged += 1
    }

    return NextResponse.json({
      scanned: true,
      treasury: TREASURY_WALLET,
      total_on_chain: onChainIds.length,
      new_moments: newIds.length,
      logged,
      pro_activated: 0,
      note: "Sender attribution + auto-activation lands in scanner v2; complete activations via /api/pro-activate.",
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
