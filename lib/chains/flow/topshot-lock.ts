// lib/chains/flow/topshot-lock.ts
//
// On-chain Top Shot lock reader: TopShotLocking.isLocked for a wallet's moments,
// read straight from Flow mainnet (sealed block) — the same script
// app/api/cron/lock-check-batch uses.
//
// ⛔ 2026-11-16 (Trevor: "How come it shows LOCK ?"): the ON-VIEW lock refresh in
// /api/cache-refresh read lock state from Top Shot's public GraphQL API
// (getMintedMoment.isLocked). That host is decommissioned, so every lookup
// missed, nothing was stamped, and a moment that had just arrived in a wallet
// stayed "Lock ?" until the 7-day background sweep reached it. Lock state lives
// on chain, so read it there.
//
// RESULT CONTRACT — three outcomes per id, never two:
//   · id present with true/false → a real reading at a sealed block
//   · id ABSENT from the map      → no reading (not in that wallet's collection);
//                                   the caller must leave the row unstamped
//   · throw                       → the read failed; the caller must stamp nothing

export const FLOW_SCRIPTS_SEALED = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"

export const TOPSHOT_LOCK_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
import TopShotLocking from 0x0b2a3299cc857e29

access(all) fun main(addr: Address, ids: [UInt64]): {UInt64: Bool} {
    let acct = getAccount(addr)
    let capRef = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
    if capRef == nil {
        return {}
    }
    let cap = capRef!
    let out: {UInt64: Bool} = {}
    for id in ids {
        let nftRef = cap.borrowMoment(id: id)
        if nftRef == nil {
            continue
        }
        out[id] = TopShotLocking.isLocked(nftRef: nftRef!)
    }
    return out
}
`.trim()

/** Ids per script call — the batch lane's measured-safe chunk size. */
export const TOPSHOT_LOCK_CHUNK = 50

/**
 * Read TopShotLocking.isLocked for up to TOPSHOT_LOCK_CHUNK ids held by `wallet`.
 * Throws on any HTTP / decode failure. Ids missing from the result were not
 * found in the wallet's collection.
 */
export async function readTopShotLocks(
  wallet: string,
  ids: string[],
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Map<string, boolean>> {
  if (ids.length > TOPSHOT_LOCK_CHUNK) throw new Error(`readTopShotLocks: ${ids.length} ids exceeds chunk of ${TOPSHOT_LOCK_CHUNK}`)
  const out = new Map<string, boolean>()
  if (ids.length === 0) return out
  const f = opts.fetchImpl ?? fetch
  const body = {
    script: btoa(TOPSHOT_LOCK_SCRIPT),
    arguments: [
      btoa(JSON.stringify({ type: "Address", value: wallet })),
      btoa(JSON.stringify({ type: "Array", value: ids.map(id => ({ type: "UInt64", value: String(id) })) })),
    ],
  }
  const res = await f(FLOW_SCRIPTS_SEALED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  })
  if (!res.ok) throw new Error(`Flow ${res.status}: ${(await res.text()).slice(0, 2000)}`)
  const raw = await res.text()
  const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
  if (decoded?.type !== "Dictionary" || !Array.isArray(decoded.value)) {
    throw new Error("readTopShotLocks: unexpected result shape " + String(decoded?.type))
  }
  for (const entry of decoded.value as Array<{ key: { value: string }; value: { value: unknown } }>) {
    if (typeof entry?.value?.value !== "boolean") continue
    out.set(String(entry.key.value), entry.value.value)
  }
  return out
}
