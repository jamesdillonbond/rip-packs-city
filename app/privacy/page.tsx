import Link from "next/link";
import type { Metadata } from "next";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";

export function generateMetadata(): Metadata {
  return {
    title: "Privacy Policy — Rip Packs City",
    description:
      "How Rip Packs City collects, stores, and uses data — in plain English. Vendors, choices, cookies, and contact for deletion requests.",
    openGraph: {
      title: "Privacy Policy — Rip Packs City",
      description:
        "Plain-English privacy policy for Rip Packs City: what we collect, what we don't, where it's stored, and your choices.",
    },
  };
}

export default function PrivacyPage() {
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
          <Breadcrumb current="Privacy" />

          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: 32,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--rpc-text-primary)",
              margin: "16px 0 24px",
              lineHeight: 1.15,
            }}
          >
            Privacy Policy
          </h1>

          <p
            style={{
              fontSize: 16,
              lineHeight: 1.6,
              color: "var(--rpc-text-primary)",
              margin: "0 0 8px",
            }}
          >
            This policy explains what Rip Packs City collects, why, where it&apos;s
            stored, and what choices you have. Plain English. If anything here is
            unclear, reach out at{" "}
            <a
              href="https://twitter.com/RipPacksCity"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--rpc-red)", textDecoration: "none" }}
            >
              @RipPacksCity
            </a>{" "}
            on X.
          </p>

          <Section title="What we collect">
            If you sign in, we receive your email address from Supabase&apos;s
            magic-link authentication so we can identify your saved profile
            across devices. If you connect a Flow wallet (currently optional,
            used for on-chain action like cart purchases), we receive your wallet
            address. If you use the AI concierge, your messages and our responses
            are processed by Anthropic&apos;s Claude API to generate replies. If
            you save wallets, pin trophy moments, or fill out your bio, that
            information is stored against your user account. Anonymous visitors
            generate page-view telemetry that we use only to debug errors and
            understand which features are used.
          </Section>

          <Section title="What we do not collect">
            We do not collect payment information. Any moment purchases initiated
            through Rip Packs City execute on Dapper Labs&apos; or Flowty&apos;s
            marketplace infrastructure &mdash; your card or crypto details never
            touch our servers. We do not collect, sell, or rent your personal
            data to advertisers. We do not run third-party advertising trackers.
            We do not collect data on minors and the platform is not directed at
            users under 18.
          </Section>

          <Section title="Where it's stored">
            User accounts and saved data live in Supabase (a managed Postgres
            database hosted in US-East). The platform is served by Vercel. Error
            telemetry is captured by Sentry. AI concierge messages route through
            Anthropic. Cloudflare Workers proxy a small number of public
            marketplace API calls. None of these vendors receive more than the
            data necessary to perform their function.
          </Section>

          <Section title="How we use it">
            Your email is used to log you in and, if you opt in, to send
            occasional product updates. Your saved wallets are used to render
            your private dashboard and your public profile (if you choose to
            make one public). Your AI concierge inputs are used in real time to
            generate responses; we don&apos;t train any model on your messages.
            Aggregate, anonymized usage data is used to improve the platform.
          </Section>

          <Section title="Your choices">
            You can delete your account, your saved wallets, or your bio at any
            time from the Profile page. Deleting your account removes your
            records from our database within 24 hours; some derivative analytics
            may persist anonymously. You can opt out of product emails at any
            time via the unsubscribe link in any email we send.
          </Section>

          <Section title="Cookies and storage">
            We use a Supabase auth cookie to keep you signed in. We use
            localStorage on your device to remember UI preferences (like
            dismissing the welcome modal) &mdash; this never leaves your browser.
            We do not use third-party tracking cookies.
          </Section>

          <Section title="Children">
            Rip Packs City is intended for users 18 and older. We do not
            knowingly collect data from children under 13.
          </Section>

          <Section title="Changes">
            We&apos;ll update this policy as the platform evolves. Material
            changes will be flagged on the home page or via email if we have one
            for you.
          </Section>

          <Section title="Contact">
            Questions or data deletion requests: reach out at{" "}
            <a
              href="https://twitter.com/RipPacksCity"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--rpc-red)", textDecoration: "none" }}
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

function Breadcrumb({ current }: { current: string }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
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
          fontFamily: "var(--font-display)",
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
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--rpc-text-ghost)",
        letterSpacing: "0.06em",
      }}
    >
      {text}
    </p>
  );
}
