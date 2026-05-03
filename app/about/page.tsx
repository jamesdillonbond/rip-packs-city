import Link from "next/link";
import type { Metadata } from "next";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";

export function generateMetadata(): Metadata {
  return {
    title: "About — Rip Packs City",
    description:
      "Rip Packs City is independent collector intelligence for the Flow blockchain — built in Portland by a Top Shot Team Captain for collectors who want real data, not hype.",
    openGraph: {
      title: "About — Rip Packs City",
      description:
        "Built in Portland. For collectors, by a collector. Independent collector intelligence for NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, and UFC Strike.",
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

      <main style={{ flex: 1, padding: "48px 24px 80px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <Breadcrumb current="About" />

          <h1
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 800,
              fontSize: 32,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--rpc-text-primary)",
              margin: "16px 0 24px",
              lineHeight: 1.15,
            }}
          >
            Built in Portland. For collectors, by a collector.
          </h1>

          <Section title="The Origin">
            Rip Packs City started as a tool for one collector &mdash; me &mdash;
            trying to make sense of NBA Top Shot during the 2024-25 season. I&apos;d
            been a Top Shot Team Captain for the Portland Trail Blazers community,
            fielding questions every day about which moments were undervalued,
            which packs were worth ripping, and what a fair price actually looked
            like. The existing tools gave me pieces of the picture. None of them
            gave me the whole thing. So I built it.
          </Section>

          <Section title="What RPC Is">
            Rip Packs City is collector intelligence for the Flow blockchain. We
            track NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, and
            UFC Strike &mdash; five live collections totaling more than 21,000
            editions and 80,000+ recorded sales. Every page on this site is built
            around one question: what does a serious collector need to make a
            confident decision? That means real fair-market values calibrated to
            actual sales. A sniper that surfaces deals priced below FMV. Pack
            expected-value calculations grounded in real edition coverage. Set
            completion intelligence. Wallet analytics deep enough to evaluate a
            trade partner. Public profiles you can share. An AI concierge that
            answers questions in plain English using the same data the rest of
            the platform runs on.
          </Section>

          <Section title="What RPC Isn't">
            Rip Packs City is independent. We are not affiliated with Dapper Labs,
            NBA Top Shot, NFL All Day, LaLiga, Disney, the UFC, or any of the
            collections we track. We don&apos;t sell moments, we don&apos;t custody
            them, and we don&apos;t take a cut of any transaction surfaced through
            the platform. We don&apos;t give financial advice. Every FMV, every
            deal score, every set valuation is a model output &mdash; useful, but
            not a guarantee. Treat it like the weather forecast: usually right,
            sometimes wrong, never a substitute for your own judgment.
          </Section>

          <Section title="Who's Behind It">
            Rip Packs City is built and operated by Trevor Dillon-Bond, an Oregon
            resident and longtime collector. The platform runs out of Portland on
            infrastructure I pay for myself. An LLC is in formation; once it&apos;s
            registered the operator section will update. There is no team behind
            the curtain &mdash; every line of code, every database migration,
            every design decision so far has been mine, with help from AI tools
            where it makes sense.
          </Section>

          <Section title="Get In Touch">
            Questions, bug reports, partnership inquiries, or just a hello: reach
            me on X at{" "}
            <a
              href="https://twitter.com/RipPacksCity"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#E03A2F", textDecoration: "none" }}
            >
              @RipPacksCity
            </a>
            . Response time depends on how loud Twitter is that day, but I read
            every message.
          </Section>

          <LastUpdated text="Last updated: May 2026." />
        </div>
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
            fontFamily: "'Share Tech Mono', monospace",
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

function Breadcrumb({ current }: { current: string }) {
  return (
    <div
      style={{
        fontFamily: "'Share Tech Mono', monospace",
        fontSize: 11,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--rpc-text-ghost)",
      }}
    >
      <Link
        href="/"
        style={{ color: "var(--rpc-text-ghost)", textDecoration: "none" }}
      >
        RPC
      </Link>
      <span style={{ margin: "0 8px" }}>&rsaquo;</span>
      <span style={{ color: "var(--rpc-text-secondary)" }}>{current}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2
        style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 700,
          fontSize: 18,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--rpc-text-secondary)",
          margin: "0 0 12px",
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontSize: 16,
          lineHeight: 1.6,
          color: "var(--rpc-text-primary)",
          margin: 0,
        }}
      >
        {children}
      </p>
    </section>
  );
}

function LastUpdated({ text }: { text: string }) {
  return (
    <p
      style={{
        marginTop: 48,
        fontFamily: "'Share Tech Mono', monospace",
        fontSize: 11,
        color: "var(--rpc-text-ghost)",
        letterSpacing: "0.06em",
      }}
    >
      {text}
    </p>
  );
}
