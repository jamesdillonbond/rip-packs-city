import type { Metadata } from "next"
import Link from "next/link"
import { getCollection, type Collection } from "@/lib/collections"
import { CollectionTabBar } from "@/components/collection-tab-bar"

const PINNACLE_META = {
  title: "Disney Pinnacle Analytics — Rip Packs City",
  description:
    "Live marketplace sniper and analytics for Disney Pinnacle digital pins on the Flow blockchain.",
}

export const metadata: Metadata = {
  title: PINNACLE_META.title,
  description: PINNACLE_META.description,
  alternates: { canonical: "https://rip-packs-city.vercel.app/disney-pinnacle" },
  openGraph: {
    title: PINNACLE_META.title,
    description: PINNACLE_META.description,
    url: "https://rip-packs-city.vercel.app/disney-pinnacle",
    siteName: "Rip Packs City",
    type: "website",
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function PinnacleLayout(props: any) {
  // Use getCollection (not getPublishedCollection) since Pinnacle is unpublished
  const collection = getCollection("disney-pinnacle")!

  return (
    <>
      <PinnacleTicker />
      <PinnacleBanner collection={collection} />
      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
        {props.children}
      </main>
    </>
  )
}

function PinnacleTicker() {
  const items = [
    "✨ DISNEY PINNACLE — Live pin deals from Flowty",
    "✨ SNIPER — cheapest pins sorted by price",
    "✨ CHASERS · LOCKED PINS · VARIANT TRACKING",
  ]
  const doubled = [...items, ...items]
  return (
    <div style={{ background: "#0D0D0D", borderBottom: "1px solid rgba(168,85,247,0.2)", overflow: "hidden", height: 28, display: "flex", alignItems: "center" }}>
      <div style={{ background: "#A855F7", padding: "0 12px", fontSize: 9, fontFamily: "'Share Tech Mono', monospace", letterSpacing: "0.15em", color: "#fff", height: "100%", display: "flex", alignItems: "center", flexShrink: 0, fontWeight: 700 }}>LIVE</div>
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

function PinnacleBanner({ collection }: { collection: Collection }) {
  return (
    <div style={{ background: "rgba(13,13,13,0.98)", borderBottom: `1px solid ${collection.accent}33` }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ padding: "10px 0 0", display: "flex", alignItems: "center", gap: 6 }}>
          <Link href="/" style={{ fontSize: 10, fontFamily: "'Share Tech Mono', monospace", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textDecoration: "none" }}>RPC</Link>
          <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 10 }}>›</span>
          <span style={{ fontSize: 10, fontFamily: "'Share Tech Mono', monospace", color: "rgba(255,255,255,0.55)", letterSpacing: "0.1em" }}>Disney Pinnacle</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0 0" }}>
          <span style={{ fontSize: 22 }}>✨</span>
          <div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 20, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase", lineHeight: 1 }}>
              Disney Pinnacle
            </div>
            <div style={{ fontSize: 9, fontFamily: "'Share Tech Mono', monospace", color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", marginTop: 2 }}>
              Dapper Labs · Entertainment
            </div>
          </div>
          <div style={{ marginLeft: "auto", background: `${collection.accent}18`, border: `1px solid ${collection.accent}44`, borderRadius: 4, padding: "2px 8px", fontSize: 9, fontFamily: "'Share Tech Mono', monospace", color: collection.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Flow
          </div>
        </div>

        <CollectionTabBar collection={collection} />
      </div>
    </div>
  )
}
