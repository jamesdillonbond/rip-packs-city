// lib/auth/flow-signature.ts
//
// Wallet-signature proof of control. A wallet signs one short message; the
// CHAIN confirms the signature belongs to the address; RPC never sees a key,
// never asks for a transaction, and stores nothing server-side to issue the
// challenge.
//
// WHY THIS EXISTS (2026-09-14). RPC's only proof-of-control was the listing
// challenge (app/api/profile/verify-challenge): pick a Moment the wallet owns,
// ask the user to LIST it on nbatopshot.com at a unique unbuyable price, then
// poll Atlas for the listing. Measured that day: 135 saved wallets, 9 verified
// (6.7%), and the newest challenge of any kind was 2026-06-15 — three months of
// nobody completing it. The flow is not broken so much as too expensive to
// finish: it requires the user to leave RPC, list a real asset, and come back.
//
// THE 2026-08-08 DECISION THIS RE-DERIVES. lib/chains/flow/flow.ts records
// "Dapper Wallet sign-in requires Dapper developer approval we do not have",
// and every connect path was removed on that basis. Re-measured 2026-09-14
// against topshotexplorer.com, a third-party open-source app with no Dapper
// relationship: its Early Adopters wall carries nine signatures, EVERY ONE
// from a Dapper wallet, block-stamped and dated 2026-09-13/14, each verified
// by exactly the script below. The blocker is real for TRANSACTIONS (Dapper
// merchant approval, DapperUtilityCoin) and false for SIGNATURES. RPC is
// read-only and needs only the signature half.
//
// This module is the SERVER half and is deliberately client-free: no FCL
// import, no wallet discovery, no connect surface. It verifies a signature a
// caller already obtained. __tests__/no-client-wallet-connect.test.ts stays
// green against this file by construction.
//
// The flow, three requests:
//   GET  challenge  -> the message to sign (the nonce is an HMAC the server can
//                      recompute, so no challenge row is needed to issue one)
//   POST verify     -> nonce recomputed, freshness checked, then the chain is
//                      asked whether the signatures are the address's own
//   (the caller then records the verification)
//
// Credit: the challenge/verify shape follows Top Shot Explorer's
// deploy/cloudflare/auth.js (Apache-2.0, github.com/veerman/topshot-explorer).

import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto"

// FCLCrypto on Flow mainnet. verifyUserSignatures is the canonical on-chain
// check for an FCL user signature: it resolves the account's keys, weights and
// hashing algorithms at the sealed block and answers one Bool. Verifying in
// Cadence rather than in TypeScript is what makes this correct for Dapper
// wallets, whose accounts are multi-key and whose key set changes over time.
export const FCL_CRYPTO_ADDRESS = "0xb4b82a1c9d21d284"

export const FLOW_REST_BASE = process.env.FLOW_ACCESS_NODE || "https://rest-mainnet.onflow.org"

// Ten minutes to sign. The client refetches past eight (see the route), so a
// user who takes a slow path through a wallet popup is re-issued rather than
// rejected. The listing challenge's 60 minutes existed because listing a
// Moment is slow; signing is not.
export const CHALLENGE_TTL_MS = 10 * 60 * 1000
// A small allowance for a client clock ahead of ours.
const FUTURE_SKEW_MS = 60 * 1000

export type FlowChallenge = {
  address: string
  issuedAt: string
  nonce: string
  message: string
  messageHex: string
}

export type FlowSignature = {
  addr?: string
  keyId?: number | string
  signature?: string
}

/** Lowercased `0x` + 16 hex, or null. Flow addresses are 8 bytes. */
export function normalizeFlowAddress(input: unknown): string | null {
  const x = String(input ?? "").trim().toLowerCase().replace(/^0x/, "")
  return /^[0-9a-f]{16}$/.test(x) ? `0x${x}` : null
}

/**
 * The signing secret. Deliberately NOT its own env var: the nonce only needs
 * to be unforgeable and recomputable, and the service-role key is already the
 * server's most-protected secret. It never leaves this module — only the
 * 32-char HMAC digest does.
 *
 * Throws rather than falling back to a constant: a guessable nonce would let
 * an attacker pre-mint a challenge for someone else's address, which is the
 * one thing the nonce exists to prevent. Fail closed, loudly.
 */
function signingSecret(): string {
  const s = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!s || s.length < 32) {
    throw new Error("flow-signature: no signing secret available (SUPABASE_SERVICE_ROLE_KEY)")
  }
  return s
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url")
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  // nodeTimingSafeEqual throws on a length mismatch, which is itself a leak of
  // one bit we do not care about hiding (nonce length is fixed and public).
  if (ab.length !== bb.length) return false
  return nodeTimingSafeEqual(ab, bb)
}

/** The nonce for one address at one issue time. Recomputable => stateless. */
export function nonceFor(address: string, issuedAt: string): string {
  return hmac(signingSecret(), `rpc-wallet-challenge:${address}:${issuedAt}`).slice(0, 32)
}

/**
 * The exact text the wallet displays. The wallet shows this to the user, so it
 * is four short labelled lines and nothing else — no JSON, no URL, no base64.
 * A user who cannot read what they are signing has not consented to it.
 *
 * The site line is a constant, not the request's Host: the nonce (which only
 * this server can derive) is what ties a signature to one issue for one
 * address, so the message never needs to carry the host.
 */
export function signInMessage(c: { address: string; issuedAt: string; nonce: string }): string {
  return [
    `wallet: ${c.address}`,
    "site: rippackscity.com",
    `date: ${c.issuedAt}`,
    `code: ${c.nonce}`,
  ].join("\n")
}

/** UTF-8 hex, which is what FCL's signUserMessage expects. */
export function toHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex")
}

