import Link from "next/link";

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
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 900,
                fontSize: 14,
                letterSpacing: "0.06em",
                color: "var(--rpc-text-primary)",
                textTransform: "uppercase",
                lineHeight: 1,
              }}
            >
              Rip Packs <span style={{ color: "var(--rpc-red)" }}>City</span>
            </div>
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

        {/* Center — Team Captain credential */}
        <a
          href="https://nbatopshot.com/team/portland-trail-blazers"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--rpc-text-secondary)",
            textDecoration: "none",
            letterSpacing: "0.08em",
            fontSize: "var(--text-xs)",
          }}
        >
          <span style={{ color: "var(--rpc-success)" }}>✓</span>
          OFFICIAL PORTLAND TRAIL BLAZERS TEAM CAPTAIN
        </a>

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
        <div style={{ display: "flex", gap: 16 }}>
          <Link href="/" style={{ color: "var(--rpc-text-ghost)", textDecoration: "none" }}>ABOUT</Link>
          <span style={{ color: "var(--rpc-text-ghost)" }}>TERMS</span>
          <span style={{ color: "var(--rpc-text-ghost)" }}>PRIVACY</span>
        </div>
      </div>
    </footer>
  );
}
