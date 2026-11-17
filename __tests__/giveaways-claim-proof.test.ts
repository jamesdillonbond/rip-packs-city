import { describe, it, expect, vi, beforeAll } from "vitest"
import * as fcl from "@onflow/fcl"
import {
  CLAIM_PROOF_TTL_MS,
  VERIFY_ACCOUNT_PROOF_SCRIPT,
  claimNonceFor,
  encodeAccountProofMessage,
  issueClaimNonce,
  verifyClaimProof,
} from "@/lib/giveaways/claim-proof"
import { FlowScriptError } from "@/lib/giveaways/flow-script"

// Proof a giveaway winner controls the Flow Wallet they connected (Trevor,
// 2026-10-03: "It needs to verify this though"). What matters: a nonce works
// only for the user it was issued to and only for ten minutes; the message the
// chain checks is byte-for-byte FCL's own; only the chain's `true` passes; and a
// chain that could not be asked THROWS rather than reading as "not your wallet".

beforeAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(48)
})

const ORIGIN = "https://www.rippackscity.com"
const WALLET = "0x3d0b274c80263484"
const T0 = Date.parse("2026-10-03T17:00:00.000Z")

function proofFor(userId: string, over: Record<string, unknown> = {}) {
  const { nonce, issuedAt } = issueClaimNonce(userId, new Date(T0))
  return { address: WALLET, nonce, issuedAt, signatures: [{ f_type: "CompositeSignature", addr: WALLET, keyId: 0, signature: "ab".repeat(64) }], ...over }
}
const chainSays = (value: boolean) => vi.fn(async () => ({ type: "Bool", value }))

describe("claim nonce", () => {
  it("is 64 hex (FCL's 32-byte minimum), differs per user and per issue time", () => {
    const a = claimNonceFor("u1", "2026-10-03T17:00:00.000Z")
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(claimNonceFor("u2", "2026-10-03T17:00:00.000Z")).not.toBe(a)
    expect(claimNonceFor("u1", "2026-10-03T17:00:01.000Z")).not.toBe(a)
    expect(claimNonceFor("u1", "2026-10-03T17:00:00.000Z")).toBe(a)
  })

  it("refuses to issue without a signing secret — never a guessable nonce", () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      expect(() => issueClaimNonce("u1")).toThrow(/signing secret/)
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved
    }
  })
})

describe("encodeAccountProofMessage", () => {
  it("is byte-for-byte FCL's own encodeAccountProof(data, false)", () => {
    for (const [app, addr, nonce] of [
      [ORIGIN, WALLET, "ab".repeat(32)],
      ["https://rippackscity.com", "0x00000000000000f1", claimNonceFor("u1", "t")],
      ["http://localhost:3000", "0x0000000000000001", "0f".repeat(40)],
    ]) {
      expect(encodeAccountProofMessage(app, addr, nonce)).toBe(fcl.WalletUtils.encodeAccountProof({ appIdentifier: app, address: addr, nonce }, false))
    }
  })

  it("the script asks FCLCrypto (mainnet) for ACCOUNT-PROOF signatures, not user-message ones", () => {
    expect(VERIFY_ACCOUNT_PROOF_SCRIPT).toContain("import FCLCrypto from 0xb4b82a1c9d21d284")
    expect(VERIFY_ACCOUNT_PROOF_SCRIPT).toContain("FCLCrypto.verifyAccountProofSignatures(")
    expect(VERIFY_ACCOUNT_PROOF_SCRIPT).not.toContain("verifyUserSignatures")
  })
})

