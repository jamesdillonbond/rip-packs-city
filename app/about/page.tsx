import Link from "next/link";
import type { Metadata } from "next";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";

export function generateMetadata(): Metadata {
  return {
    title: "About — Rip Packs City",
    description:
      "Rip Packs City is independent collector intelligence for the Flow blockchain — built in Portland, Oregon by an active community member and Trail Blazers Team Captain on NBA Top Shot.",
    openGraph: {
      title: "About — Rip Packs City",
      description:
        "Born in Rip City. Built for every Flow blockchain digital collectible community — NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike.",
    },
  };
}

export default function AboutPage() {
  return (
    <div
      style={{
        background: "var(--rpc-surface)",
        color: "var(--rpc-text-primary)",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <PageHeader />

      <main style={{ flex: 1, padding: "64px 24px 96px" }}>
        <article style={{ maxWidth: 640, margin: "0 auto" }}>
          <Section title="Born in Rip City">
            <p>
              Rip Packs City was built in Portland, Oregon by an active
              community member and official Portland Trail Blazers Team
              Captain on NBA Top Shot. Every line of code, every analytics
              query, every late-night data fix happens within sight of the
              Willamette.
            </p>
            <p>
              The name pays homage to the call broadcaster Bill Schonely
              improvised on February 18, 1971 — a phrase that became
              inseparable from Portland itself. Half a century later it
              still belongs to this city, and to the collectors who carry
              that energy onto Flow.
            </p>
          </Section>

          <Section title="Built for every collection">
            <p>
              While the soul of the project is rooted in Rip City, the
              platform serves every Flow blockchain digital collectible
              community equally — NBA Top Shot, NFL All Day, LaLiga
              Golazos, Disney Pinnacle, UFC Strike — with the same depth
              of analytics, FMV pricing, and tooling regardless of which
              fandom a collector calls home.
            </p>
          </Section>

          <Section title="Independent">
            <p>
              Rip Packs City is built and operated by a single developer.
              It is not affiliated with Dapper Labs, the NBA, NFLPA, or any
              league or league partner. The platform exists to serve
              collectors with honest pricing and analytics — nothing more
              and nothing less.
            </p>
          </Section>

          <SchonelyQuote />
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}

function PageHeader() {
  return (
    <header
      style={{
        background: "var(--rpc-surface)",
        borderBottom: "1px solid var(--rpc-border)",
        position: "sticky",
        top: 0,
        zIndex: 100,
        backdropFilter: "blur(20px)",
      }}
    >
      <div
        style={{
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          padding: "0 20px",
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Link
          href="/"
          style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}
        >
          <RpcLogo size={32} />
        </Link>
        <Link
          href="/"
          style={{
            marginLeft: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--rpc-text-secondary)",
            textDecoration: "none",
          }}
        >
          &larr; Back
        </Link>
      </div>
    </header>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 56 }}>
      <h2
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 36,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--rpc-text-primary)",
          margin: "0 0 20px",
          lineHeight: 1.05,
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 16,
          lineHeight: 1.7,
          color: "var(--rpc-text-primary)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function SchonelyQuote() {
  return (
    <footer
      style={{
        marginTop: 64,
        paddingTop: 24,
        borderTop: "1px solid var(--rpc-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm)",
        lineHeight: 1.6,
        letterSpacing: "0.06em",
      }}
    >
      <div style={{ color: "var(--rpc-text-secondary)" }}>
        &ldquo;<span style={{ color: "var(--rpc-red)" }}>Rip City</span>! All right!&rdquo;
      </div>
      <div
        style={{
          marginTop: 6,
          color: "var(--rpc-text-muted)",
          fontSize: "var(--text-xs)",
          letterSpacing: "0.1em",
        }}
      >
        — Bill Schonely, February 18, 1971
      </div>
    </footer>
  );
}
