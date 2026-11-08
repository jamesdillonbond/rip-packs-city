// lib/breaks/server-authz.ts
//
// Server-side FCL authorization helper for the pack-breaks hot wallet.
//
// The hot wallet (env: HOT_WALLET_ADDR) signs every multi-transfer
// distribution that the /api/breaks/[id]/distribute route fans out. It
// must be a plain Flow account with no HybridCustody / account linking
// (per CLAUDE.md memory: feedback_flow_hot_wallet_no_linking).
//
// Signing curve / hash: ECDSA_secp256k1 + SHA2_256.
//
// VERIFIED ON-CHAIN 2026-07-19 via Flow REST
// (/v1/accounts/0x3aa11c84d776838f?expand=keys): keys 0 and 1 both report
// signing_algorithm "ECDSA_secp256k1" and hashing_algorithm "SHA2_256",
// weight 1000, revoked false. Do NOT change these without re-checking the
// live account — a mismatch produces a well-formed 64-byte signature that
// Flow silently rejects at verification, which is exactly how the previous
// bug (secp256r1 + SHA3-256) survived undetected: this path had never run
// against mainnet, and the unit test only asserted signature *length*.
//
// FCL signing functions return r||s as a 64-byte hex string.
//
// Signer library (2026-11-06): @noble/curves, replacing `elliptic`. elliptic
// carries CVE-2025-14505 / GHSA-848j-6mx2-7j84 (RFC 6979 nonce truncation ->
// possible key exposure) with NO patched release. Measured before the swap:
// the truncation only fires when the curve order's bit length is not a
// multiple of 8, so secp256k1 (256-bit n) was never affected — 0 of 20,000
// signatures diverged from RFC 6979, while the same probe on P-521 diverged
// 11 of 3,000 (~1/256, the bug's rate: positive control). The swap removes an
// unpatched, unmaintained dependency from the key path; output is
// BYTE-IDENTICAL to the elliptic signer (pinned by known-answer vectors in
// __tests__/breaks-server-authz.test.ts). `lowS: false` is what keeps it
// identical — elliptic never canonicalised S, and that is the form verified
// on mainnet; noble's secp256k1 default would normalise it.
//
// configureFcl() is idempotent — call at the top of any route that uses
// fcl.mutate / fcl.query so the access node is set even on cold serverless
// invocations where lib/chains/flow/flow.ts hasn't been imported. (Named
// lib/flow.ts here until 2026-08-16; that shim was deleted 2026-07-25.)

import * as fcl from "@onflow/fcl"
import { secp256k1 } from "@noble/curves/secp256k1"
import { createHash } from "crypto"

const DEFAULT_ACCESS_NODE = "https://rest-mainnet.onflow.org"

let configured = false

export function getFlowAccessNode(): string {
  return process.env.FLOW_ACCESS_NODE || DEFAULT_ACCESS_NODE
}

export function configureFcl(): void {
  if (configured) return
  configured = true
  fcl.config({
    "accessNode.api": getFlowAccessNode(),
    "flow.network": "mainnet",
  })
}

function readEnv(): { addr: string; pk: string; keyIndex: number } {
  const addr = process.env.HOT_WALLET_ADDR
  const pk = process.env.HOT_WALLET_PRIVATE_KEY
  const keyIndexRaw = process.env.HOT_WALLET_KEY_INDEX
  if (!addr) throw new Error("HOT_WALLET_ADDR is not set")
  if (!pk) throw new Error("HOT_WALLET_PRIVATE_KEY is not set")
  if (keyIndexRaw == null || keyIndexRaw === "") throw new Error("HOT_WALLET_KEY_INDEX is not set")
  const keyIndex = parseInt(keyIndexRaw, 10)
  if (!Number.isInteger(keyIndex) || keyIndex < 0) {
    throw new Error(`HOT_WALLET_KEY_INDEX must be a non-negative integer, got ${keyIndexRaw}`)
  }
  return { addr, pk, keyIndex }
}

function sansPrefix(addr: string): string {
  return addr.startsWith("0x") ? addr.slice(2) : addr
}

function withPrefix(addr: string): string {
  return addr.startsWith("0x") ? addr : `0x${addr}`
}

// Curve + hash MUST match the on-chain key config (see header note).
export const HOT_WALLET_CURVE = "secp256k1" as const
export const HOT_WALLET_HASH = "sha256" as const

export function hashMessageHex(msgHex: string): Buffer {
  return createHash(HOT_WALLET_HASH).update(Buffer.from(msgHex, "hex")).digest()
}

export function signWithKey(privateKeyHex: string, msgHex: string): string {
  // RFC 6979 deterministic nonce; signs the SHA2-256 digest (no re-hash).
  const sig = secp256k1.sign(hashMessageHex(msgHex), privateKeyHex.padStart(64, "0"), { lowS: false })
  return Buffer.from(sig.toCompactRawBytes()).toString("hex")
}

// Returns an FCL authorization function that proposes/pays/signs as the
// hot wallet. Pass the same instance to proposer, payer, and authorizations
// for single-signer transactions like BREAK_MULTI_TRANSFER_TS.
export function buildHotWalletAuthz() {
  return buildKeyAuthz(readEnv())
}

// The same single-signer authorization for ANY plain Flow account whose key is
// ECDSA_secp256k1 + SHA2_256 (2026-11-08: the giveaway vault, lib/giveaways/vault.ts).
// The caller reads its own env and must have checked the account's on-chain key
// config matches; a mismatch is a well-formed signature Flow silently rejects.
export function buildKeyAuthz({ addr, pk, keyIndex }: { addr: string; pk: string; keyIndex: number }) {
  const addrSans = sansPrefix(addr)
  const addrWith = withPrefix(addr)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (account: any) => ({
    ...account,
    tempId: `${addrSans}-${keyIndex}`,
    addr: addrSans,
    keyId: keyIndex,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signingFunction: async (signable: any) => ({
      addr: addrWith,
      keyId: keyIndex,
      signature: signWithKey(pk, signable.message),
    }),
  })
}
