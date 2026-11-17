// lib/chains/flow/wmc-empty-proof.ts
//
// POSITIVE proof that a wallet holds NOTHING in a collection — the one fact the
// walkers' getIDs() scripts cannot state.
//
// ── WHY (measured 2026-10-14) ────────────────────────────────────────────────
// Every walker reads getIDs() through a script that returns [] when the public
// capability is nil, so an empty list means EITHER "the collection exists and is
// empty" OR "nothing readable is there". deleteUnseenWmcRows therefore refuses an
// empty observed set and leaves genuinely emptied wallets to prune_stale_wmc() —
// which EXCLUDES active seeded wallets. Each half assumed the other covered the
// case, so a TRACKED wallet that sold out a collection kept its rows forever:
// 0x8e655887a360cc3f (137 Top Shot rows) and 0x4ab8b294112f182c (54) both read
// `has_collection, 0 ids` on chain while their profiles still listed the moments;
// 0x6d1f8c18412c6abc's two UFC rows (last seen 2026-05-13) also kept the UFC
// enrichment drain failing on them every 15 minutes.
//
// This script answers the two cases apart: -1 = no readable collection (NOT
// proof — an unpublished or unlinked capability, a migration, a contract change),
// n >= 0 = the collection exists and holds n ids. Only `proven_empty` (exists, 0)
// licenses retiring a wallet's cached rows; anything else, including a failed
// read, leaves them alone.

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"

// One script per collection whose custody is entirely on chain in the holder's
// own collection. Top Shot's locked moments stay in the collection (TopShotLocking
// does not move them), so getIDs() sees them. ⛔ All Day is deliberately ABSENT:
// its locked moments are Dapper-custodied and invisible to getIDs(), so an empty
// collection does not prove an empty holding (wallet-backfill-helpers' studio
// walk is the authority there).
export const EMPTY_PROOF_SCRIPTS: Readonly<Record<string, string>> = {
  nba_top_shot: `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address): Int {
  let col = getAccount(address).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return -1 }
  return col!.getIDs().length
}`.trim(),
  ufc_strike: `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): Int {
  let col = getAccount(address).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/UFC_NFTCollection)
  if col == nil { return -1 }
  return col!.getIDs().length
}`.trim(),
}

// COUNT-only scripts: the on-chain getIDs() length of a collection whose holdings
// ALSO live off chain, so an empty result is never proof of an empty holding and
// the collection must not appear in EMPTY_PROOF_SCRIPTS. All Day's locked moments
// are Dapper-custodied (the studio walk is their authority); its on-chain count is
// still a valid independent check of the on-chain HALF of a walk (2026-10-14:
// 0x6d1f8c18412c6abc read 0 on chain with 2 studio holdings and 147 rows cached).
export const COUNT_ONLY_SCRIPTS: Readonly<Record<string, string>> = {
  nfl_all_day: `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): Int {
  let col = getAccount(address).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/AllDayNFTCollection)
  if col == nil { return -1 }
  return col!.getIDs().length
}`.trim(),
}

export type EmptyProof = "proven_empty" | "not_empty" | "no_collection" | "read_failed" | "no_proof_script"

/** Parse the JSON-Cadence `Int` a proof script returns. Anything else is a failed read. */
export function classifyProofResult(decoded: unknown): EmptyProof {
  const v = decoded as { type?: unknown; value?: unknown } | null
  if (!v || v.type !== "Int" || typeof v.value !== "string" || !/^-?\d+$/.test(v.value)) return "read_failed"
  const n = Number(v.value)
  if (n < 0) return "no_collection"
  return n === 0 ? "proven_empty" : "not_empty"
}

/**
 * The collection's id count read on its own (independent of any walk), or null
 * when there is no readable collection, no script for the collection, or the read
 * failed. Used to CONFIRM a walk was complete before deleting past the >90 % cap
 * (deleteUnseenWmcRows `confirmCompleteness`), measured 2026-10-14: six tracked
 * Top Shot wallets were cap-blocked with 1,199/937/851/720/115 rows cached against
 * 74/12/18/1/8 held — and this read returned exactly the walks' counts.
 */
export async function readCollectionCount(wallet: string, collectionSlug: string): Promise<number | null> {
  const proof = await readProof(wallet, collectionSlug, EMPTY_PROOF_SCRIPTS[collectionSlug] ?? COUNT_ONLY_SCRIPTS[collectionSlug])
  return typeof proof === "number" ? proof : null
}

export async function proveCollectionEmpty(wallet: string, collectionSlug: string): Promise<EmptyProof> {
  // Never COUNT_ONLY_SCRIPTS here: an empty on-chain count does not prove an empty holding there.
  const proof = await readProof(wallet, collectionSlug, EMPTY_PROOF_SCRIPTS[collectionSlug])
  if (typeof proof === "number") return proof === 0 ? "proven_empty" : "not_empty"
  return proof
}

async function readProof(
  wallet: string,
  _collectionSlug: string,
  script: string | undefined,
): Promise<number | "no_collection" | "read_failed" | "no_proof_script"> {
  if (!script) return "no_proof_script"
  try {
    const res = await fetch(FLOW_REST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script: btoa(script),
        arguments: [btoa(JSON.stringify({ type: "Address", value: wallet }))],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return "read_failed"
    const raw = (await res.text()).trim().replace(/^"|"$/g, "")
    const decoded = JSON.parse(atob(raw))
    const cls = classifyProofResult(decoded)
    if (cls === "read_failed" || cls === "no_collection") return cls
    return Number((decoded as { value: string }).value)
  } catch {
    return "read_failed"
  }
}
