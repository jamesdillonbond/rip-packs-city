import { describe, it, expect } from "vitest"
import { deriveCurrency } from "../workers/pack-events-ingest/currency"

// Pins the vault-type → currency mapping for pack sales. A mislabel here (e.g.
// FiatToken read as its raw contract name instead of USDC) silently changes how
// every pack sale price is interpreted downstream, so each branch is asserted.

describe("deriveCurrency", () => {
  it("maps the three known Dapper vaults to their canonical currency codes", () => {
    expect(deriveCurrency("A.ead892083b3e2c6c.DapperUtilityCoin.Vault")).toBe("DUC")
    expect(deriveCurrency("A.1654653399040a61.FlowToken.Vault")).toBe("FLOW")
    expect(deriveCurrency("A.b19436aae4d94622.FiatToken.Vault")).toBe("USDC")
  })

  it("strips the trailing .Vault and returns the bare contract name for unknown vaults", () => {
    expect(deriveCurrency("A.abc.SomeToken.Vault")).toBe("SomeToken")
  })

  it("handles a type id without a .Vault suffix", () => {
    expect(deriveCurrency("A.1654653399040a61.FlowToken")).toBe("FLOW")
  })

  it("handles a bare contract name with no dots", () => {
    expect(deriveCurrency("FlowToken")).toBe("FLOW")
    expect(deriveCurrency("Mystery")).toBe("Mystery")
  })

  it("returns UNKNOWN for an undefined or empty vault type", () => {
    expect(deriveCurrency(undefined)).toBe("UNKNOWN")
    expect(deriveCurrency("")).toBe("UNKNOWN")
  })
})
