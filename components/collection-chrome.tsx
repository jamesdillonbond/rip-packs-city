// components/collection-chrome.tsx
//
// Shared collection header chrome (ticker + breadcrumb/header/tabs banner) used by
// BOTH the generic /[collection]/layout.tsx and the bespoke Disney Pinnacle layout
// (which serves the Pinnacle collection + sniper tabs from their own page dirs).
// Extracted 2026-07-17 (H3) so the header/ticker is byte-identical across every
// tab — previously the Pinnacle layout hardcoded dark hex and omitted the
// CollectionSwitcher, so the header visibly re-skinned when switching tabs.

import Link from "next/link"
import { type Collection } from "@/lib/collections"
import { CollectionTabBar } from "@/components/collection-tab-bar"
import CollectionSwitcher from "@/components/CollectionSwitcher"
import CollectionHeading from "@/components/CollectionHeading"
import AnonSignInPill from "@/components/AnonSignInPill"

// ── Ticker ─────────────────────────────────────────────────────────────────────
const TICKER_ITEMS: Record<string, string[]> = {
  "nba-top-shot": [
    "⚡ COLLECTION ANALYZER — FMV + marketplace asks + badge intel",
    "⚡ PACK EV CALCULATOR — expected value vs price",
    "⚡ SNIPER — real-time deals below FMV",
    "⚡ BADGE FILTERS — filter any view by Top Shot Debut · Fresh · Rookie Year",
    "⚡ SET TRACKER — completion + bottleneck finder",
  ],
  "nfl-all-day": [
    "⚡ COLLECTION ANALYZER — FMV + marketplace asks + badge intel",
    "⚡ PACK EV CALCULATOR — expected value vs drop price",
    "⚡ SNIPER — live deals below FMV",
    "⚡ BADGE FILTERS — Debut · Fresh · Rookie Year, on any view",
    "⚡ SET TRACKER — completion progress + bottleneck finder",
  ],
  "disney-pinnacle": [
    "✨ COLLECTION ANALYZER — FMV + active listing prices",
    "✨ SNIPER — pins priced below market",
    "✨ MARKET — sortable feed of every listing, filter by variant",
    "✨ ANALYTICS — tier + franchise volume trends",
    "✨ THIN-VOLUME MODEL — relative deal scoring for Pinnacle-scale liquidity",
  ],
  "laliga-golazos": [
    "⚽ COLLECTION ANALYZER — relative deal scoring + FMV",
    "⚽ SNIPER — floor deals with 100x-floor outlier filter",
    "⚽ MARKET — sort every listing by discount, price, or recency",
    "⚽ ANALYTICS — tier + club volume trends",
    "⚽ FMV COVERAGE — growing from real Flow sales data",
  ],
  "ufc": [
    "⚡ COLLECTION ANALYZER — FMV + active listing prices",
    "⚡ SNIPER — fight moments below market",
    "⚡ ANALYTICS — portfolio tracking",
  ],
  "candy-mlb": [
    "⚾ CANDY MLB ON SOLANA — 125 editions, every one priced",
    "⚾ FMV FROM REAL SALES — the highest sales-backed share on the platform",
    "⚾ LIVE BOARD — floors, asks and 24h sales on the Candy MLB insights board",
    "⚾ WALLET + PACK TOOLS — coming behind this overview",
  ],
  "panini-blockchain": [
    "🃏 ETHEREUM BRIDGE LIVE — Panini cards now on-chain",
    "⚡ MARKET SNIPER — live OpenSea floor + listings",
    "🃏 BASKETBALL · FOOTBALL · SOCCER · WNBA · RACING",
    "⚡ WALLET ANALYZER — coming soon for bridged cards",
  ],
}

export function CollectionTicker({ collection }: { collection: Collection }) {
  const items = TICKER_ITEMS[collection.id] ?? TICKER_ITEMS["nba-top-shot"] ?? [`⚡ ${collection.label.toUpperCase()} — COLLECTOR INTELLIGENCE`]
  const doubled = [...items, ...items]
  return (
    <div style={{ background: "var(--rpc-surface)", borderBottom: "1px solid rgba(224,58,47,0.2)", overflow: "hidden", height: 28, display: "flex", alignItems: "center" }}>
      {/* brand-exception: white "LIVE" text on the red pill — theme-independent */}
      <div style={{ background: "var(--rpc-red)", padding: "0 12px", fontSize: 9, fontFamily: "var(--font-mono)", letterSpacing: "0.15em", color: "#fff", height: "100%", display: "flex", alignItems: "center", flexShrink: 0, fontWeight: 700 }}>LIVE</div>
      <div style={{ overflow: "hidden", flex: 1 }}>
        <div style={{ display: "flex", gap: 64, animation: "ticker 38s linear infinite", whiteSpace: "nowrap", paddingLeft: 24 }}>
          {doubled.map((item, i) => (
            <span key={i} style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)", letterSpacing: "0.07em" }}>{item}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Collection banner (breadcrumb + header + tabs) ────────────────────────────
export function CollectionBanner({ collection }: { collection: Collection }) {
  // Keyed on the ROADMAP tag (`chain`) with `dbChain` winning when it names a
  // real network: "candy" once mapped to "Root Network", which the registry
  // records as dead — Candy is Solana (2026-09-06 go-live).
  const chainLabel: Record<string, string> = {
    flow: "Flow", evm: "EVM", panini: "Panini Chain",
    candy: "Solana", rwa: "Multi-Chain",
    solana: "Solana", ethereum: "Ethereum", polygon: "Polygon", flow_evm: "Flow EVM",
  }

  return (
    <div style={{ background: "var(--rpc-header-bg)", borderBottom: `1px solid ${collection.accent}33` }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ padding: "10px 0 0", display: "flex", alignItems: "center", gap: 6 }}>
          <Link href="/" style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)", letterSpacing: "0.1em", textDecoration: "none" }}>RPC</Link>
          <span style={{ color: "var(--rpc-text-ghost)", fontSize: 10 }}>›</span>
          <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)", letterSpacing: "0.1em" }}>{collection.label}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0 0" }}>
          <span style={{ fontSize: 22 }}>{collection.icon}</span>
          {collection.badge && (
            <span
              style={{
                background: `${collection.badge === "ALPHA" ? "var(--rpc-red)" : collection.accent}33`,
                color: "var(--rpc-text-primary)",
                border: `1px solid ${collection.badge === "ALPHA" ? "var(--rpc-red)" : collection.accent}66`,
                borderRadius: 4,
                padding: "2px 6px",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
              }}
            >
              {collection.badge}
            </span>
          )}
          <div>
            {/* Renders an <h1> on the tab routes (which shipped zero headings of any
                level) and a plain styled <div> on the entity routes beneath them, which
                already own a specific h1. Visible output is identical either way — see
                components/CollectionHeading.tsx for the full rationale. */}
            <CollectionHeading collection={collection} />
            <div style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)", letterSpacing: "0.15em", marginTop: 2 }}>
              {collection.partner} · {collection.sport}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <AnonSignInPill />
            <div style={{ background: `${collection.accent}18`, border: `1px solid ${collection.accent}44`, borderRadius: 4, padding: "2px 8px", fontSize: 9, fontFamily: "var(--font-mono)", color: collection.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {(collection.dbChain && chainLabel[collection.dbChain]) ?? chainLabel[collection.chain] ?? collection.chain}
            </div>
          </div>
        </div>

        <CollectionSwitcher activeCollectionId={collection.id} />

        <CollectionTabBar collection={collection} />
      </div>
    </div>
  )
}
