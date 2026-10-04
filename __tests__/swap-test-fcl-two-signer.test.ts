import { describe, it, expect } from "vitest"
import { ec as EC } from "elliptic"
import * as sdk from "@onflow/sdk"
import * as t from "@onflow/types"
import { hashMessageHex, signWithKey } from "@/lib/breaks/server-authz"
import { relayedAuthorizer, type RelayIO } from "@/lib/swap-test/swap-wallet"
import { SWAP_CADENCE, SWAP_GAS_LIMIT } from "@/lib/swap-test/swap-cadence"

// The swap test's one genuinely new mechanism, proven with the REAL FCL pipeline
// (no mocks, no network): the same build `fcl.mutate` assembles — proposer + payer +
// authorizer A, plus authorizer B whose signature arrives through the relay — run
// through FCL's own account resolution and signature collection. Then the resulting
// transaction is checked CRYPTOGRAPHICALLY, the way the Flow network checks it:
//   * B's payload signature verifies over the payload FCL encodes for submission,
//     and is filed under the key B ACTUALLY signed with (2), not the placeholder (0);
//   * A's envelope signature verifies over the envelope that includes B's signature.
// What this cannot prove: how a real Flow Wallet behaves when asked to sign as a
// non-paying authorizer, or its gas sponsorship. That is the live test's job.

const ec = new EC("secp256k1")
const keyA = ec.genKeyPair()
const keyB = ec.genKeyPair()
const privA = keyA.getPrivate("hex").padStart(64, "0")
const privB = keyB.getPrivate("hex").padStart(64, "0")
const A = "3d0b274c80263484"
const B = "f00df00df00df00d"
const B_KEY = 2

function verify(key: EC.KeyPair, msgHex: string, sigHex: string): boolean {
  return key.verify(hashMessageHex(msgHex), { r: sigHex.slice(0, 64), s: sigHex.slice(64, 128) })
}

const authzA = async (account: Record<string, unknown>) => ({
  ...account,
  tempId: `${A}-0`,
  addr: A,
  keyId: 0,
  sequenceNum: 41,
  signingFunction: async (signable: { message: string }) => ({ addr: A, keyId: 0, signature: signWithKey(privA, signable.message) }),
})

describe("swap test — two signers through the relay, real FCL resolution", () => {
  it("produces a transaction both signatures verify on, with B's real key index", async () => {
    let relayed: { message: string; addr: string; cadence: unknown; voucher: unknown } | null = null
    const io: RelayIO = {
      post: async (cosigner, signable) => {
        expect(cosigner).toBe(`0x${B}`)
        relayed = signable as typeof relayed
        return "relay-1"
      },
      // the co-signer's wallet signs the relayed payload message with ITS key index
      waitForSignature: async () => ({ signature: signWithKey(privB, relayed!.message), keyId: B_KEY }),
      onRelay: () => {},
    }

    const ix = await sdk.resolve(
      await sdk.build([
        sdk.transaction(SWAP_CADENCE),
        sdk.args([
          sdk.arg("0xbd94cade097e50ac", t.Address),
          sdk.arg("87", t.UInt64),
          sdk.arg(["27289790"], t.Array(t.UInt64)),
          sdk.arg(`0x${B}`, t.Address),
          sdk.arg("0", t.UInt64),
          sdk.arg([], t.Array(t.UInt64)),
        ]),
        sdk.proposer(authzA as never),
        sdk.payer(authzA as never),
        sdk.authorizations([authzA, relayedAuthorizer(`0x${B}`, io)] as never),
        sdk.limit(SWAP_GAS_LIMIT),
        sdk.ref("a".repeat(64)),
      ]),
    )

    // the relayed request is the swap, addressed to B
    expect(relayed!.cadence).toBe(SWAP_CADENCE)
    expect(relayed!.addr).toBe(B)

    const voucher = sdk.createSignableVoucher(ix) as {
      cadence: string
      refBlock: string
      computeLimit: number
      arguments: unknown[]
      proposalKey: { address: string; keyId: number; sequenceNum: number }
      payer: string
      authorizers: string[]
      payloadSigs: { address: string; keyId: number; sig: string }[]
      envelopeSigs: { address: string; keyId: number; sig: string }[]
    }
    // A is proposer and payer; B and A authorize, A first (prepare(a, b))
    expect(voucher.authorizers.map((x) => x.replace(/^0x/, ""))).toEqual([A, B])
    expect(voucher.payer.replace(/^0x/, "")).toBe(A)

    const strip = (a: string) => a.replace(/^0x/, "")
    const payload = {
      cadence: voucher.cadence,
      refBlock: voucher.refBlock,
      computeLimit: voucher.computeLimit,
      arguments: voucher.arguments,
      proposalKey: { address: strip(voucher.proposalKey.address), keyId: voucher.proposalKey.keyId, sequenceNum: voucher.proposalKey.sequenceNum },
      payer: strip(voucher.payer),
      authorizers: voucher.authorizers.map(strip),
    }
    const payloadMsg = sdk.encodeTransactionPayload(payload as never)

    // B: exactly one payload signature, under the key B actually used, valid over THE payload
    const bSigs = voucher.payloadSigs.filter((s) => strip(s.address) === B)
    expect(bSigs).toHaveLength(1)
    expect(bSigs[0].keyId).toBe(B_KEY)
    expect(verify(keyB, payloadMsg, bSigs[0].sig)).toBe(true)
    // and the relayed message WAS that payload (B signed what is submitted)
    expect(relayed!.message).toBe(payloadMsg)

    // A: the envelope signature covers the payload plus B's signature
    const aEnv = voucher.envelopeSigs.filter((s) => strip(s.address) === A)
    expect(aEnv).toHaveLength(1)
    const envelopeMsg = sdk.encodeTransactionEnvelope({
      ...payload,
      payloadSigs: voucher.payloadSigs.map((s) => ({ address: strip(s.address), keyId: s.keyId, sig: s.sig })),
    } as never)
    expect(verify(keyA, envelopeMsg, aEnv[0].sig)).toBe(true)

    // control: a signature filed under the placeholder key would not be what the network checks
    expect(verify(keyA, payloadMsg, bSigs[0].sig)).toBe(false)
  })
})
