// lib/swap-test/relay.ts
//
// Server side of the co-signer relay (migration 20261004023000). The initiator's
// browser (wallet A) posts the signable FCL built for wallet B; the co-signer's
// browser reads it, has wallet B sign, and posts the signature back. Only the
// swap-test transaction can travel through here: a signable carrying any other
// Cadence is refused, so the relay can never be used to collect a signature on
// something else. Service role only, behind RPC_ADMIN_TOKEN.

import type { SupabaseClient } from "@supabase/supabase-js"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import { SwapTestError } from "@/lib/swap-test/plan"

/** A transaction's reference block expires after ~600 blocks (~10 min); keep a little slack. */
export const RELAY_TTL_MS = 15 * 60 * 1000
const MAX_SIGNABLE_CHARS = 200_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/

export interface RelayRow {
  id: string
  cosigner: string
  signable: Record<string, unknown>
  signature: string | null
  key_id: number | null
  created_at: string
  signed_at: string | null
}

const sansPrefix = (a: string) => a.toLowerCase().replace(/^0x/, "")

/** Refuses anything that isn't wallet B's signable for the swap-test transaction. */
export function checkSignable(cosigner: string, signable: unknown): Record<string, unknown> {
  if (!FLOW_ADDRESS.test(cosigner)) throw new SwapTestError("The co-signer is not a Flow 0x address.", 400, "bad_cosigner")
  if (!signable || typeof signable !== "object" || Array.isArray(signable)) {
    throw new SwapTestError("The signable is missing.", 400, "bad_signable")
  }
  const s = signable as Record<string, unknown>
  if (JSON.stringify(s).length > MAX_SIGNABLE_CHARS) throw new SwapTestError("The signable is too large.", 413, "too_large")
  if (s.cadence !== SWAP_CADENCE) throw new SwapTestError("Only the swap-test transaction can be relayed.", 400, "wrong_cadence")
  if (typeof s.message !== "string" || !/^[0-9a-f]+$/.test(s.message)) throw new SwapTestError("The signable has no payload message.", 400, "bad_signable")
  if (typeof s.addr !== "string" || sansPrefix(s.addr) !== sansPrefix(cosigner)) {
    throw new SwapTestError("The signable is not addressed to the co-signer.", 400, "wrong_signer")
  }
  return s
}

export function isExpired(createdAt: string, now: number): boolean {
  const t = Date.parse(createdAt)
  return !Number.isFinite(t) || now - t > RELAY_TTL_MS
}

export async function postSignable(db: SupabaseClient, cosigner: string, signable: unknown): Promise<string> {
  const s = checkSignable(cosigner, signable)
  const { data, error } = await db.from("swap_test_relay").insert({ cosigner, signable: s }).select("id").single()
  if (error) throw error
  const id = (data as { id?: unknown } | null)?.id
  if (typeof id !== "string") throw new Error("swap_test_relay insert returned no id")
  return id
}

export async function getRelay(db: SupabaseClient, id: string, now: number): Promise<RelayRow> {
  if (!UUID.test(id)) throw new SwapTestError("Not a relay id.", 400, "bad_relay")
  const { data, error } = await db
    .from("swap_test_relay")
    .select("id, cosigner, signable, signature, key_id, created_at, signed_at")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new SwapTestError("No such relay.", 404, "no_relay")
  const row = data as RelayRow
  if (isExpired(row.created_at, now)) throw new SwapTestError("This swap request expired; start a new one.", 410, "expired")
  return row
}

export async function postSignature(db: SupabaseClient, id: string, signature: unknown, keyId: unknown, now: number): Promise<void> {
  const sig = typeof signature === "string" ? signature.trim().toLowerCase().replace(/^0x/, "") : ""
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new SwapTestError("The signature is not 64 bytes of hex.", 400, "bad_signature")
  const k = Number(keyId)
  if (!Number.isInteger(k) || k < 0) throw new SwapTestError("The key id is not a key index.", 400, "bad_key")
  await getRelay(db, id, now)
  const { data, error } = await db
    .from("swap_test_relay")
    .update({ signature: sig, key_id: k, signed_at: new Date(now).toISOString() })
    .eq("id", id)
    .is("signature", null)
    .select("id")
  if (error) throw error
  // the update matched nothing: someone already signed this relay (never overwrite a signature)
  if (!Array.isArray(data) || data.length !== 1) throw new SwapTestError("This swap request was already signed.", 409, "already_signed")
}
