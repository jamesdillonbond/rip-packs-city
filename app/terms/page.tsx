import Link from "next/link";
import type { Metadata } from "next";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";

export function generateMetadata(): Metadata {
  return {
    title: "Terms of Service — Rip Packs City",
    description:
      "Terms of service for Rip Packs City — service description, acceptable use, disclaimers, limitation of liability, and governing law.",
    openGraph: {
      title: "Terms of Service — Rip Packs City",
      description:
        "By using Rip Packs City you agree to these terms. Service description, disclaimers, acceptable use, and governing law for the platform.",
    },
  };
}

export default function TermsPage() {
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
          <Breadcrumb current="Terms" />

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
            Terms of Service
          </h1>

          <p
            style={{
              fontSize: 16,
              lineHeight: 1.6,
              color: "var(--rpc-text-primary)",
              margin: "0 0 8px",
            }}
          >
            By using Rip Packs City you agree to these terms. They are written to
            be readable. If anything is unclear, reach out at{" "}
            <a
              href="https://twitter.com/RipPacksCity"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#E03A2F", textDecoration: "none" }}
            >
              @RipPacksCity
            </a>{" "}
            on X before using the platform.
          </p>

          <Section title="Service Description">
            Rip Packs City is a collector intelligence platform for digital
            collectibles on the Flow blockchain. We surface fair-market values,
            marketplace deals, pack expected values, set completion analytics,
            wallet analytics, and related insights derived from public on-chain
            data and public marketplace APIs. Some features require an account;
            most are accessible without one.
          </Section>

          <Section title="Not Financial Advice">
            Every value, score, recommendation, and analysis surfaced through
            Rip Packs City is informational only. Fair-market values are model
            outputs based on recent sales and listings. Sniper deals, pack
            expected values, set valuations, and similar metrics are estimates
            with inherent uncertainty. Nothing on this platform is investment
            advice, financial advice, tax advice, or a recommendation to buy,
            sell, or hold any digital collectible. You make your own decisions
            and bear your own risk.
          </Section>

          <Section title="No Affiliation">
            Rip Packs City is independent. We are not affiliated with Dapper
            Labs, NBA Top Shot, NFL All Day, LaLiga, Disney, the UFC, or any of
            the collections, marketplaces, or platforms we reference. Trademarks
            and team marks remain the property of their respective owners.
          </Section>

          <Section title="Acceptable Use">
            You agree not to scrape the platform programmatically, abuse the AI
            concierge, attempt to circumvent rate limits, exploit security
            vulnerabilities, attempt to identify other users without their
            consent, or use the platform to harass, threaten, or defraud other
            users. We reserve the right to revoke access for any account or IP
            address engaged in abuse.
          </Section>

          <Section title="Account">
            If you create an account, you are responsible for activity that
            happens under it. Use a real email so account recovery actually
            works. We may suspend or delete accounts found violating these
            terms.
          </Section>

          <Section title="User Content">
            If you create a public profile, set a display name, write a bio, or
            pin trophy moments visible to others, you grant Rip Packs City a
            non-exclusive license to display that content on the platform. You
            retain ownership of anything you create. You agree not to upload
            content you don&apos;t have rights to, content that&apos;s defamatory
            or harassing, or anything that violates someone else&apos;s privacy.
          </Section>

          <Section title="Third-Party Marketplaces">
            Links from Rip Packs City to NBA Top Shot, Flowty, or other
            third-party marketplaces transfer you to those platforms, which have
            their own terms. We are not responsible for transactions, listings,
            or actions you take on those platforms.
          </Section>

          <Section title="Warranty Disclaimer">
            The platform is provided as-is. We make no warranty, express or
            implied, that the data is complete, accurate, current, or fit for
            any particular purpose. We do our best, but external data sources
            change, blockchain indexers lag, and models have error bars. Use at
            your own risk.
          </Section>

          <Section title="Limitation of Liability">
            To the fullest extent permitted by law, Rip Packs City and Trevor
            Dillon-Bond will not be liable for any indirect, incidental, special,
            consequential, or punitive damages arising from your use of the
            platform, including but not limited to lost profits, lost data, or
            trading losses. Our total cumulative liability for any claim arising
            from your use of the platform is limited to one hundred US dollars
            or the amount you paid us in the prior twelve months, whichever is
            greater.
          </Section>

          <Section title="Termination">
            You may stop using the platform at any time. We may suspend or
            terminate access to any account or IP address at our discretion,
            with or without notice. Sections of these terms intended to survive
            termination &mdash; including warranty disclaimer, limitation of
            liability, governing law, and dispute resolution &mdash; survive.
          </Section>

          <Section title="Governing Law">
            These terms are governed by the laws of the State of Oregon, USA,
            without regard to conflict of laws principles. Any dispute arising
            from your use of the platform will be brought in the state or
            federal courts located in Multnomah County, Oregon, and you consent
            to personal jurisdiction there.
          </Section>

          <Section title="Changes to These Terms">
            We may update these terms as the platform evolves. Material changes
            will be posted on the home page or emailed if we have your address.
            Continued use after a change means you accept the updated terms.
          </Section>

          <Section title="Contact">
            Questions about these terms: reach out at{" "}
            <a
              href="https://twitter.com/RipPacksCity"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#E03A2F", textDecoration: "none" }}
            >
              @RipPacksCity
            </a>{" "}
            on X. The platform is operated by Trevor Dillon-Bond, an Oregon
            resident, with an LLC in formation.
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
