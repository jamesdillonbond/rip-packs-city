import Link from "next/link";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const RED = "#E03A2F";

const SUPPORTED_COLLECTIONS = [
  { label: "NBA Top Shot", icon: "\u{1F3C0}", accent: "#E03A2F" },
  { label: "NFL All Day", icon: "\u{1F3C8}", accent: "#4F94D4" },
  { label: "LaLiga Golazos", icon: "\u26BD", accent: "#22C55E" },
  { label: "Disney Pinnacle", icon: "\u2728", accent: "#A855F7" },
  { label: "UFC Strike", icon: "\u{1F94A}", accent: "#EF4444" },
];

export default function AboutPage() {
  return (
    <div style={{ background: "#080808", color: "#F1F1F1", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');`}</style>
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <RpcLogo size={32} />
          </Link>
          <Link href="/" style={{ marginLeft: "auto", fontFamily: monoFont, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", textDecoration: "none" }}>
            &larr; Back
          </Link>
        </div>
      </header>

      <main style={{ flex: 1, padding: "56px 24px 80px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>

          <section style={{ textAlign: "center", marginBottom: 48 }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
              <RpcLogo size={140} />
            </div>
            <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 38, letterSpacing: "0.04em", textTransform: "uppercase", lineHeight: 1.1, marginBottom: 10 }}>
              About <span style={{ color: RED }}>Rip Packs City</span>
            </h1>
            <p style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Collector intelligence for the Flow blockchain
            </p>
          </section>

          <Section title="What it is">
            Rip Packs City (RPC) is a collector intelligence platform for digital
            collectibles on the Flow blockchain. We surface fair market value (FMV)
            pricing, sniper-ready deals across marketplaces, badge tracking, set
            completion, pack EV, and portfolio analytics &mdash; the data layer
            serious collectors need but rarely get out of the box.
          </Section>

          <Section title="Who built it">
            RPC was built by <strong style={{ color: "#F1F1F1" }}>Trevor Dillon-Bond</strong>,
            an Official Portland Trail Blazers Team Captain on NBA Top Shot. The
            platform started as a tool for the Blazers community &mdash; collectors
            who care about real value, not just hype &mdash; and grew into a
            cross-collection intelligence stack covering the full Flow NFT
            ecosystem.
          </Section>

          <Section title="Collections supported">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10, marginTop: 12 }}>
              {SUPPORTED_COLLECTIONS.map((c) => (
                <div
                  key={c.label}
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderLeft: `3px solid ${c.accent}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{c.icon}</span>
                  <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase" }}>{c.label}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Relationship with Flowty">
            RPC integrates with{" "}
            <a href="https://www.flowty.io" target="_blank" rel="noopener noreferrer" style={{ color: RED, textDecoration: "none" }}>Flowty</a>{" "}
            as a primary listing source for cross-marketplace deal discovery.
            Flowty&apos;s leadership &mdash; CEO Mike Levy and CTO Austin Kline
            &mdash; are aware of and supportive of RPC. Listings, valuations, and
            buy flows surfaced on RPC route directly to Flowty when applicable.
          </Section>

          <Section title="Contact">
            Questions, feedback, partnership inquiries, or data corrections:{" "}
            <a href="mailto:rippackscity@gmail.com" style={{ color: RED, textDecoration: "none" }}>
              rippackscity@gmail.com
            </a>
          </Section>

        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 36 }}>
      <h2
        style={{
          fontFamily: condensedFont,
          fontWeight: 800,
          fontSize: 20,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "#F1F1F1",
          marginBottom: 10,
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontFamily: monoFont,
          fontSize: 13,
          lineHeight: 1.8,
          color: "rgba(255,255,255,0.7)",
        }}
      >
        {children}
      </div>
    </section>
  );
}
