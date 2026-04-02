import type { Metadata } from "next"
import Link from "next/link"
import { getCollection, getPublishedCollection, publishedCollections, type Collection } from "@/lib/collections"
import { CollectionTabBar } from "@/components/collection-tab-bar"

// ── Per-collection SEO metadata ────────────────────────────────────────────────
const COLLECTION_META: Record<string, { title: string; description: string }> = {
  "nba-top-shot": {
    title: "NBA Top Shot Analytics — Rip Packs City",
    description:
      "Wallet analysis, FMV pricing, set completion intelligence, pack EV, and live sniper deals for NBA Top Shot collectors on the Flow blockchain.",
  },
  "nfl-all-day": {
    title: "NFL All Day Analytics — Rip Packs City",
    description:
      "Wallet analysis, FMV pricing, and marketplace intelligence for NFL All Day collectors on the Flow blockchain.",
  },
}

const DEFAULT_META = {
  title: "Rip Packs City — Collector Intelligence",
  description:
    "The smartest analytics platform for NBA Top Shot and NFL All Day collectors. FMV pricing, set intelligence, pack EV, and a live marketplace sniper.",
}

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const params = await props.params
  const collection = getCollection(params.collection)
  if (!collection) return {}

  const meta = COLLECTION_META[collection.id] ?? DEFAULT_META
  const canonical = `https://rip-packs-city.vercel.app/${collection.id}`

  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical },
    keywords: [collection.label, collection.sport, "FMV", "moment value", "collector tools", "sniper deals", "Flow blockchain"],
    openGraph: {
      title: meta.title,
      description: meta.description,
      url: canonical,
      siteName: "Rip Packs City",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      site: "@rippackscity",
    },
  }
}

// ── Layout — renders ticker, breadcrumb, collection header, tabs ──────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionSegmentLayout(props: any) {
  const params = await props.params
  const collectionId: string = params?.collection ?? ""
  const collection = getPublishedCollection(collectionId)

  // Fallback to first published collection if not found
  const fallback = publishedCollections()[0]
  const col: Collection = collection ?? fallback

  return (
    <>
      <CollectionTicker collection={col} />
      <CollectionBanner collection={col} />
      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
        {props.children}
      </main>
    </>
  )
}

// ── Ticker ─────────────────────────────────────────────────────────────────────
const TICKER_ITEMS: Record<string, string[]> = {
  "nba-top-shot": [
    "⚡ COLLECTION ANALYZER — FMV + Flowty asks + badge intel",
    "⚡ PACK EV CALCULATOR — expected value vs price",
    "⚡ SNIPER — real-time deals below FMV",
    "⚡ BADGE TRACKER — Top Shot Debut · Fresh · Rookie Year",
    "⚡ SET TRACKER — completion + bottleneck finder",
  ],
}

function CollectionTicker({ collection }: { collection: Collection }) {
  const items = TICKER_ITEMS[collection.id] ?? [`⚡ ${collection.label.toUpperCase()} — COLLECTOR INTELLIGENCE`]
  const doubled = [...items, ...items]
  return (
    <div style={{ background: "#0D0D0D", borderBottom: "1px solid rgba(224,58,47,0.2)", overflow: "hidden", height: 28, display: "flex", alignItems: "center" }}>
      <div style={{ background: "#E03A2F", padding: "0 12px", fontSize: 9, fontFamily: "'Share Tech Mono', monospace", letterSpacing: "0.15em", color: "#fff", height: "100%", display: "flex", alignItems: "center", flexShrink: 0, fontWeight: 700 }}>LIVE</div>
      <div style={{ overflow: "hidden", flex: 1 }}>
        <div style={{ display: "flex", gap: 64, animation: "ticker 38s linear infinite", whiteSpace: "nowrap", paddingLeft: 24 }}>
          {doubled.map((item, i) => (
            <span key={i} style={{ fontSize: 10, fontFamily: "'Share Tech Mono', monospace", color: "rgba(255,255,255,0.45)", letterSpacing: "0.07em" }}>{item}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Collection banner (breadcrumb + header + tabs) ────────────────────────────
function CollectionBanner({ collection }: { collection: Collection }) {
  const chainLabel: Record<string, string> = {
    flow: "Flow", evm: "EVM", panini: "Panini Chain",
    candy: "Root Network", rwa: "Multi-Chain",
  }

  return (
    <div style={{ background: "rgba(13,13,13,0.98)", borderBottom: `1px solid ${collection.accent}33` }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ padding: "10px 0 0", display: "flex", alignItems: "center", gap: 6 }}>
          <Link href="/" style={{ fontSize: 10, fontFamily: "'Share Tech Mono', monospace", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textDecoration: "none" }}>RPC</Link>
          <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 10 }}>›</span>
          <span style={{ fontSize: 10, fontFamily: "'Share Tech Mono', monospace", color: "rgba(255,255,255,0.55)", letterSpacing: "0.1em" }}>{collection.label}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0 0" }}>
          <span style={{ fontSize: 22 }}>{collection.icon}</span>
          <div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 20, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase", lineHeight: 1 }}>
              {collection.label}
            </div>
            <div style={{ fontSize: 9, fontFamily: "'Share Tech Mono', monospace", color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", marginTop: 2 }}>
              {collection.partner} · {collection.sport}
            </div>
          </div>
          <div style={{ marginLeft: "auto", background: `${collection.accent}18`, border: `1px solid ${collection.accent}44`, borderRadius: 4, padding: "2px 8px", fontSize: 9, fontFamily: "'Share Tech Mono', monospace", color: collection.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            {chainLabel[collection.chain] ?? collection.chain}
          </div>
        </div>

        <CollectionTabBar collection={collection} />
      </div>
    </div>
  )
}
