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
// configureFcl() is idempotent — call at the top of any route that uses
// fcl.mutate / fcl.query so the access node is set even on cold serverless
// invocations where lib/flow.ts hasn't been imported.

import * as fcl from "@onflow/fcl"
import { ec as EC } from "elliptic"
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
  const ec = new EC(HOT_WALLET_CURVE)
  const key = ec.keyFromPrivate(Buffer.from(privateKeyHex, "hex"))
  const sig = key.sign(hashMessageHex(msgHex))
  const n = 32
  const r = sig.r.toArrayLike(Buffer, "be", n)
  const s = sig.s.toArrayLike(Buffer, "be", n)
  return Buffer.concat([r, s]).toString("hex")
}

// Returns an FCL authorization function that proposes/pays/signs as the
// hot wallet. Pass the same instance to proposer, payer, and authorizations
// for single-signer transactions like BREAK_MULTI_TRANSFER_TS.
export function buildHotWalletAuthz() {
  const { addr, pk, keyIndex } = readEnv()
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
