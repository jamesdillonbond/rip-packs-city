import Link from "next/link";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";

export default function PrivacyPage() {
  return (
    <div style={{ background: "#080808", color: "#F1F1F1", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <RpcLogo size={32} />
          </Link>
          <Link href="/" style={{ marginLeft: "auto", fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", textDecoration: "none" }}>
            &larr; Back
          </Link>
        </div>
      </header>
    <main
      style={{
        flex: 1,
        padding: "48px 24px 80px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 900,
            fontSize: 32,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginBottom: 8,
          }}
        >
          Privacy Policy
        </h1>
        <p
          style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: 12,
            color: "rgba(255,255,255,0.35)",
            marginBottom: 40,
          }}
        >
          Last updated: April 1, 2026
        </p>

        <div
          style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: 13,
            lineHeight: 1.8,
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <Section title="1. Data We Collect">
            <strong style={{ color: "#F1F1F1" }}>Wallet addresses</strong> — When
            you search for a wallet or connect one, we store the public Flow
            blockchain address to provide collection analytics.
            <br /><br />
            <strong style={{ color: "#F1F1F1" }}>Search history</strong> — Recent
            searches are stored locally and optionally in your profile to improve
            your experience.
            <br /><br />
            <strong style={{ color: "#F1F1F1" }}>Support chat logs</strong> — If
            you use the support chat, conversation history is stored to provide
            context for ongoing support.
            <br /><br />
            <strong style={{ color: "#F1F1F1" }}>Profile data</strong> — Display
            name, bio, trophy moments, and saved wallets you choose to add.
          </Section>

          <Section title="2. How We Use Your Data">
            Your data is used solely to power the Rip Packs City platform: displaying
            your collection, computing FMV estimates, matching badge eligibility,
            and providing personalized analytics. We do not use your data for
            advertising or profiling purposes.
          </Section>

          <Section title="3. Data Sharing">
            We do not sell, rent, or share your personal data with third parties.
            Public wallet addresses and their on-chain activity are inherently public
            on the Flow blockchain. We may share anonymized, aggregate statistics
            (e.g., total platform FMV) publicly.
          </Section>

          <Section title="4. Data Storage">
            Data is stored in{" "}
            <a
              href="https://supabase.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#E03A2F", textDecoration: "none" }}
            >
              Supabase
            </a>{" "}
            (hosted on AWS). The application is deployed on Vercel. Both providers
            maintain SOC 2 compliance. All data is transmitted over HTTPS.
          </Section>

          <Section title="5. Cookies and Local Storage">
            RPC uses browser local storage to save your owner key and preferences.
            We do not use third-party tracking cookies. No analytics or advertising
            trackers are present on the site.
          </Section>

          <Section title="6. Your Rights">
            You may request deletion of your profile data, saved wallets, and search
            history at any time. Contact us and we will remove your data within
            30 days.
          </Section>

          <Section title="7. Contact">
            For privacy questions or data deletion requests, contact us at{" "}
            <a
              href="mailto:rippackscity@gmail.com"
              style={{ color: "#E03A2F", textDecoration: "none" }}
            >
              rippackscity@gmail.com
            </a>
            .
          </Section>
        </div>
      </div>
    </main>
      <SiteFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2
        style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 700,
          fontSize: 18,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
          color: "#F1F1F1",
          marginBottom: 8,
        }}
      >
        {title}
      </h2>
      <div style={{ margin: 0 }}>{children}</div>
    </section>
  );
}
