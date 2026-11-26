// components/collection/ChainTag.tsx
//
// "Flow" / "Aptos" tag on one asset, listing or sale (2026-11-26, Trevor: "we give them a Flow or
// Aptos tag to identify where that asset lives or transaction happened"). Renders nothing when the
// row carries no chain — single-chain collections stay untagged.

import { CHAIN_LABEL, type AssetChain } from "@/lib/ufc-aptos"

export default function ChainTag({ chain, kind = "asset", detail }: { chain?: AssetChain | null; kind?: "asset" | "sale" | "listing"; detail?: string | null }) {
  if (!chain) return null
  // detail names the venue ("Rarible") — "Aptos · Rarible" on a sale or listing.
  const label = detail ? `${CHAIN_LABEL[chain]} · ${detail}` : CHAIN_LABEL[chain]
  const title = kind === "sale" ? `Sold on ${label}` : kind === "listing" ? `Listed on ${label}` : `Lives on ${label}`
  return (
    <span
      data-testid="chain-tag"
      data-chain={chain}
      title={title}
      aria-label={title}
      className="rounded px-1.5 py-0.5 shrink-0"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        lineHeight: 1.4,
        border: "1px solid var(--rpc-border)",
        color: "var(--rpc-text-secondary)",
        background: "var(--rpc-surface-raised)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  )
}
