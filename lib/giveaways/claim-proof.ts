// lib/giveaways/claim-proof.ts
//
// Proof that a giveaway winner CONTROLS the Flow Wallet they connected (Trevor,
// 2026-10-03: "It needs to verify this though"). Server-only.
//
// Without this, the claim route trusted whatever `wallet` address the client
// posted: anyone signed in could name someone else's Flow Wallet and send a pack
// to any account linked to it. Now the wallet signs FCL's standard ACCOUNT PROOF
// in the same popup that connects it: no transaction, no fee, nothing to approve
// beyond the sign-in. The server checks three things before it lists accounts or
// records a claim:
//   1. the nonce is one THIS server issued to THIS RPC user, under ten minutes
//      ago: an HMAC of (user id, issue time), recomputed here, so nothing is
//      stored to issue it and a proof made for one user is useless to another;
//   2. the proof was made for THIS site: FCL signs the page's origin as the
//      `appIdentifier`, and we encode the message with our own request origin;
//   3. the chain agrees: FCLCrypto.verifyAccountProofSignatures on mainnet
//      answers whether the signatures are the account's own keys (weights and
//      revocations included).
//
// Three outcomes, never two: a proof that fails a check is refused with why; a
// chain that could not be asked THROWS (FlowScriptError), and the route says
// "try again", never "this isn't your wallet".

import { createHmac, timingSafeEqual } from "node:crypto"
import { FCL_CRYPTO_ADDRESS, normalizeFlowAddress, signingSecret } from "@/lib/auth/flow-signature"
import { runFlowScript, type CdcValue } from "@/lib/giveaways/flow-script"

export const CLAIM_PROOF_TTL_MS = 10 * 60 * 1000
/** A small allowance for a client clock ahead of ours. */
const FUTURE_SKEW_MS = 60 * 1000

export interface ClaimNonce {
  nonce: string
  issuedAt: string
}

export interface ClaimProofInput {
  address?: unknown
  nonce?: unknown
  issuedAt?: unknown
  signatures?: unknown
}

export type ClaimProofOutcome =
  | { ok: true; address: string }
  | { ok: false; code: "proof_missing" | "proof_expired" | "proof_mismatch" | "proof_invalid"; error: string }

interface Sig {
  addr: string
  keyId: string
  signature: string
}

/** 64 hex chars (32 bytes, FCL's minimum account-proof nonce), bound to one RPC user and one issue time. */
export function claimNonceFor(userId: string, issuedAt: string): string {
  return createHmac("sha256", signingSecret()).update(`rpc-giveaway-claim:${userId}:${issuedAt}`, "utf8").digest("hex")
}

export function issueClaimNonce(userId: string, now: Date = new Date()): ClaimNonce {
  const issuedAt = now.toISOString()
  return { nonce: claimNonceFor(userId, issuedAt), issuedAt }
}

// ── RLP, only what an account proof needs: byte strings and one list ──────
function rlpLength(len: number, offset: number): Buffer {
  if (len < 56) return Buffer.from([offset + len])
  const hex = len.toString(16)
  const bytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex")
  return Buffer.concat([Buffer.from([offset + 55 + bytes.length]), bytes])
}
function rlpBytes(b: Buffer): Buffer {
  if (b.length === 1 && b[0] < 0x80) return b
  return Buffer.concat([rlpLength(b.length, 0x80), b])
}
function rlpList(items: Buffer[]): Buffer {
  const body = Buffer.concat(items.map(rlpBytes))
  return Buffer.concat([rlpLength(body.length, 0xc0), body])
}

/**
 * The message FCLCrypto.verifyAccountProofSignatures expects: RLP of
 * [appIdentifier, address (8 bytes), nonce], hex, WITHOUT the domain tag (the
 * contract prepends "FCL-ACCOUNT-PROOF-V0.0" itself). Byte-for-byte FCL's own
 * `WalletUtils.encodeAccountProof(data, false)` — pinned against it in
 * __tests__/giveaways-claim-proof.test.ts.
 */
