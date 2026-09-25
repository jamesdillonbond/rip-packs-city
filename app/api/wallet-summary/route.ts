import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { isWalletAddress, lookupCachedTopShotUsername } from "@/lib/chains/flow/topshot-username-resolve"
import { isSupportedAddress, isValidAddressForChain } from "@/lib/address"
import { getCollectionByUuid, getCollectionUuid } from "@/lib/collections"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ⚠ `get_wallet_summary` takes a Flow ADDRESS. The Collection tab calls this
// route with whatever the reader typed — and the front door tells them to
// "paste a Top Shot username". Measured 2026-09-06 on the founder's own wallet
// (`jamesdillonbond`, 15,284 Moments): the RPC answered the username with
// {total_moments: 0, wallet_fmv: 0, …} under HTTP 200, and the page published
// WALLET FMV $0 · UNLOCKED $0 · 0 unlocked · LOCKED $0 · 0 locked in four tiles
// while the Moment table below them summed to $28,480. A read that resolved
// nothing rendered as a fact about the collection — the honesty canon's worst
// sub-class, a false claim about the reader's own account.
//
// Resolve a username through the same cached ladder /api/collection-moments
// uses; if nothing resolves, say so (404 with the unresolved shape) rather than
// forwarding the RPC's zeros.
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet || !wallet.trim()) return NextResponse.json({ error: "wallet required" }, { status: 400 })

  // ⛔ 2026-09-25 — a NAMED collection is never substituted. The route read
  // `collection_id` alone and defaulted to Top Shot, so `?collection=nfl-all-day`
  // (the slug the collection tab also sends) answered with the wallet's TOP SHOT
  // summary — identical bytes for two collections, every helper satisfied. The
  // live caller happens to pass both, which is why it never showed. An ABSENT
  // parameter may still default; a present-but-unknown one is refused.
  const rawCollectionId = req.nextUrl.searchParams.get("collection_id")
  const rawSlug = req.nextUrl.searchParams.get("collection")
  let collectionId: string
  if (rawCollectionId) {
    collectionId = rawCollectionId
  } else if (rawSlug) {
    const fromSlug = getCollectionUuid(rawSlug)
    if (!fromSlug) {
      return NextResponse.json(
        { error: "collection_not_supported", message: `No collection named ${rawSlug}.` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      )
    }
    collectionId = fromSlug
  } else {
    collectionId = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  }

  let address = wallet.trim()
  // ⛔ 2026-09-19 — `isWalletAddress` is the FLOW shape (`0x` + 16 hex) and it
  // lives in lib/chains/flow/, where being Flow-only is correct. What was wrong
  // was using it alone as the is-this-an-address test on a route that takes a
  // `collection_id` and serves every chain: a Candy MLB base58 wallet was sent
  // to the Top Shot username ladder and came back 404 — *"That Top Shot
  // username is not in our index yet — try the 0x wallet address."* — to a
  // reader who had pasted an address, about a collection Top Shot does not
  // index. `isSupportedAddress` recognises Cadence, EVM and base58, and the
  // username ladder now runs only for input that is not an address at all.
  if (!isWalletAddress(address) && !isSupportedAddress(address)) {
    let resolved: string | null = null
    try {
      resolved = await lookupCachedTopShotUsername(supabase as any, address)
    } catch (e) {
      return apiErrorResponse(e, "api/wallet-summary/resolve-username")
    }
    if (!resolved) {
      return NextResponse.json(
        { error: "unresolved", message: "That Top Shot username is not in our index yet — try the 0x wallet address." },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      )
    }
    address = resolved
  }

  // ⛔ 2026-09-25 — a Flow address against Candy MLB (or a Solana address
  // against Top Shot) came back 200 with a COMPLETE OBJECT OF ZEROS: "0
  // moments · $0" about a wallet that cannot hold that collection at all —
  // CLAUDE.md's chain-two footgun, verbatim ("a complete object of ZEROS
  // echoing the mangled wallet back"). The chain is the registry's, and an
  // address of the wrong chain is refused, never answered.
  const mismatch = chainMismatch(address, collectionId)
  if (mismatch) {
    return NextResponse.json(mismatch, { status: 400, headers: { "Cache-Control": "no-store" } })
  }

  const { data, error } = await boundedRead(supabase.rpc("get_wallet_summary", {
    p_wallet: address,
    p_collection_id: collectionId,
  }), "api/wallet-summary/get_wallet_summary")

  if (error) return apiErrorResponse(error, "api/wallet-summary")
  return NextResponse.json({ ...withoutLockStateForChainsThatHaveNone(data, collectionId), resolved_wallet: address })
}

/**
 * 2026-09-24 — Solana (Candy MLB) has NO locking concept, so "UNLOCKED FMV $0 ·
 * 0 unlocked · LOCKED FMV $0 · 0 locked" on a 338-moment Candy wallet was a
 * measured zero of a property the chain does not have. Mirror the Pinnacle
 * route: NULL the lock fields (the tiles render "n/a for this collection").
 * Decided by the registry's `dbChain`, never by a hardcoded collection.
 */
export function withoutLockStateForChainsThatHaveNone(data: unknown, collectionId: string): Record<string, unknown> {
  const base = (data && typeof data === "object" ? data : {}) as Record<string, unknown>
  const chain = getCollectionByUuid(collectionId)?.dbChain
  if (chain !== "solana") return base
  return {
    ...base,
    locked_fmv: null,
    locked_count: null,
    unlocked_fmv: null,
    unlocked_count: null,
    lock_unknown_fmv: null,
    lock_unknown_count: null,
  }
}

/**
 * `{ error: "chain_mismatch", message }` when `address` is a supported address
 * of a DIFFERENT chain than the collection's, else null. A username that the
 * ladder resolved is a Flow address by construction; an unknown collection id
 * (no registry row) refuses nothing — the RPC answers for it as before.
 */
export function chainMismatch(
  address: string,
  collectionId: string,
): { error: "chain_mismatch"; message: string } | null {
  const col = getCollectionByUuid(collectionId)
  if (!col?.dbChain) return null
  if (!isSupportedAddress(address)) return null
  if (isValidAddressForChain(address, col.dbChain)) return null
  const chainName = col.dbChain === "solana" ? "Solana" : col.dbChain === "ethereum" ? "Ethereum" : "Flow"
  return {
    error: "chain_mismatch",
    message: `${col.label} lives on ${chainName}; that wallet address is not a ${chainName} address, so it cannot hold ${col.label} moments.`,
  }
}