describe("verifyClaimProof", () => {
  it("a proof for this user, this site, inside ten minutes, that the chain confirms → the wallet", async () => {
    const run = chainSays(true)
    const out = await verifyClaimProof("u1", ORIGIN, proofFor("u1"), { now: T0 + 60_000, run })
    expect(out).toEqual({ ok: true, address: WALLET })
    const [script, args] = run.mock.calls[0] as unknown as [string, Array<{ type: string; value: unknown }>]
    expect(script).toBe(VERIFY_ACCOUNT_PROOF_SCRIPT)
    expect(args[0]).toEqual({ type: "Address", value: WALLET })
    // the message is encoded with OUR origin and OUR nonce
    expect(args[1]).toEqual({ type: "String", value: encodeAccountProofMessage(ORIGIN, WALLET, proofFor("u1").nonce) })
    expect(args[2]).toEqual({ type: "Array", value: [{ type: "Int", value: "0" }] })
  })

  it("the message is encoded for the origin the ROUTE passes — a proof made for another site is checked as such", async () => {
    const run = chainSays(true)
    await verifyClaimProof("u1", "https://evil.example", proofFor("u1"), { now: T0, run })
    const args = (run.mock.calls[0] as unknown as [string, Array<{ value: unknown }>])[1]
    expect(args[1].value).toBe(encodeAccountProofMessage("https://evil.example", WALLET, proofFor("u1").nonce))
    expect(args[1].value).not.toBe(encodeAccountProofMessage(ORIGIN, WALLET, proofFor("u1").nonce))
  })

  it("the chain saying no is a refusal, never a pass", async () => {
    const out = await verifyClaimProof("u1", ORIGIN, proofFor("u1"), { now: T0, run: chainSays(false) })
    expect(out).toMatchObject({ ok: false, code: "proof_invalid" })
  })

  it("another user's nonce is refused before the chain is asked", async () => {
    const run = chainSays(true)
    const out = await verifyClaimProof("u2", ORIGIN, proofFor("u1"), { now: T0, run })
    expect(out).toMatchObject({ ok: false, code: "proof_mismatch" })
    expect(run).not.toHaveBeenCalled()
  })

  it("a re-dated issue time does not keep an old nonce alive", async () => {
    const run = chainSays(true)
    const out = await verifyClaimProof("u1", ORIGIN, proofFor("u1", { issuedAt: new Date(T0 + 5_000).toISOString() }), { now: T0 + 6_000, run })
    expect(out).toMatchObject({ ok: false, code: "proof_mismatch" })
    expect(run).not.toHaveBeenCalled()
  })

  it("expired past ten minutes, or issued in the future", async () => {
    const run = chainSays(true)
    expect(await verifyClaimProof("u1", ORIGIN, proofFor("u1"), { now: T0 + CLAIM_PROOF_TTL_MS + 1, run })).toMatchObject({ code: "proof_expired" })
    expect(await verifyClaimProof("u1", ORIGIN, proofFor("u1"), { now: T0 - 5 * 60_000, run })).toMatchObject({ code: "proof_expired" })
    expect(run).not.toHaveBeenCalled()
  })

  it("no proof, a malformed address or nonce → proof_missing", async () => {
    const run = chainSays(true)
    for (const p of [null, undefined, {}, proofFor("u1", { address: "0xabc" }), proofFor("u1", { nonce: "zz" }), proofFor("u1", { issuedAt: 5 })]) {
      expect(await verifyClaimProof("u1", ORIGIN, p as never, { now: T0, run })).toMatchObject({ ok: false, code: "proof_missing" })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it("signatures from ANOTHER account are dropped; none left is a refusal, not a chain question", async () => {
    const run = chainSays(true)
    const foreign = [{ addr: "0x00000000000000d2", keyId: 0, signature: "ab".repeat(64) }]
    expect(await verifyClaimProof("u1", ORIGIN, proofFor("u1", { signatures: foreign }), { now: T0, run })).toMatchObject({ code: "proof_invalid" })
    expect(await verifyClaimProof("u1", ORIGIN, proofFor("u1", { signatures: "nope" }), { now: T0, run })).toMatchObject({ code: "proof_invalid" })
    expect(run).not.toHaveBeenCalled()
    const mixed = [...foreign, { addr: WALLET, keyId: 2, signature: "cd".repeat(64) }]
    await verifyClaimProof("u1", ORIGIN, proofFor("u1", { signatures: mixed }), { now: T0, run })
    const args = (run.mock.calls[0] as unknown as [string, Array<{ value: unknown }>])[1]
    expect(args[2].value).toEqual([{ type: "Int", value: "2" }])
    expect(args[3].value).toEqual([{ type: "String", value: "cd".repeat(64) }])
  })

  it("a chain that could not be asked THROWS — never 'not your wallet'", async () => {
    const run = vi.fn(async () => {
      throw new FlowScriptError("Flow script HTTP 503", 503)
    })
    await expect(verifyClaimProof("u1", ORIGIN, proofFor("u1"), { now: T0, run })).rejects.toBeInstanceOf(FlowScriptError)
    const odd = vi.fn(async () => ({ type: "Optional", value: null }))
    await expect(verifyClaimProof("u1", ORIGIN, proofFor("u1"), { now: T0, run: odd })).rejects.toThrow(/unexpected shape/)
  })
})