export function encodeAccountProofMessage(appIdentifier: string, address: string, nonce: string): string {
  const addr = Buffer.from(address.replace(/^0x/, "").padStart(16, "0"), "hex")
  return rlpList([Buffer.from(appIdentifier, "utf8"), addr, Buffer.from(nonce, "hex")]).toString("hex")
}

export const VERIFY_ACCOUNT_PROOF_SCRIPT = `
import FCLCrypto from ${FCL_CRYPTO_ADDRESS}

access(all) fun main(address: Address, message: String, keyIndices: [Int], signatures: [String]): Bool {
  return FCLCrypto.verifyAccountProofSignatures(address: address, message: message, keyIndices: keyIndices, signatures: signatures)
}`.trim()

function ownSignatures(address: string, raw: unknown): Sig[] {
  if (!Array.isArray(raw)) return []
  const out: Sig[] = []
  for (const s of raw as Array<Record<string, unknown>>) {
    if (!s || typeof s !== "object") continue
    const signature = String(s.signature ?? "")
    const keyId = Number(s.keyId)
    // a signature from any OTHER account would ask the chain a different question
    if (normalizeFlowAddress(s.addr) !== address || !/^[0-9a-f]+$/i.test(signature) || !Number.isInteger(keyId) || keyId < 0) continue
    out.push({ addr: address, keyId: String(keyId), signature })
  }
  return out
}

function sameHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), "utf8")
  const bb = Buffer.from(b.toLowerCase(), "utf8")
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Verifies a winner's account proof. `appIdentifier` is the origin the claim
 * page was served from (the route passes its own request origin).
 * Throws FlowScriptError when the chain could not be asked.
 */
export async function verifyClaimProof(
  userId: string,
  appIdentifier: string,
  proof: ClaimProofInput | null | undefined,
  opts: { now?: number; run?: typeof runFlowScript } = {},
): Promise<ClaimProofOutcome> {
  const address = normalizeFlowAddress(proof?.address)
  const nonce = typeof proof?.nonce === "string" ? proof.nonce : ""
  const issuedAt = typeof proof?.issuedAt === "string" ? proof.issuedAt : ""
  if (!proof || !address || !/^[0-9a-f]{64}$/i.test(nonce) || !issuedAt) {
    return { ok: false, code: "proof_missing", error: "Your wallet didn't prove it's yours. Connect Flow Wallet again and approve the sign-in." }
  }
  const now = opts.now ?? Date.now()
  const issued = Date.parse(issuedAt)
  if (!Number.isFinite(issued) || now - issued > CLAIM_PROOF_TTL_MS || issued - now > FUTURE_SKEW_MS) {
    return { ok: false, code: "proof_expired", error: "Your Flow Wallet sign-in expired. Connect Flow Wallet again." }
  }
  if (!sameHex(claimNonceFor(userId, issuedAt), nonce)) {
    return { ok: false, code: "proof_mismatch", error: "That Flow Wallet sign-in wasn't made for your RPC account. Connect Flow Wallet again." }
  }
  const sigs = ownSignatures(address, proof.signatures)
  if (sigs.length === 0) {
    return { ok: false, code: "proof_invalid", error: "Your wallet's sign-in didn't include its signature. Connect Flow Wallet again." }
  }
  const run = opts.run ?? runFlowScript
  const result: CdcValue = await run(VERIFY_ACCOUNT_PROOF_SCRIPT, [
    { type: "Address", value: address },
    { type: "String", value: encodeAccountProofMessage(appIdentifier, address, nonce.toLowerCase()) },
    { type: "Array", value: sigs.map((s) => ({ type: "Int", value: s.keyId })) },
    { type: "Array", value: sigs.map((s) => ({ type: "String", value: s.signature })) },
  ])
  if (result?.type !== "Bool") throw new Error("The account-proof check returned an unexpected shape.")
  if (result.value !== true) {
    return { ok: false, code: "proof_invalid", error: "Flow didn't confirm that sign-in came from that wallet. Connect Flow Wallet again." }
  }
  return { ok: true, address }
}
