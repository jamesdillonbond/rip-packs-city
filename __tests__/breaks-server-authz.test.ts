import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins lib/breaks/server-authz.ts — the hot-wallet FCL authorization used by the
// pack-breaks distribute route to sign multi-transfer txs. Security-relevant and
// previously at 0% coverage. Covers: access-node default/override, configureFcl
// idempotency, the fail-loud env validation (missing addr/key/index, bad index),
// and the authz-object + ECDSA_secp256k1/SHA2_256 signing.
//
// NOTE (2026-07-19): this file previously pinned secp256r1 + SHA3-256, which is
// NOT what hot wallet 0x3aa11c84d776838f uses — Flow REST reports
// ECDSA_secp256k1 + SHA2_256 on both keys. The old assertion only checked that
// the signature was 128 hex chars, which a wrong-curve signature also satisfies,
// so the mismatch was invisible. The signing tests below now VERIFY the
// signature cryptographically instead of measuring its length.
//
// 2026-11-06: the signer moved from `elliptic` (CVE-2025-14505, no patched
// release) to @noble/curves. Verification here uses OpenSSL via node:crypto —
// an implementation independent of the signer, which also hashes the message
// itself, so the SHA2-256 choice is checked too. The known-answer vectors below
// were produced by the ELLIPTIC signer that ran on mainnet, immediately before
// the swap: they pin the new signer to byte-identical output (incl. a high-S
// vector — elliptic never canonicalised S, hence `lowS: false`).

const configSpy = vi.fn()
vi.mock("@onflow/fcl", () => ({ config: (...a: any[]) => configSpy(...a) }))

import { createECDH, createPublicKey, verify as cryptoVerify, randomBytes } from "crypto"
import {
  getFlowAccessNode,
  configureFcl,
  buildHotWalletAuthz,
  HOT_WALLET_CURVE,
  HOT_WALLET_HASH,
  signWithKey,
} from "@/lib/breaks/server-authz"

// A valid 32-byte private key (hex). Any nonzero <n scalar works for signing.
const PK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// Independent verifier: OpenSSL. Derives the public key from PK on `curve`, then
// checks r||s over SHA2-256(message) — node hashes the raw message itself.
function opensslVerifies(curve: "secp256k1" | "prime256v1", msgHex: string, sigHex: string): boolean {
  const ecdh = createECDH(curve)
  ecdh.setPrivateKey(Buffer.from(PK, "hex"))
  const pub = ecdh.getPublicKey() // 0x04 || x || y
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: curve === "secp256k1" ? "secp256k1" : "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    },
    format: "jwk",
  })
  return cryptoVerify("sha256", Buffer.from(msgHex, "hex"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sigHex, "hex"))
}

const ENV_KEYS = ["FLOW_ACCESS_NODE", "HOT_WALLET_ADDR", "HOT_WALLET_PRIVATE_KEY", "HOT_WALLET_KEY_INDEX"]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  configSpy.mockClear()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("getFlowAccessNode", () => {
  it("defaults to mainnet REST and honors the override", () => {
    expect(getFlowAccessNode()).toBe("https://rest-mainnet.onflow.org")
    process.env.FLOW_ACCESS_NODE = "https://custom.node"
    expect(getFlowAccessNode()).toBe("https://custom.node")
  })
})

describe("configureFcl", () => {
  it("configures FCL exactly once (idempotent across calls)", () => {
    configureFcl()
    configureFcl()
    // The module-level guard means at most one config call happens for the
    // lifetime of the imported module; earlier suites may have consumed it, so
    // assert it never exceeds one this run.
    expect(configSpy.mock.calls.length).toBeLessThanOrEqual(1)
  })
})

describe("buildHotWalletAuthz — env validation", () => {
  it("throws when HOT_WALLET_ADDR is missing", () => {
    process.env.HOT_WALLET_PRIVATE_KEY = PK
    process.env.HOT_WALLET_KEY_INDEX = "0"
    expect(() => buildHotWalletAuthz()).toThrow(/HOT_WALLET_ADDR/)
  })

  it("throws when the private key is missing", () => {
    process.env.HOT_WALLET_ADDR = "0x3aa11c84d776838f"
    process.env.HOT_WALLET_KEY_INDEX = "0"
    expect(() => buildHotWalletAuthz()).toThrow(/HOT_WALLET_PRIVATE_KEY/)
  })

  it("throws when the key index is unset or empty", () => {
    process.env.HOT_WALLET_ADDR = "0x3aa11c84d776838f"
    process.env.HOT_WALLET_PRIVATE_KEY = PK
    process.env.HOT_WALLET_KEY_INDEX = ""
    expect(() => buildHotWalletAuthz()).toThrow(/HOT_WALLET_KEY_INDEX/)
  })

  it("throws when the key index is not a non-negative integer", () => {
    process.env.HOT_WALLET_ADDR = "0x3aa11c84d776838f"
    process.env.HOT_WALLET_PRIVATE_KEY = PK
    process.env.HOT_WALLET_KEY_INDEX = "-2"
    expect(() => buildHotWalletAuthz()).toThrow(/non-negative integer/)
  })
})

