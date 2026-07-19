// Currency derivation for pack-events-ingest, extracted from index.ts so the
// vault-type → currency mapping can be unit-tested. Mislabeling the currency
// (DUC vs USDC vs FLOW) silently corrupts how every pack sale's price is read
// downstream, so the mapping deserves its own pins. Pure; index.ts imports it.

export function deriveCurrency(vaultTypeId: string | undefined): string {
  if (!vaultTypeId) return "UNKNOWN"
  const trimmed = vaultTypeId.replace(/\.Vault$/, "")
  const idx = trimmed.lastIndexOf(".")
  const contract = idx >= 0 ? trimmed.slice(idx + 1) : trimmed
  switch (contract) {
    case "DapperUtilityCoin":
      return "DUC"
    case "FlowToken":
      return "FLOW"
    case "FiatToken":
      return "USDC"
    default:
      return contract
  }
}
