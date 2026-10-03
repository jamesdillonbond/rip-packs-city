import SupportChatConnected from "@/components/SupportChatConnected"
import SiteFooter from "@/components/SiteFooter"
import GlobalSiteHeader from "@/components/GlobalSiteHeader"

// ── Layout ─────────────────────────────────────────────────────────────────────
// This layout provides the outer shell (styles, sticky header, footer).
// Collection-specific UI (ticker, breadcrumb, header, tabs) is rendered
// by the [collection]/layout.tsx which has access to params.collection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionLayout(props: any) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <style>{`
        /* 2026-10-03: this reset MUST sit in @layer base. Unlayered, it outranks every Tailwind utility
           (cascade layers lose to unlayered rules regardless of specificity), so p-*/m-* classes
           rendered as 0 on every page under it. Tailwind preflight already carries the same reset
           in @layer base; this keeps the declaration where it was, in the layer it must be in. */
        @layer base{*{box-sizing:border-box;margin:0;padding:0;}}
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

      <GlobalSiteHeader />
      {props.children}
      <SiteFooter />
      <SupportChatConnected />
    </div>
  )
}
