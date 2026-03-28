import { notFound } from "next/navigation"
import Link from "next/link"
import { getPublishedCollection, type Collection } from "@/lib/collections"
import { CollectionTabBar } from "@/components/collection-tab-bar"

interface Props {
  children: React.ReactNode
  params: Promise<{ collection: string }>
}

export default async function CollectionLayout({ children, params }: Props) {
  const { collection: collectionId } = await params
  const collection = getPublishedCollection(collectionId)
  if (!collection) notFound()

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        @keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        input::placeholder{color:rgba(255,255,255,0.25)!important;}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#111}
        ::-webkit-scrollbar-thumb{background:rgba(224,58,47,0.3);border-radius:2px}
        @media(max-width:768px){
          .rpc-main{padding:16px 16px 60px!important;}
          .rpc-coll-tabs{overflow-x:auto;}
        }
        .rpc-coll-tab:hover{background:rgba(255,255,255,0.06)!important;color:#fff!important;}
      `}</style>

      <CollectionTicker collection={collection} />
      <CollectionHeader collection={collection} />
      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
        {children}
      </main>
    </div>
  )
}

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

function CollectionHeader({ collection }: { collection: Collection }) {
  const chainLabel: Record<string, string> = {
    flow: "Flow", evm: "EVM", panini: "Panini Chain",
    candy: "Root Network", rwa: "Multi-Chain",
  }

  return (
    <>
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, textDecoration: "none" }}>
            <svg width="28" height="28" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" fill="none" stroke="#E03A2F" strokeWidth="4" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(0 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(72 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(144 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(216 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(288 50 50)" />
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <div>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 17, letterSpacing: "0.06em", color: "#F1F1F1", lineHeight: 1, textTransform: "uppercase" }}>
                Rip Packs <span style={{ color: "#E03A2F" }}>City</span>
              </div>
              <div style={{ fontSize: 7, fontFamily: "'Share Tech Mono', monospace", letterSpacing: "0.2em", color: "rgba(224,58,47,0.5)" }}>@RIPPACKSCITY</div>
            </div>
          </Link>
          <div style={{ flex: 1 }} />
          <Link href="/profile" style={{ background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.4)", color: "#E03A2F", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}>
            Profile
          </Link>
        </div>
      </header>

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
    </>
  )
}