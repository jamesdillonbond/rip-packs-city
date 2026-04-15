import Link from "next/link"
import { CartButton } from "@/components/cart/CartButton"
import { ProBadge } from "@/components/auth/ProBadge"
import SupportChatConnected from "@/components/SupportChatConnected"
import SiteFooter from "@/components/SiteFooter"
import MobileNav from "@/components/MobileNav"

// ── Layout ─────────────────────────────────────────────────────────────────────
// This layout provides the outer shell (styles, sticky header, footer).
// Collection-specific UI (ticker, breadcrumb, header, tabs) is rendered
// by the [collection]/layout.tsx which has access to params.collection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionLayout(props: any) {
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
          .rpc-main{padding:16px 16px 80px!important;}
          .rpc-coll-tabs{overflow-x:auto;}
          .rpc-chat-fab{bottom:76px!important;}
        }
        .rpc-coll-tab:hover{background:rgba(255,255,255,0.06)!important;color:#fff!important;}
      `}</style>

      <SiteHeader />
      {props.children}
      <SiteFooter />
      <SupportChatConnected />
      <MobileNav />
    </div>
  )
}

// ── Site-wide sticky header (no collection dependency) ────────────────────────
function SiteHeader() {
  return (
    <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16, overflow: "hidden" }}>
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
        <ProBadge />
        <CartButton />
        <Link href="/profile" style={{ background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.4)", color: "#E03A2F", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none", flexShrink: 0, maxWidth: 80 }}>
          Profile
        </Link>
      </div>
    </header>
  )
}
