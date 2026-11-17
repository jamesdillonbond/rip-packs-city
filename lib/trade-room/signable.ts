// lib/trade-room/signable.ts
//
// What a relayed trade-room transaction does, read from its OWN JSON-CDC arguments — never
// from anything the initiator typed — for the co-signer to read before signing. Two texts
// are signable in a trade room: the original Top Shot swap (lib/swap-test/view.ts decodes
// it) and the multi-collection swap (2026-11-02, lib/trade-room/multi-swap-cadence.ts:
// sourceA, ctlsA, idsA [[…] per collection], sourceB, ctlsB, idsB). Anything else, or
// arguments that don't decode, is reported as not signable. Client-safe (pure).

import { describeSignable, type SignableSummary } from "@/lib/swap-test/view"
import { MULTI_SWAP_CADENCE, SWAP_COLLECTIONS } from "@/lib/trade-room/multi-swap-cadence"

type Arg = { type?: string; value?: unknown }


function nested(a: Arg | undefined): string[][] | null {
  if (a?.type !== "Array" || !Array.isArray(a.value) || a.value.length !== SWAP_COLLECTIONS.length) return null
  const out: string[][] = []
  for (const inner of a.value as Arg[]) {
    if (inner?.type !== "Array" || !Array.isArray(inner.value)) return null
    const ids = (inner.value as Arg[]).map((x) => (x?.type === "UInt64" ? String(x.value) : null))
    if (ids.some((x) => x === null || !/^[0-9]{1,20}$/.test(x))) return null
    out.push(ids as string[])
  }
  return out
}

/** Collection-labelled ids, e.g. "All Day 6605811". */
function labelled(lists: string[][]): string[] {
  return lists.flatMap((ids, i) => ids.map((id) => `${SWAP_COLLECTIONS[i].short} ${id}`))
}

export function describeRoomSignable(signable: unknown): SignableSummary {
  const s = (signable ?? {}) as { cadence?: unknown; args?: unknown }
  if (s.cadence !== MULTI_SWAP_CADENCE) {
    const one = describeSignable(signable)
    // the original text moves Top Shot only: say so, so both forms read alike
    return one.ok ? { ...one, idsA: one.idsA.map((id) => `Top Shot ${id}`), idsB: one.idsB.map((id) => `Top Shot ${id}`) } : { ok: false, reason: "This request is not a trade RPC built. Don't sign it." }
  }
  const args = Array.isArray(s.args) ? (s.args as Arg[]) : []
  const addrAt = (i: number) => (args[i]?.type === "Address" && typeof args[i]?.value === "string" ? (args[i].value as string) : null)
  const sourceA = addrAt(0)
  const sourceB = addrAt(3)
  const idsA = nested(args[2])
  const idsB = nested(args[5])
  if (args.length !== 6 || !sourceA || !sourceB || !idsA || !idsB) return { ok: false, reason: "The request's arguments don't decode. Don't sign it." }
  return { ok: true, sourceA, idsA: labelled(idsA), sourceB, idsB: labelled(idsB) }
}
