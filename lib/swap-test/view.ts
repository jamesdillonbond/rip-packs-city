// lib/swap-test/view.ts
//
// Pure helpers for the swap-test console (app/admin/swap-test/SwapTestClient.tsx):
// parsing the id fields, describing what the co-signer is about to sign (decoded
// from the relayed signable, never from anything the initiator typed), and polling
// the relay for the co-signer's signature.

import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import type { SwapPlan } from "@/lib/swap-test/plan"

/** "1, 2 3" -> ["1","2","3"]; blanks dropped. Validation is the server's job. */
export function parseIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export type SignableSummary =
  | { ok: true; sourceA: string; idsA: string[]; sourceB: string; idsB: string[] }
  | { ok: false; reason: string }

/**
 * What the relayed transaction does, read from its own JSON-CDC arguments
 * (sourceA, ctlA, idsA, sourceB, ctlB, idsB). Anything that is not the swap-test
 * transaction, or whose arguments don't decode, is reported as not signable.
 */
export function describeSignable(signable: unknown): SignableSummary {
  const s = (signable ?? {}) as { cadence?: unknown; args?: unknown }
  if (s.cadence !== SWAP_CADENCE) return { ok: false, reason: "This request is not the swap-test transaction. Don't sign it." }
  const args = Array.isArray(s.args) ? (s.args as Array<{ type?: string; value?: unknown }>) : []
  const addrAt = (i: number) => (args[i]?.type === "Address" && typeof args[i]?.value === "string" ? (args[i].value as string) : null)
  const idsAt = (i: number) =>
    args[i]?.type === "Array" && Array.isArray(args[i]?.value)
      ? (args[i].value as Array<{ type?: string; value?: unknown }>).map((x) => (x?.type === "UInt64" ? String(x.value) : null))
      : null
  const sourceA = addrAt(0)
  const sourceB = addrAt(3)
  const idsA = idsAt(2)
  const idsB = idsAt(5)
  if (args.length !== 6 || !sourceA || !sourceB || !idsA || !idsB || [...idsA, ...idsB].some((x) => x === null)) {
    return { ok: false, reason: "The request's arguments don't decode. Don't sign it." }
  }
  return { ok: true, sourceA, idsA: idsA as string[], sourceB, idsB: idsB as string[] }
}

type Fetched = { ok: boolean; status: number; body: Record<string, unknown> | null }

export const RELAY_POLL_MS = 2_000
/** ~9 minutes: inside the transaction's reference-block window. */
export const RELAY_POLL_ATTEMPTS = 270

/**
 * Polls the relay until the co-signer's signature is there. A failed or expired read
 * REJECTS (never resolves to "unsigned"), and so does running out of attempts.
 */
export async function waitForRelaySignature(
  get: (id: string) => Promise<Fetched>,
  id: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = RELAY_POLL_ATTEMPTS,
): Promise<{ signature: string; keyId: number }> {
  let transient = 0
  for (let i = 0; i < attempts; i++) {
    const r = await get(id)
    const relay = r.body?.relay as { signature?: unknown; key_id?: unknown } | undefined
    if (r.ok && relay) {
      transient = 0
      if (typeof relay.signature === "string" && Number.isInteger(relay.key_id)) {
        return { signature: relay.signature, keyId: relay.key_id as number }
      }
    } else if (r.status === 404 || r.status === 410 || r.status === 400 || r.status === 401) {
      throw new Error(String(r.body?.error ?? `relay HTTP ${r.status}`))
    } else if (++transient >= 5) {
      throw new Error(`The relay failed 5 reads in a row (last: ${String(r.body?.error ?? `HTTP ${r.status}`)}).`)
    }
    await sleep(RELAY_POLL_MS)
  }
  throw new Error("The co-signer didn't sign in time; the transaction would expire. Start again.")
}

export interface SwapForm {
  aSigner: string
  aSource: string
  aIds: string
  bSigner: string
  bSource: string
  bIds: string
}

/**
 * The form for swapping BACK after a run: the same two wallets on the same sides (so
 * the same device starts it), each now giving what it received. Run 1 (A gives X, B
 * gives nothing) becomes run 2 (A gives nothing, B gives X back).
 */
export function swapBackForm(plan: SwapPlan): SwapForm {
  return {
    aSigner: plan.a.signer,
    aSource: plan.a.source,
    aIds: plan.b.ids.join(", "),
    bSigner: plan.b.signer,
    bSource: plan.b.source,
    bIds: plan.a.ids.join(", "),
  }
}
