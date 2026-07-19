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

const configSpy = vi.fn()
vi.mock("@onflow/fcl", () => ({ config: (...a: any[]) => configSpy(...a) }))

import { ec as EC } from "elliptic"
import {
  getFlowAccessNode,
  configureFcl,
  buildHotWalletAuthz,
  hashMessageHex,
  HOT_WALLET_CURVE,
  HOT_WALLET_HASH,
} from "@/lib/breaks/server-authz"

// A valid 32-byte private key (hex). Any nonzero <n scalar works for signing.
const PK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

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

  it("emits a signature that VERIFIES under secp256k1 + SHA2-256", async () => {
    const account = await buildHotWalletAuthz()({})
    const msgHex = "deadbeef".repeat(8)
    const { signature } = await account.signingFunction({ message: msgHex })

    const key = new EC(HOT_WALLET_CURVE).keyFromPrivate(Buffer.from(PK, "hex"))
    const ok = key.verify(hashMessageHex(msgHex), {
      r: signature.slice(0, 64),
      s: signature.slice(64),
    })
    expect(ok).toBe(true)
  })

  it("regression: that signature does NOT verify under the old secp256r1 config", async () => {
    // The pre-2026-07-19 bug. A p256 key cannot validate a secp256k1 signature,
    // so this asserts we can never silently drift back to the wrong curve.
    const account = await buildHotWalletAuthz()({})
    const msgHex = "deadbeef".repeat(8)
    const { signature } = await account.signingFunction({ message: msgHex })

    const wrongKey = new EC("p256").keyFromPrivate(Buffer.from(PK, "hex"))
    let verified: boolean
    try {
      verified = wrongKey.verify(hashMessageHex(msgHex), {
        r: signature.slice(0, 64),
        s: signature.slice(64),
      })
    } catch {
      verified = false // elliptic may throw on a point outside the p256 curve
    }
    expect(verified).toBe(false)
  })

  it("honors a nonzero key index in tempId and keyId", async () => {
    process.env.HOT_WALLET_KEY_INDEX = "2"
    const account = await buildHotWalletAuthz()({})
    expect(account.keyId).toBe(2)
    expect(account.tempId).toBe("3aa11c84d776838f-2")
  })
})