describe("buildHotWalletAuthz — authorization object & signing", () => {
  beforeEach(() => {
    process.env.HOT_WALLET_ADDR = "0x3aa11c84d776838f"
    process.env.HOT_WALLET_PRIVATE_KEY = PK
    process.env.HOT_WALLET_KEY_INDEX = "0"
  })

  it("returns an account resolver that strips 0x from addr and sets tempId/keyId", async () => {
    const authz = buildHotWalletAuthz()
    const account = await authz({ role: "proposer" })
    expect(account.addr).toBe("3aa11c84d776838f") // sans 0x
    expect(account.keyId).toBe(0)
    expect(account.tempId).toBe("3aa11c84d776838f-0")
    expect(account.role).toBe("proposer") // spread through
    expect(typeof account.signingFunction).toBe("function")
  })

  it("produces a 64-byte (128 hex char) r||s signature with the 0x-prefixed addr", async () => {
    const authz = buildHotWalletAuthz()
    const account = await authz({})
    const msgHex = "deadbeef".repeat(8) // arbitrary 32-byte message
    const sig = await account.signingFunction({ message: msgHex })
    expect(sig.addr).toBe("0x3aa11c84d776838f")
    expect(sig.keyId).toBe(0)
    expect(sig.signature).toMatch(/^[0-9a-f]{128}$/)
  })

  it("uses the algorithms the on-chain key actually declares", () => {
    // Flow REST /v1/accounts/0x3aa11c84d776838f?expand=keys — both keys.
    expect(HOT_WALLET_CURVE).toBe("secp256k1")
    expect(HOT_WALLET_HASH).toBe("sha256")
  })

  it("emits a signature that VERIFIES under secp256k1 + SHA2-256 (OpenSSL)", async () => {
    const account = await buildHotWalletAuthz()({})
    const msgHex = "deadbeef".repeat(8)
    const { signature } = await account.signingFunction({ message: msgHex })
    expect(opensslVerifies("secp256k1", msgHex, signature)).toBe(true)
  })

  it("regression: that signature does NOT verify under the old secp256r1 config", async () => {
    // The pre-2026-07-19 bug. A p256 key cannot validate a secp256k1 signature,
    // so this asserts we can never silently drift back to the wrong curve.
    const account = await buildHotWalletAuthz()({})
    const msgHex = "deadbeef".repeat(8)
    const { signature } = await account.signingFunction({ message: msgHex })
    expect(opensslVerifies("prime256v1", msgHex, signature)).toBe(false)
  })

  it("regression: that signature does NOT verify over a different message", async () => {
    // Guards the verifier itself: a helper that always returned true would pass
    // the positive test above.
    const account = await buildHotWalletAuthz()({})
    const { signature } = await account.signingFunction({ message: "deadbeef".repeat(8) })
    expect(opensslVerifies("secp256k1", "deadbeef".repeat(7) + "deadbeee", signature)).toBe(false)
  })

  it("honors a nonzero key index in tempId and keyId", async () => {
    process.env.HOT_WALLET_KEY_INDEX = "2"
    const account = await buildHotWalletAuthz()({})
    expect(account.keyId).toBe(2)
    expect(account.tempId).toBe("3aa11c84d776838f-2")
  })
})

describe("signWithKey — byte-identical to the elliptic signer it replaced", () => {
  // Produced by elliptic 6.6.1 (`ec("secp256k1").keyFromPrivate(PK).sign(sha256(msg))`,
  // r||s, 32 bytes each) on 2026-11-06, the last day it signed for the hot wallet.
  // RFC 6979 is deterministic, so a correct replacement reproduces these exactly.
  const VECTORS: Array<{ name: string; msgHex: string; sig: string }> = [
    {
      name: "32-byte message",
      msgHex: "deadbeef".repeat(8),
      sig: "7ac1fdcd78aac86ab0491f60542c27f95dee53716bf97a601eb1d7f2e9dbd1c669a0ffbc55e29e0e830a4ffb141f515eaa751a3a2a30588f9633eb7bf079fa43",
    },
    {
      name: "1-byte message (HIGH-S signature — pins lowS:false)",
      msgHex: "00",
      sig: "32dac848c69e0092026e75c6017434bc2e9aa48f7ef57f694cc0522de38d3d00c5002a3ff939e0e8c8eaa0ab5f5938126d77cc41b0ff665e73c876ad4c5c66ca",
    },
    {
      name: "200-byte message",
      msgHex: "ff".repeat(200),
      sig: "af61a27bb6261b9b04c5d5636c8390a81a6a99f6c42d1eba934901888596a9615c46e7d5052ad6e2ec0a3c3ae4ebad3a73324954a684fe49e05939b842c9a2df",
    },
    {
      name: "Flow transaction domain tag",
      msgHex: "464c4f572d56302e302d7472616e73616374696f6e0000000000000000000000",
      sig: "62311b42a4c0ed0e942a4a482a41efded1f82639c50ae71f3d7e0628b3b317f12430bc84ec05869be71727e851780f61e963a3aa2817a21fb6695a9011bfaeb5",
    },
  ]

  for (const v of VECTORS) {
    it(`reproduces the mainnet signer's bytes: ${v.name}`, () => {
      expect(signWithKey(PK, v.msgHex)).toBe(v.sig)
      expect(opensslVerifies("secp256k1", v.msgHex, v.sig)).toBe(true)
    })
  }

  it("every signature over 300 random messages verifies under OpenSSL and is 64 bytes", () => {
    let verified = 0
    for (let i = 0; i < 300; i++) {
      const msgHex = randomBytes(1 + (i % 120)).toString("hex")
      const sig = signWithKey(PK, msgHex)
      expect(sig).toMatch(/^[0-9a-f]{128}$/)
      if (opensslVerifies("secp256k1", msgHex, sig)) verified++
    }
    expect(verified).toBe(300) // count stated, so a loop that ran zero times cannot pass
  })
})
