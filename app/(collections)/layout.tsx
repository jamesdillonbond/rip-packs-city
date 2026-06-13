import Link from "next/link"
import { ProBadge } from "@/components/auth/ProBadge"
import SignOutButton from "@/components/auth/SignOutButton"
import SupportChatConnected from "@/components/SupportChatConnected"
import SiteFooter from "@/components/SiteFooter"
import MobileNav from "@/components/MobileNav"
import RpcLogo from "@/components/RpcLogo"
import TopNav from "@/components/TopNav"
import ThemeToggle from "@/components/ThemeToggle"

// ── Layout ─────────────────────────────────────────────────────────────────────
// This layout provides the outer shell (styles, sticky header, footer).
// Collection-specific UI (ticker, breadcrumb, header, tabs) is rendered
// by the [collection]/layout.tsx which has access to params.collection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionLayout(props: any) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        @keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes rpc-spin{to{transform:rotate(360deg)}}
        input::placeholder{color:var(--rpc-text-ghost)!important;}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:var(--rpc-surface)}
        ::-webkit-scrollbar-thumb{background:rgba(224,58,47,0.3);border-radius:2px}
        @media(max-width:768px){
          .rpc-main{padding:16px 16px 80px!important;}
          .rpc-coll-tabs{overflow-x:auto;}
          .rpc-chat-fab{bottom:76px!important;}
        }
        .rpc-coll-tab:hover{background:var(--rpc-surface-hover)!important;color:var(--rpc-text-primary)!important;}
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
    <header style={{ background: "var(--rpc-header-bg)", borderBottom: "1px solid var(--rpc-border-subtle)", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16, overflow: "hidden" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, textDecoration: "none" }}>
          <RpcLogo size={36} />
          <div>
            <div style={{ fontSize: 7, fontFamily: "var(--font-mono)", letterSpacing: "0.2em", color: "var(--rpc-red-muted)" }}>@RIPPACKSCITY</div>
          </div>
        </Link>
        <TopNav />
        <div style={{ flex: 1 }} />
        <ThemeToggle />
        <ProBadge />
        <SignOutButton />
      </div>
    </header>
  )
}
