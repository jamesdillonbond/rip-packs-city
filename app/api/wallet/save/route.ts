import { NextRequest, NextResponse, after } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin } from "@/lib/supabase"
import { requireOwnedKey } from "@/lib/auth/owner-key-guard"
import { normalizeAddress } from "@/lib/address"

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

  // SECURITY: service-role write (save_user_wallet) whose target profile came
  // from the body `ownerKey` rather than the session — any caller could
  // re-point another user's saved wallet / TopShot username / display name, and
  // then trigger a seed run against it. The write target must be proven to
  // belong to the caller.
  const gate = await requireOwnedKey(ownerKey)
  if (gate instanceof Response) return gate

  // ⚠ normalizeAddress, NOT `.toLowerCase()`. This value is WRITTEN to
  // saved_wallets and then handed to /api/wallet/seed, so folding a base58
  // address here destroys the wallet at the moment of saving it — and every
  // read afterwards would report an honest-looking zero about a portfolio that
  // exists. `/api/profile/saved-wallets` was fixed 2026-09-19; this route is
  // the same write with no in-repo caller, which is exactly why it went unfixed.
  // Hex is byte-identical: normalizeAddress folds it just as this line did.
  const normalizedWallet = normalizeAddress(walletAddress)

  const { data, error } = await (supabaseAdmin as any).rpc("save_user_wallet", {
    p_owner_key: ownerKey,
    p_wallet_address: normalizedWallet,
    p_topshot_username: typeof topshotUsername === "string" ? topshotUsername : null,
    p_display_name: typeof displayName === "string" ? displayName : null,
  })

  if (error) {
    return apiErrorResponse(error, "api/wallet/save");
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
