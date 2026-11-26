"use client"

// components/entity/UfcMomentChain.tsx
//
// Where ONE UFC Strike Moment lives (2026-11-26): a Flow or Aptos tag on the Moment's own page, from
// /api/ufc/moment-chain (the Aptos indexer is authoritative for whether this serial was minted on Aptos).
// Three states plus loading: Aptos (with Rarible + explorer links), Flow, or nothing at all — a failed
// or unmappable check renders NOTHING rather than guessing a chain.

import { useEffect, useState } from "react"
import ChainTag from "@/components/collection/ChainTag"

type Answer =
  | { chain: "aptos"; rarible_url: string | null; explorer_url: string; held_by_ufc: string | null }
  | { chain: "flow" }
  | { chain: null }

const box: React.CSSProperties = {
  marginTop: 4,
  padding: "10px 14px",
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderRadius: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--rpc-text-secondary)",
  maxWidth: 520,
}

export default function UfcMomentChain({ editionId, serial }: { editionId: string; serial: number }) {
  const key = editionId + ":" + serial
  const [res, setRes] = useState<{ key: string; answer: Answer | null } | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/ufc/moment-chain?edition=${encodeURIComponent(editionId)}&serial=${serial}`)
      .then(async (r) => {
        const answer = r.ok ? ((await r.json()) as Answer) : null
        if (live) setRes({ key, answer })
      })
      .catch(() => { if (live) setRes({ key, answer: null }) })
    return () => { live = false }
  }, [editionId, serial, key])

  const a = res && res.key === key ? res.answer : null
  if (!a || a.chain === null) return null
  if (a.chain === "flow") {
    return (
      <div role="note" style={box} data-testid="ufc-moment-chain">
        <ChainTag chain="flow" />{" "}
        This Moment lives on Flow, where UFC Strike trading closed in May 2026. It can trade again once its
        owner migrates it to Aptos through UFC Strike.
      </div>
    )
  }
  return (
    <div role="note" style={box} data-testid="ufc-moment-chain">
      <ChainTag chain="aptos" />{" "}
      This Moment lives on Aptos{a.held_by_ufc ? `, held by ${a.held_by_ufc}` : ""}.{" "}
      {a.rarible_url ? (
        <a href={a.rarible_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--rpc-text-primary)" }}>
          View on Rarible
        </a>
      ) : null}
      {a.rarible_url ? " · " : ""}
      <a href={a.explorer_url} target="_blank" rel="nofollow noopener noreferrer" style={{ color: "var(--rpc-text-primary)" }}>
        Aptos explorer
      </a>
    </div>
  )
}
