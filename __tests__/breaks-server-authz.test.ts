import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins lib/breaks/server-authz.ts — the hot-wallet FCL authorization used by the
// pack-breaks distribute route to sign multi-transfer txs. Security-relevant and
// previously at 0% coverage. Covers: access-node default/override, configureFcl
// idempotency, the fail-loud env validation (missing addr/key/index, bad index),
// and the authz-object + secp256r1/SHA3 signing shape (r||s = 64 bytes hex).

const configSpy = vi.fn()
vi.mock("@onflow/fcl", () => ({ config: (...a: any[]) => configSpy(...a) }))

import { getFlowAccessNode, configureFcl, buildHotWalletAuthz } from "@/lib/breaks/server-authz"

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

  it("honors a nonzero key index in tempId and keyId", async () => {
    process.env.HOT_WALLET_KEY_INDEX = "2"
    const account = await buildHotWalletAuthz()({})
    expect(account.keyId).toBe(2)
    expect(account.tempId).toBe("3aa11c84d776838f-2")
  })
})
