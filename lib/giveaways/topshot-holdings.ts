// lib/giveaways/topshot-holdings.ts
//
// "Which of these Top Shot moments does this address hold right now, and is
// each one locked?" — one read that answers both questions a giveaway needs:
//   * at sealing: the admin still holds every pool moment, and none is locked
//     (Top Shot terms: a locked Moment cannot be gifted);
//   * at delivery: the recipient now holds the moment.
//
// The Cadence is BYTE-IDENTICAL to TOPSHOT_LOCK_SCRIPT in
// app/api/cron/lock-check-batch/route.ts, which has run in production against
// every tracked Top Shot wallet since 2026-09. It returns {id: isLocked} for
// every id the address holds and OMITS the ids it does not hold, so "held" is
// key presence. __tests__/giveaways-topshot-holdings.test.ts fails if the two
// copies drift.
//
// Never returns a partial answer as a complete one: any failed chunk throws.

export const FLOW_SCRIPTS_URL = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"

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

const CHUNK = 50
const TIMEOUT_MS = 20_000

export interface Holding {
  held: boolean
  /** null when not held (a lock state is only meaningful for a held moment). */
  locked: boolean | null
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Base64 of a UTF-8 string, in Node and the browser alike. */
function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64")
}

/**
 * Read holdings for `ids` at `address`. Throws on ANY failed chunk or
 * undecodable response — a giveaway must never mark a moment delivered, or a
 * pool sealable, from a read that did not complete.
 */
export async function readTopShotHoldings(
  address: string,
  ids: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, Holding>> {
  if (!/^0x[0-9a-f]{16}$/.test(address)) throw new Error(`not a Flow address: ${address}`)
  const out: Record<string, Holding> = {}
  for (const id of ids) {
    if (!/^[0-9]{1,20}$/.test(id)) throw new Error(`not a moment id: ${id}`)
    out[id] = { held: false, locked: null }
  }
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const body = {
      script: b64(TOPSHOT_LOCK_SCRIPT),
      arguments: [
        b64(JSON.stringify({ type: "Address", value: address })),
        b64(JSON.stringify({ type: "Array", value: chunk.map((id) => ({ type: "UInt64", value: id })) })),
      ],
    }
    const res = await fetchImpl(FLOW_SCRIPTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Flow script HTTP ${res.status}`)
    const raw = (await res.text()).trim().replace(/^"|"$/g, "")
    let decoded: { type?: string; value?: Array<{ key: { value: string }; value: { value: boolean } }> }
    try {
      decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
    } catch {
      throw new Error("Flow script returned an undecodable body")
    }
    if (decoded?.type !== "Dictionary" || !Array.isArray(decoded.value)) {
      throw new Error("Flow script returned an unexpected shape")
    }
    for (const entry of decoded.value) {
      const id = String(entry.key.value)
      if (id in out) out[id] = { held: true, locked: entry.value.value === true }
    }
  }
  return out
}
