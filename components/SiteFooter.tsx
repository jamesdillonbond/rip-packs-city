import Link from "next/link";
import RpcLogo from "@/components/RpcLogo";
import { publishedCollections } from "@/lib/collections";

// Public Insights surfaces worth crawling — the highest-depth boards. Linked
// here so every page that mounts the footer (all ~18K entity pages, overview,
// home, etc.) passes internal link equity into the /insights hubs and the
// per-collection overviews. SEO internal-linking pass, 2026-06-05.
const INSIGHTS_LINKS: Array<{ href: string; label: string }> = [
  { href: "/insights", label: "All Insights" },
  { href: "/insights/squeeze", label: "Squeeze Board" },
  { href: "/insights/deals", label: "Below FMV" },
  { href: "/insights/first-mint", label: "First-Mint Trophies" },
  { href: "/insights/rookies", label: "Rookie Index" },
  { href: "/insights/market", label: "The RPC Index" },
  { href: "/insights/pack-reality", label: "Pack Reality" },
];

const FOOTER_LINK_STYLE: React.CSSProperties = {
  color: "var(--rpc-text-muted)",
  textDecoration: "none",
  fontSize: "var(--text-xs)",
  letterSpacing: "0.04em",
  lineHeight: 1.9,
};

export default function SiteFooter() {
  // Public per-collection front doors — derived from the registry so a newly
  // published collection appears automatically.
  const collectionLinks = publishedCollections().map((c) => ({
    href: `/${c.id}/overview`,
    label: c.label,
  }));

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
        className="rpc-footer-top"
        style={{
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          padding: "24px 24px 16px",
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

      {/* Explore — internal links into the public Insights hubs + per-collection
          overviews. Renders on every footer-bearing page so the entity corpus
          and the insights surfaces are reachable by a crawler from anywhere. */}
      <nav
        aria-label="Explore Rip Packs City"
        style={{
          borderTop: "1px solid var(--rpc-border)",
          padding: "18px 24px",
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 20,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "var(--rpc-text-ghost)",
              marginBottom: 8,
            }}
          >
            Insights
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {INSIGHTS_LINKS.map((l) => (
              <Link key={l.href} href={l.href} style={FOOTER_LINK_STYLE}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "var(--rpc-text-ghost)",
              marginBottom: 8,
            }}
          >
            Collections
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {collectionLinks.map((l) => (
              <Link key={l.href} href={l.href} style={FOOTER_LINK_STYLE}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </nav>

      {/* Bottom strip */}
      <div
        className="rpc-footer-bottom"
        style={{
          borderTop: "1px solid var(--rpc-border)",
          padding: "10px 24px",
          maxWidth: "var(--max-width)",
          margin: "0 auto",
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
        Built in <span style={{ color: "var(--rpc-red)" }}>Rip City</span> for the Flow collectibles community.
      </div>
    </footer>
  );
}
