// app/admin/page.tsx
// Trevor-only admin index. proxy.ts allows /admin/* through unauthenticated;
// each linked tool has its own RPC_ADMIN_TOKEN gate.

import Link from "next/link";

export const dynamic = "force-static";

interface Tool {
  href: string;
  title: string;
  blurb: string;
}

const TOOLS: Tool[] = [
  {
    href: "/admin/analytics",
    title: "Platform Analytics",
    blurb: "Single-pane users + monetization + pipelines + signals + engagement.",
  },
  {
    href: "/admin/flowty-errors",
    title: "Error Triage",
    blurb: "Pipeline + on-chain failure rollup. Refreshed every 30 min.",
  },
  {
    href: "/admin/flowty-analytics",
    title: "Flowty Analytics",
    blurb: "Marketplace + lending intelligence across all 5 collections.",
  },
  {
    href: "/admin/feedback",
    title: "Beta Feedback",
    blurb: "Triage support_conversations from the AI concierge.",
  },
  {
    href: "/admin/allow-list",
    title: "Allow List",
    blurb: "Beta access whitelist + prewarm queue.",
  },
  {
    href: "/admin/beta-activity",
    title: "Beta Activity",
    blurb: "Per-user 7d page-view + last-seen + top features rollup.",
  },
  {
    href: "/admin/fmv-health",
    title: "FMV Health",
    blurb: "Thin-sales guard cap audit — what got downgraded, when, and why.",
  },
  {
    href: "/admin/pipeline-health",
    title: "Pipeline Health",
    blurb: "Cron drift surface — every pipeline's last run + cadence vs expected.",
  },
];

export default function AdminIndexPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--rpc-black)",
        color: "var(--rpc-text-primary)",
        padding: "60px 24px",
      }}
    >
      <main style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
        <header>
          <div className="rpc-label">Rip Packs City</div>
          <div className="rpc-heading" style={{ fontSize: 32, marginTop: 4 }}>
            Admin Console
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--rpc-text-muted)",
              marginTop: 6,
            }}
          >
            Each tool below has its own RPC_ADMIN_TOKEN sign-in.
          </div>
        </header>
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {TOOLS.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              className="rpc-card"
              style={{
                padding: "16px 18px",
                textDecoration: "none",
                color: "inherit",
                display: "block",
              }}
            >
              <div
                className="rpc-heading"
                style={{ fontSize: 18, color: "var(--rpc-red)", marginBottom: 4 }}
              >
                {tool.title}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--rpc-text-secondary)",
                }}
              >
                {tool.blurb}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--rpc-text-muted)",
                  marginTop: 6,
                  letterSpacing: "0.08em",
                }}
              >
                {tool.href}
              </div>
            </Link>
          ))}
        </section>
      </main>
    </div>
  );
}
