import { describe, it, expect } from "vitest"
import {
  isCadenceAddress,
  isEvmAddress,
  isSolanaAddress,
  detectAddressChain,
  isSupportedAddress,
  chainKindForDbChain,
  isValidAddressForChain,
  normalizeAddress,
} from "@/lib/address"

// Chain-aware address validation. The load-bearing footgun: Solana base58 is
// CASE-SENSITIVE, so normalizeAddress must NOT lower-case it (a bare
// .toLowerCase() elsewhere would corrupt the wallet). Pin per-chain shapes +
// the chain dispatch.

const FLOW = "0xbd94cade097e50ac" // 0x + 16 hex
const EVM = "0x" + "a".repeat(40) // 0x + 40 hex
const SOL = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNP" // 38 chars, base58 alphabet

describe("per-chain shape validators", () => {
  it("isCadenceAddress: 0x + exactly 16 hex", () => {
    expect(isCadenceAddress(FLOW)).toBe(true)
    expect(isCadenceAddress("0x123")).toBe(false)
    expect(isCadenceAddress(EVM)).toBe(false)
  })

  it("isEvmAddress: 0x + exactly 40 hex", () => {
    expect(isEvmAddress(EVM)).toBe(true)
    expect(isEvmAddress(FLOW)).toBe(false)
  })

  it("isSolanaAddress: base58 32-44 chars, and never a 0x string", () => {
    expect(isSolanaAddress(SOL)).toBe(true)
    expect(isSolanaAddress(FLOW)).toBe(false) // 0x excluded by base58 alphabet
    expect(isSolanaAddress("tooShort")).toBe(false)
  })
})

describe("detectAddressChain / isSupportedAddress", () => {
  it("classifies each chain and unknown", () => {
    expect(detectAddressChain(FLOW)).toBe("cadence")
    expect(detectAddressChain(EVM)).toBe("evm")
    expect(detectAddressChain(SOL)).toBe("solana")
    expect(detectAddressChain("not-an-address!!")).toBe("unknown")
  })

  it("isSupportedAddress is true for any recognized chain", () => {
    expect(isSupportedAddress(FLOW)).toBe(true)
    expect(isSupportedAddress(SOL)).toBe(true)
    expect(isSupportedAddress("garbage")).toBe(false)
  })
})

describe("chainKindForDbChain", () => {
  it("maps the chain_type enum to an address kind", () => {
    expect(chainKindForDbChain("flow")).toBe("cadence")
    expect(chainKindForDbChain("ethereum")).toBe("evm")
    expect(chainKindForDbChain("polygon")).toBe("evm")
    expect(chainKindForDbChain("flow_evm")).toBe("evm")
    expect(chainKindForDbChain("solana")).toBe("solana")
    expect(chainKindForDbChain(null)).toBeNull()
    expect(chainKindForDbChain("unmapped")).toBeNull()
  })
})

describe("isValidAddressForChain", () => {
  it("validates against the collection's chain shape", () => {
    expect(isValidAddressForChain(FLOW, "flow")).toBe(true)
    expect(isValidAddressForChain(EVM, "flow")).toBe(false)
    expect(isValidAddressForChain(EVM, "ethereum")).toBe(true)
    expect(isValidAddressForChain(SOL, "solana")).toBe(true)
  })

  it("falls back to any-supported-address when the chain is unmapped", () => {
    expect(isValidAddressForChain(FLOW, null)).toBe(true)
    expect(isValidAddressForChain("garbage", null)).toBe(false)
  })
})

describe("normalizeAddress (the case-sensitivity footgun)", () => {
  it("lower-cases hex (Flow / EVM)", () => {
    expect(normalizeAddress("0xBD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
  })

  it("preserves Solana base58 case verbatim", () => {
    expect(normalizeAddress(SOL)).toBe(SOL) // NOT lower-cased
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeAddress("  0xBD94CADE097E50AC  ")).toBe("0xbd94cade097e50ac")
  })
})
