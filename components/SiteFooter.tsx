import Link from "next/link";
import RpcLogo from "@/components/RpcLogo";

export default function SiteFooter() {
  return (
    <footer
      style={{
        background: "var(--rpc-surface)",
        borderTop: "1px solid var(--rpc-border)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm)",
        color: "var(--rpc-text-muted)",
      }}
    >
      <div
        style={{
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          padding: "24px 24px 16px",
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: 24,
        }}
      >
        {/* Left — Logo + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <RpcLogo size={28} />
          <div>
            <div
              style={{
                fontSize: "var(--text-xs)",
                letterSpacing: "0.15em",
                color: "var(--rpc-text-ghost)",
                marginTop: 2,
              }}
            >
              COLLECTOR INTELLIGENCE PLATFORM
            </div>
          </div>
        </div>

        {/* Center — Community tagline */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--rpc-text-secondary)",
            letterSpacing: "0.08em",
            fontSize: "var(--text-xs)",
          }}
        >
          BUILT FOR COLLECTORS, BY COLLECTORS
        </span>

        {/* Right — Social + Flow badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, justifyContent: "flex-end" }}>
          <a
            href="https://twitter.com/RipPacksCity"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "var(--rpc-text-muted)",
              textDecoration: "none",
              letterSpacing: "0.1em",
              fontSize: "var(--text-xs)",
            }}
          >
            @RIPPACKSCITY
          </a>
          <span
            style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-sm)",
              padding: "2px 8px",
              fontSize: "var(--text-xs)",
              letterSpacing: "0.1em",
              color: "var(--rpc-text-ghost)",
            }}
          >
            BUILT ON FLOW
          </span>
        </div>
      </div>

      {/* Bottom strip */}
      <div
        style={{
          borderTop: "1px solid var(--rpc-border)",
          padding: "10px 24px",
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "var(--text-xs)",
          color: "var(--rpc-text-ghost)",
          letterSpacing: "0.1em",
        }}
      >
        <span>&copy; 2026 RIP PACKS CITY</span>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Link href="/about" style={{ color: "var(--rpc-text-ghost)", textDecoration: "none" }}>ABOUT</Link>
          <Link href="/pricing" style={{ color: "var(--rpc-text-ghost)", textDecoration: "none" }}>PRICING</Link>
          <Link href="/legal/fmv-methodology" style={{ color: "var(--rpc-text-ghost)", textDecoration: "none" }}>FMV METHODOLOGY</Link>
          <Link href="/terms" style={{ color: "var(--rpc-text-ghost)", textDecoration: "none" }}>TERMS</Link>
          <Link href="/privacy" style={{ color: "var(--rpc-text-ghost)", textDecoration: "none" }}>PRIVACY</Link>
        </div>
      </div>

      {/* FMV disclaimer strip — surfaces "not investment advice" globally
          per the Phase 1 legal review. Same copy + methodology link as the
          inline FmvDisclaimer component used on per-page price displays;
          this footer placement is the catch-all so the disclosure fires on
          every surface even if a specific tile drops the inline variant. */}
      <div
        style={{
          borderTop: "1px solid var(--rpc-border)",
          padding: "10px 24px",
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          fontSize: "var(--text-xs)",
          color: "var(--rpc-text-ghost)",
          letterSpacing: "0.06em",
          textAlign: "center",
        }}
      >
        FMV is for informational purposes only — not investment advice. Marketplaces are
        volatile; past prices do not predict future prices. {" "}
        <Link href="/legal/fmv-methodology" style={{ color: "var(--rpc-text-muted)", textDecoration: "underline", textDecorationStyle: "dotted" }}>
          How is FMV calculated?
        </Link>
      </div>

      <div
        style={{
          padding: "8px 24px 12px",
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--rpc-text-muted)",
          textAlign: "center",
        }}
      >
        Built in <span style={{ color: "var(--rpc-red)" }}>Rip City</span> by an official Trail Blazers Team Captain.
      </div>
    </footer>
  );
}
