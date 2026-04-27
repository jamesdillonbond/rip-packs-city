import type { Metadata } from "next"
import Link from "next/link"
import { getCollection, publishedCollections, type Collection } from "@/lib/collections"
import { CollectionTabBar } from "@/components/collection-tab-bar"
import { collectionLayoutMetadata, collectionPageJsonLd } from "@/lib/seo"
import ActiveCollectionSync from "./ActiveCollectionSync"
import CollectionSwitcher from "@/components/CollectionSwitcher"
import WalletHydrator from "@/components/WalletHydrator"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const params = await props.params
  return collectionLayoutMetadata(params.collection)
}

// ── Layout — renders ticker, breadcrumb, collection header, tabs ──────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionSegmentLayout(props: any) {
  const params = await props.params
  const collectionId: string = params?.collection ?? ""
  const collection = getCollection(collectionId)

  // Unknown collection → fall back to first published collection
  if (!collection) {
    const fallback = publishedCollections()[0]
    return (
      <div data-collection={fallback.id}>
        <ActiveCollectionSync collectionId={fallback.id} />
        <CollectionTicker collection={fallback} />
        <CollectionBanner collection={fallback} />
        <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
          {props.children}
        </main>
      </div>
    )
  }

  // Unpublished collection → show "Coming Soon" in the layout shell
  if (!collection.published) {
    return (
      <div data-collection={collection.id}>
        <ActiveCollectionSync collectionId={collection.id} />
        <CollectionTicker collection={collection} />
        <CollectionBanner collection={collection} />
        <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "80px 24px" }}>
            <div style={{ fontSize: 56, marginBottom: 20 }}>{collection.icon}</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 28, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase", marginBottom: 12 }}>
              {collection.label}
            </div>
            <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.7, maxWidth: 480, marginBottom: 32 }}>
              {"We\u2019re building something great for " + collection.label + " \u2014 check back soon."}
            </div>
            <Link href="/nba-top-shot/overview" style={{ display: "inline-block", padding: "10px 24px", background: "#E03A2F", borderRadius: 6, color: "#fff", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none" }}>
              Back to NBA Top Shot
            </Link>
          </div>
        </main>
      </div>
    )
  }

  // CollectionPage + BreadcrumbList JSON-LD for every page under
  // /[collection]/*. Inlined as a <script> so search engines consume it on
  // SSR — Google's Rich Results Test will validate against this exact block.
  const jsonLd = collectionPageJsonLd(collection.id)

  return (
    <div data-collection={collection.id}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ActiveCollectionSync collectionId={collection.id} />
      <WalletHydrator />
      <CollectionTicker collection={collection} />
      <CollectionBanner collection={collection} />
      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
        {props.children}
      </main>
    </div>
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
  "nfl-all-day": [
    "⚡ COLLECTION ANALYZER — FMV + marketplace asks + badge intel",
    "⚡ PACK EV CALCULATOR — expected value vs drop price",
    "⚡ SNIPER — live deals below FMV",
    "⚡ BADGE TRACKER — Debut · Fresh · Rookie Year premiums",
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
  "panini-blockchain": [
    "🃏 ETHEREUM BRIDGE LIVE — Panini cards now on-chain",
    "⚡ MARKET SNIPER — live OpenSea floor + listings",
    "🃏 BASKETBALL · FOOTBALL · SOCCER · WNBA · RACING",
    "⚡ WALLET ANALYZER — coming soon for bridged cards",
  ],
}

function CollectionTicker({ collection }: { collection: Collection }) {
  const items = TICKER_ITEMS[collection.id] ?? TICKER_ITEMS["nba-top-shot"] ?? [`⚡ ${collection.label.toUpperCase()} — COLLECTOR INTELLIGENCE`]
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

        <CollectionSwitcher activeCollectionId={collection.id} />

        <CollectionTabBar collection={collection} />
      </div>
    </div>
  )
}
