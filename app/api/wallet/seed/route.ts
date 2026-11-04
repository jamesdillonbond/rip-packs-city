import { NextRequest, NextResponse } from "next/server"
import { normalizeAddress, isCadenceAddress, detectAddressChain } from "@/lib/address"
import { tokenMatches } from "@/lib/auth/bearer-secret"

export const maxDuration = 60

// POST /api/wallet/seed — warm wallet_moments_cache for a just-saved wallet.
//
// ⛔ THIS ROUTE NO LONGER WRITES wallet_moments_cache ITSELF (2026-11-02). It
// hands the wallet to /api/wallet-backfill-multicollection — the walker every
// other wallet path uses — and reports that it did. The writer it replaced had
// three defects, each one a false claim about a collector's holdings:
//
//   1. It enriched by looking up `editions.external_id` (a `set:play` key, or
//      an All Day edition number) with the MOMENT's NFT id. That matches
//      nothing — so every moment went out with `fmv_usd: null` and no
//      edition_key — and on All Day a low NFT id could match an unrelated
//      edition NUMBER. Its deep test enshrined the bug with a mock edition
//      whose external_id was the moment id ("m1").
//   2. It wrote through `upsert_wallet_moments`, whose ON CONFLICT sets
//      `fmv_usd = EXCLUDED.fmv_usd`: every already-cached moment of the
//      wallet had its FMV NULLED on each save (and the portfolio snapshot
//      counts only `fmv_usd > 0`).
//   3. `upsert_wallet_moments` is a FULL-SET writer — it deletes the wallet's
//      rows it was not given. All Day moments in Dapper custody (locked) are
//      structurally absent from `getIDs()`, so a save deleted them; the walker
//      unions the studio custody read and deletes only through the guarded
//      `deleteUnseenWmcRows`.
//
// The walker keys editions from on-chain set/play, prices from fmv_current,
// stamps clean walks, and is what the scheduled saved-wallet refresh already
// runs — so delegating loses nothing the old writer actually delivered.
//
// HONESTY: `dispatch` says what happened to the hand-off, never what the walk
// found. `sent` = the walker accepted it; `sent_unconfirmed` = our bounded wait
// expired while the walker kept running (it is fire-and-forget on its side);
// `failed` = the request did not go out, and `ok` is false.
//
// Caller: /api/wallet/save (after()), which has no in-repo caller of its own
// today. Auth: x-ingest-token = INGEST_SECRET_TOKEN.

const DISPATCH_TIMEOUT_MS = 45_000

export async function POST(req: NextRequest) {
  const token = req.headers.get("x-ingest-token") ?? ""
  const expected = process.env.INGEST_SECRET_TOKEN ?? ""
  if (!expected || !tokenMatches(token, "INGEST_SECRET_TOKEN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { walletAddress?: unknown; ownerKey?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { walletAddress, ownerKey } = body
  if (typeof walletAddress !== "string" || !walletAddress) {
    return NextResponse.json({ error: "walletAddress required" }, { status: 400 })
  }

  const wallet = normalizeAddress(walletAddress)

  // ⛔ CADENCE-ONLY, and says so rather than answering (2026-09-20). The walker
  // reads Flow collections; a Solana/EVM wallet would come back as rows of
  // zeros that read as a measured empty wallet.
  if (!isCadenceAddress(wallet)) {
    return NextResponse.json(
      {
        ok: false,
        error: "unsupported_chain_for_seeder",
        detail:
          "This seeder reads Flow (Cadence) collections only. The address is not a Flow address, so no holdings were read — this is not a statement that the wallet is empty.",
        walletAddress: wallet,
        chain: detectAddressChain(wallet),
      },
      { status: 400 },
    )
  }

  const owner = typeof ownerKey === "string" ? ownerKey : null
  let origin = "https://www.rippackscity.com"
  try {
    if (req.url) origin = new URL(req.url).origin
  } catch {
    /* keep the production origin */
  }

  let dispatch: "sent" | "sent_unconfirmed" | "failed" = "failed"
  let dispatchError: string | null = null
  let walkerStatus: number | null = null
  try {
    const res = await fetch(origin + "/api/wallet-backfill-multicollection", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${expected}` },
      body: JSON.stringify({ wallet, skip_cached: true }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    walkerStatus = res.status
    if (res.ok) {
      dispatch = "sent"
    } else {
      dispatchError = `walker HTTP ${res.status}`
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : ""
    if (name === "TimeoutError" || name === "AbortError") {
      dispatch = "sent_unconfirmed"
    } else {
      dispatchError = err instanceof Error ? err.message : String(err)
    }
  }

  const ok = dispatch !== "failed"
  return NextResponse.json(
    {
      ok,
      walletAddress: wallet,
      ownerKey: owner,
      dispatch,
      walker_status: walkerStatus,
      ...(dispatchError ? { error: dispatchError } : {}),
    },
    { status: ok ? 202 : 502 },
  )
}
