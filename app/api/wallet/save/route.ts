import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function POST(request: NextRequest) {
  let body: {
    ownerKey?: unknown
    walletAddress?: unknown
    topshotUsername?: unknown
    displayName?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { ownerKey, walletAddress, topshotUsername, displayName } = body

  if (typeof ownerKey !== "string" || !ownerKey || typeof walletAddress !== "string" || !walletAddress) {
    return NextResponse.json(
      { error: "ownerKey and walletAddress are required strings" },
      { status: 400 }
    )
  }

  const normalizedWallet = walletAddress.trim().toLowerCase()

  const { data, error } = await (supabaseAdmin as any).rpc("save_user_wallet", {
    p_owner_key: ownerKey,
    p_wallet_address: normalizedWallet,
    p_topshot_username: typeof topshotUsername === "string" ? topshotUsername : null,
    p_display_name: typeof displayName === "string" ? displayName : null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  after(async () => {
    try {
      await fetch(new URL("/api/wallet/seed", request.url).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ingest-token": process.env.INGEST_SECRET_TOKEN ?? "",
        },
        body: JSON.stringify({ walletAddress: normalizedWallet, ownerKey }),
      })
    } catch (err) {
      console.error("[wallet/save] background seed failed:", err instanceof Error ? err.message : String(err))
    }
  })

  return NextResponse.json(data)
}
