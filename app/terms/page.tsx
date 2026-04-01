export default function TermsPage() {
  return (
    <main
      style={{
        background: "#080808",
        color: "#F1F1F1",
        minHeight: "100vh",
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
          Terms of Service
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
          <Section title="1. Platform Description">
            Rip Packs City (&quot;RPC&quot;) is a read-only analytics and intelligence
            platform for NBA Top Shot and Flow blockchain digital collectibles. RPC
            does not custody, hold, or transfer any digital assets on your behalf.
            All transactions occur directly on the Top Shot marketplace or the Flow
            blockchain.
          </Section>

          <Section title="2. Not Financial Advice">
            All fair market value (FMV) estimates, expected value (EV) calculations,
            and market intelligence provided by RPC are for informational purposes
            only and do not constitute financial, investment, or trading advice. You
            are solely responsible for your own collecting and trading decisions.
          </Section>

          <Section title="3. No Warranty on Data">
            RPC provides data on an &quot;as is&quot; basis. We make no warranties,
            express or implied, regarding the accuracy, completeness, or timeliness
            of FMV data, marketplace prices, offer amounts, or any other information
            displayed on the platform. Market conditions change rapidly and displayed
            values may be stale or incorrect.
          </Section>

          <Section title="4. Acceptable Use">
            You agree not to scrape, crawl, or programmatically access the platform
            at excessive rates. You agree not to use the platform to manipulate
            marketplace prices or engage in wash trading. Standard personal and
            analytical use is welcome.
          </Section>

          <Section title="5. Limitation of Liability">
            RPC and its operators shall not be liable for any direct, indirect,
            incidental, or consequential damages arising from your use of the
            platform or reliance on data provided. This includes but is not limited
            to losses from trading decisions made based on RPC data.
          </Section>

          <Section title="6. Changes to Terms">
            We may update these terms at any time. Continued use of the platform
            after changes constitutes acceptance of the updated terms.
          </Section>

          <Section title="7. Governing Law">
            These terms are governed by the laws of the State of Oregon, United
            States, without regard to conflict of law provisions.
          </Section>

          <Section title="8. Contact">
            For questions about these terms, contact us at{" "}
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
      <p style={{ margin: 0 }}>{children}</p>
    </section>
  );
}
