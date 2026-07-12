import { describe, it, expect } from "vitest"
import { getExpectedChainId, SUPPORTED_CHAIN_SLUGS } from "@/lib/evm-rpc"

// EVM chain-id lookup for the Base/Flow-EVM parallel data plane (chain-two prep).
// Pin the chain ids so a proxy call can't be pointed at the wrong network.

describe("getExpectedChainId", () => {
  it("returns the correct chain id per supported slug", () => {
    expect(getExpectedChainId("flow_evm_mainnet")).toBe(747)
    expect(getExpectedChainId("base_mainnet")).toBe(8453)
  })
})

describe("SUPPORTED_CHAIN_SLUGS", () => {
  it("enumerates exactly the configured chains", () => {
    expect([...SUPPORTED_CHAIN_SLUGS].sort()).toEqual(["base_mainnet", "flow_evm_mainnet"])
  })
})