export function makeChallenge(rawAddress: unknown, now: Date = new Date()): FlowChallenge | null {
  const address = normalizeFlowAddress(rawAddress)
  if (!address) return null
  const issuedAt = now.toISOString()
  const nonce = nonceFor(address, issuedAt)
  const message = signInMessage({ address, issuedAt, nonce })
  return { address, issuedAt, nonce, message, messageHex: toHex(message) }
}

const VERIFY_SCRIPT = `
import FCLCrypto from ${FCL_CRYPTO_ADDRESS}

access(all) fun main(address: Address, message: String, keyIndices: [Int], signatures: [String]): Bool {
  return FCLCrypto.verifyUserSignatures(address: address, message: message, keyIndices: keyIndices, signatures: signatures)
}`.trim()

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
const cadenceArg = (type: string, value: unknown) => b64(JSON.stringify({ type, value }))

export class FlowVerifyUnavailable extends Error {}

/**
 * Ask the chain whether these composite signatures are the address's own for
 * this hex message.
 *
 * Signatures arrive from FCL as [{ addr, keyId, signature }]. Any entry whose
 * addr is NOT the address being proved is dropped: a wallet may co-sign with a
 * linked account, and letting a foreign signature into the array would ask the
 * chain a different question than the one we mean.
 *
 * THREE OUTCOMES, NOT TWO (the honesty rule). `false` means the chain answered
 * and said no. A failed read throws FlowVerifyUnavailable so the caller renders
 * "could not check" rather than publishing a read failure as a rejection —
 * telling a user their own wallet did not verify, when in fact an access node
 * 500'd, is the account-level false claim this codebase keeps finding.
 */
export async function verifyUserSignatures(
  address: string,
  messageHex: string,
  signatures: FlowSignature[] | undefined,
  opts: { restBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<boolean> {
  const own = (signatures ?? []).filter(
    (s) =>
      s &&
      normalizeFlowAddress(s.addr) === address &&
      /^[0-9a-f]+$/i.test(String(s.signature ?? "")) &&
      Number.isFinite(Number(s.keyId))
  )
  // No signature FROM THIS ADDRESS is a definite no, not an unavailability:
  // the caller sent us something, it just did not include the proof asked for.
  if (own.length === 0) return false

  const body = {
    script: b64(VERIFY_SCRIPT),
    arguments: [
      cadenceArg("Address", address),
      cadenceArg("String", messageHex),
      cadenceArg(
        "Array",
        own.map((s) => ({ type: "Int", value: String(Number(s.keyId)) }))
      ),
      cadenceArg(
        "Array",
        own.map((s) => ({ type: "String", value: String(s.signature) }))
      ),
    ],
  }

  const restBase = opts.restBase || FLOW_REST_BASE
  const doFetch = opts.fetchImpl || fetch
  // Every fetch is bounded — an unbounded one inside a route is how a
  // maxDuration kill happens, and a kill leaves no row anywhere.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000)
  let res: Response
  try {
    res = await doFetch(`${restBase}/v1/scripts?block_height=sealed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (err) {
    throw new FlowVerifyUnavailable(`flow verify unreachable: ${(err as Error)?.message ?? String(err)}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // A 400 here is the script itself being rejected (bad arg shape), which is
    // our bug, not the user's — still unavailable rather than "did not verify".
    throw new FlowVerifyUnavailable(`flow verify ${res.status}`)
  }

  // The REST body is a JSON string holding base64 JSON-Cadence:
  //   "eyJ0eXBlIjoiQm9vbCIsInZhbHVlIjp0cnVlfQ==" -> {"type":"Bool","value":true}
  let decoded: { type?: string; value?: unknown }
  try {
    const raw = JSON.parse(await res.text())
    decoded = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"))
  } catch (err) {
    throw new FlowVerifyUnavailable(`flow verify undecodable: ${(err as Error)?.message ?? String(err)}`)
  }
  return decoded?.type === "Bool" && decoded?.value === true
}

export type VerifyOutcome =
  | { ok: true; address: string }
  | { ok: false; error: string; code: "incomplete" | "expired" | "mismatch" | "unverified" }

/**
 * The whole verify step: the nonce is ours, the issue time is fresh, and the
 * chain agrees the signature is the address's own.
 *
 * Throws FlowVerifyUnavailable when the chain could not be asked.
 */
export async function verifyWalletSignature(
  body: { address?: unknown; issuedAt?: unknown; nonce?: unknown; signatures?: FlowSignature[] },
  opts: { restBase?: string; fetchImpl?: typeof fetch; now?: number } = {}
): Promise<VerifyOutcome> {
  const address = normalizeFlowAddress(body?.address)
  const issuedAt = String(body?.issuedAt ?? "")
  const nonce = String(body?.nonce ?? "")
  if (!address || !issuedAt || !nonce) {
    return { ok: false, code: "incomplete", error: "Incomplete sign-in request." }
  }

  const now = opts.now ?? Date.now()
  const issued = Date.parse(issuedAt)
  if (!Number.isFinite(issued) || now - issued > CHALLENGE_TTL_MS || issued - now > FUTURE_SKEW_MS) {
    return { ok: false, code: "expired", error: "That sign-in request expired. Ask for a new one and sign again." }
  }

  // Recompute rather than look up. A challenge we never issued cannot match.
  const expected = nonceFor(address, issuedAt)
  if (!constantTimeEquals(expected, nonce)) {
    return { ok: false, code: "mismatch", error: "That sign-in request did not match. Ask for a new one." }
  }

  const messageHex = toHex(signInMessage({ address, issuedAt, nonce }))
  const valid = await verifyUserSignatures(address, messageHex, body?.signatures, opts)
  if (!valid) {
    return { ok: false, code: "unverified", error: "The wallet's signature did not verify on chain." }
  }
  return { ok: true, address }
}
