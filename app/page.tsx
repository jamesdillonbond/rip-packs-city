"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";
import MobileNav from "@/components/MobileNav";
import PinwheelDivider from "@/components/visual/PinwheelDivider";
import { publishedCollections } from "@/lib/collections";
import { organizationJsonLd } from "@/lib/seo";

const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/;

function classifyAndRoute(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (FLOW_ADDRESS.test(value)) {
    return `/nba-top-shot/collection?wallet=${encodeURIComponent(value)}`;
  }
  return `/nba-top-shot/collection?username=${encodeURIComponent(value)}`;
}

function WalletSearch({ size = "lg" }: { size?: "lg" | "md" }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const height = size === "lg" ? 56 : 48;
  const fontSize = size === "lg" ? 15 : 13;

  const submit = useCallback(
    (override?: string) => {
      const target = classifyAndRoute(override ?? value);
      if (target) router.push(target);
    },
    [router, value],
  );

  const tryDemo = useCallback(() => {
    setValue("jamesdillonbond");
    submit("jamesdillonbond");
  }, [submit]);

  return (
    <div style={{ width: "100%", maxWidth: 640, marginInline: "auto" }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="rpc-home-search"
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "var(--rpc-surface-raised)",
          border: "1px solid var(--rpc-border)",
          borderRadius: 10,
          overflow: "hidden",
          height,
        }}
      >
        <input
          aria-label="Search Top Shot username, Flow wallet, or moment ID"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search any Top Shot username, Flow wallet (0x…), or moment ID"
          style={{
            flex: 1,
            minWidth: 0,
            padding: "0 16px",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--rpc-text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize,
            letterSpacing: "0.02em",
          }}
        />
        <button
          type="submit"
          style={{
            background: "var(--rpc-red)",
            border: "none",
            color: "#fff",
            padding: "0 22px",
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          ANALYZE →
        </button>
      </form>
      <div
        style={{
          marginTop: 10,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--rpc-text-muted)",
          letterSpacing: "0.04em",
          textAlign: "center",
        }}
      >
        No signup required. Try{" "}
        <button
          type="button"
          onClick={tryDemo}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            color: "var(--rpc-red)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.04em",
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          jamesdillonbond
        </button>
        .
      </div>
    </div>
  );
}

function HomeHeader() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "rgba(8,8,8,0.85)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid var(--rpc-border)",
      }}
    >
      <div
        className="rpc-home-header-inner"
        style={{
          maxWidth: 1440,
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
          style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", flexShrink: 0 }}
        >
          <RpcLogo size={36} />
          <div>
            <div
              style={{
                fontSize: 7,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.2em",
                color: "rgba(224,58,47,0.5)",
              }}
            >
              @RIPPACKSCITY
            </div>
          </div>
        </Link>
        <div style={{ flex: 1 }} />
        <nav
          className="rpc-home-nav"
          style={{ display: "flex", alignItems: "center", gap: 14 }}
        >
          <a href="#collections" style={navLinkStyle}>
            Collections
          </a>
          <a href="#how-it-works" style={navLinkStyle}>
            How it works
          </a>
          <a href="#pricing" style={navLinkStyle}>
            Pricing
          </a>
          <Link
            href="/dashboard"
            style={{
              background: "rgba(224,58,47,0.15)",
              border: "1px solid rgba(224,58,47,0.4)",
              color: "var(--rpc-red)",
              padding: "6px 14px",
              borderRadius: 4,
              fontSize: 11,
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            Sign In
          </Link>
        </nav>
      </div>
    </header>
  );
}

const navLinkStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-text-secondary)",
  textDecoration: "none",
};

const STATS: Array<{ value: string; label: string }> = [
  // TODO: wire these to live counters in a follow-up — see /api/health-check + ops dashboards.
  { value: "5", label: "Collections Tracked" },
  { value: "9.5K+", label: "Data Refreshes" },
  { value: "20 MIN", label: "Live Refresh" },
  { value: "100%", label: "Uptime" },
];

const HOW_STEPS: Array<{ n: string; title: string; copy: string }> = [
  {
    n: "01",
    title: "SEARCH",
    copy: "Type any wallet, username, or moment. No signup, no API key.",
  },
  {
    n: "02",
    title: "ANALYZE",
    copy: "We pull live FMV from sales data, real listings from Top Shot and Flowty, badges, serials, and series labels.",
  },
  {
    n: "03",
    title: "ACT",
    copy: "Find underpriced deals, track portfolio value over time, and complete sets faster.",
  },
];

const DEPTH_BULLETS: Array<{ icon: string; copy: string }> = [
  { icon: "◈", copy: "Outlier-filtered FMV with distributional shape (p10 / p50 / p90)." },
  { icon: "▲", copy: "Serial premium multipliers — 1-of-1 = 12×, low serials = 4.5×, last mint = 3×." },
  { icon: "≋", copy: "Liquidity ratings on every edition based on 30-day depth." },
  { icon: "⚡", copy: "Real-time deal sniping merged across Top Shot and Flowty." },
  { icon: "✦", copy: "Badge-aware pricing — Top Shot Debut, Rookie Year, Championship, Fresh." },
  { icon: "◉", copy: "Set bottleneck finder — cheapest path to completion." },
  { icon: "▣", copy: "Pack EV calculations, depletion-aware, with buy / skip recommendations." },
];

const TRUST: string[] = [
  "Built by Trevor Dillon-Bond, an official Portland Trail Blazers Team Captain on NBA Top Shot.",
  "Working partnership with Flowty leadership.",
  "Live pipelines updated every 20 minutes.",
  "Zero downtime since launch.",
];

export default function HomePage() {
  const collections = publishedCollections();

  const webApplicationJsonLd = {
    ...organizationJsonLd,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"}/nba-top-shot/collection?username={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webApplicationJsonLd) }}
      />

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .rpc-home-search input::placeholder{color:rgba(255,255,255,0.3);}
        .rpc-home-h1{font-family:var(--font-display);font-weight:900;font-size:56px;letter-spacing:0.04em;text-transform:uppercase;line-height:1.02;color:var(--rpc-text-primary);}
        .rpc-home-h1-accent{color:var(--rpc-red);}
        .rpc-home-h2{font-family:var(--font-display);font-weight:900;font-size:40px;letter-spacing:0.04em;text-transform:uppercase;line-height:1.05;color:var(--rpc-text-primary);}
        .rpc-home-eyebrow{font-family:var(--font-mono);font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:var(--rpc-red);}
        .rpc-home-sub{font-family:var(--font-mono);font-size:14px;line-height:1.65;color:rgba(255,255,255,0.7);max-width:640px;margin-inline:auto;}
        .rpc-home-section{padding:96px 24px;}
        .rpc-home-stats-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;}
        .rpc-home-collection-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;}
        .rpc-home-how-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;}
        .rpc-home-depth-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:48px;align-items:start;}
        .rpc-home-trust-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;}
        .rpc-home-collection-tile{transition:transform var(--transition-fast),border-color var(--transition-fast),box-shadow var(--transition-fast);}
        .rpc-home-collection-tile:hover{transform:translateY(-4px);}
        @media (max-width:768px){
          .rpc-home-section{padding:64px 16px;}
          .rpc-home-h1{font-size:36px;}
          .rpc-home-h2{font-size:28px;}
          .rpc-home-sub{font-size:13px;}
          .rpc-home-stats-row{grid-template-columns:repeat(2,minmax(0,1fr));}
          .rpc-home-collection-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
          .rpc-home-how-grid{grid-template-columns:1fr;}
          .rpc-home-depth-grid{grid-template-columns:1fr;gap:24px;}
          .rpc-home-trust-grid{grid-template-columns:1fr;gap:14px;}
          .rpc-home-nav a{display:none;}
          .rpc-home-header-inner{padding:0 14px;}
        }
        @media (max-width:380px){
          .rpc-home-h1{font-size:32px;}
          .rpc-home-collection-grid{grid-template-columns:1fr;}
        }
      `}</style>

      <HomeHeader />

      {/* HERO */}
      <section
        className="rpc-home-section"
        style={{
          minHeight: "calc(100vh - 56px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          gap: 24,
        }}
      >
        <div className="rpc-home-eyebrow">◈ COLLECTOR INTELLIGENCE PLATFORM ◈</div>
        <h1 className="rpc-home-h1">
          Rip Packs <span className="rpc-home-h1-accent">City</span>
        </h1>
        <p className="rpc-home-sub">
          The intelligence layer for Flow collectibles. FMV, deals, and portfolio analytics for NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike.
        </p>
        <WalletSearch size="lg" />
      </section>

      {/* LIVE STATS BAND */}
      <section
        style={{
          background: "var(--rpc-surface)",
          borderTop: "1px solid var(--rpc-red-border)",
          borderBottom: "1px solid var(--rpc-border)",
          padding: "32px 16px",
        }}
      >
        <div className="rpc-home-stats-row" style={{ maxWidth: 1100, margin: "0 auto" }}>
          {STATS.map((s, i) => (
            <div
              key={s.label}
              style={{
                textAlign: "center",
                padding: "8px 12px",
                borderLeft: i === 0 ? "none" : "1px solid var(--rpc-border)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 900,
                  fontSize: 32,
                  letterSpacing: "0.04em",
                  color: "var(--rpc-text-primary)",
                  lineHeight: 1,
                }}
              >
                {s.value}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color: "var(--rpc-text-muted)",
                }}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* COLLECTIONS */}
      <section id="collections" className="rpc-home-section">
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <h2 className="rpc-home-h2">FIVE COLLECTIONS. ONE PLATFORM.</h2>
            <div
              style={{
                marginTop: 12,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                letterSpacing: "0.04em",
                color: "var(--rpc-text-muted)",
              }}
            >
              Every published collection on Flow blockchain, in one analytics surface.
            </div>
          </div>

          <div className="rpc-home-collection-grid">
            {collections.map((c) => (
              <Link
                key={c.id}
                href={`/${c.id}/overview`}
                className="rpc-home-collection-tile"
                style={{
                  position: "relative",
                  display: "block",
                  background: "var(--rpc-surface-raised)",
                  border: "1px solid var(--rpc-border)",
                  borderTop: `2px solid ${c.accent}`,
                  borderBottom: `2px solid ${c.accent}`,
                  borderRadius: "var(--radius-md)",
                  padding: "20px 18px 18px",
                  textDecoration: "none",
                  color: "var(--rpc-text-primary)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <div style={{ fontSize: 32, lineHeight: 1 }}>{c.icon}</div>
                  <span
                    aria-hidden
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 14,
                      color: c.accent,
                      letterSpacing: "0.1em",
                    }}
                  >
                    →
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 14,
                    fontFamily: "var(--font-display)",
                    fontWeight: 800,
                    fontSize: 18,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: c.accent,
                    lineHeight: 1.05,
                  }}
                >
                  {c.label}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--rpc-text-muted)",
                  }}
                >
                  {c.partner} · {c.sport}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <PinwheelDivider />

      {/* HOW IT WORKS */}
      <section
        id="how-it-works"
        className="rpc-home-section"
        style={{ background: "var(--rpc-surface)", borderTop: "1px solid var(--rpc-border)" }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <div className="rpc-home-eyebrow">◈ HOW IT WORKS ◈</div>
            <h2 className="rpc-home-h2" style={{ marginTop: 12 }}>
              FROM SEARCH TO ACTION IN SECONDS
            </h2>
          </div>

          <div className="rpc-home-how-grid">
            {HOW_STEPS.map((step) => (
              <div
                key={step.n}
                style={{
                  background: "var(--rpc-surface-raised)",
                  border: "1px solid var(--rpc-border)",
                  borderLeft: "3px solid var(--rpc-red)",
                  borderRadius: "var(--radius-md)",
                  padding: "22px 22px 24px",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    letterSpacing: "0.2em",
                    color: "var(--rpc-red)",
                  }}
                >
                  {step.n} / {step.title}
                </div>
                <div
                  style={{
                    marginTop: 14,
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: "rgba(255,255,255,0.75)",
                  }}
                >
                  {step.copy}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* DEPTH FOLD */}
      <section className="rpc-home-section">
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ marginBottom: 40 }}>
            <div className="rpc-home-eyebrow">◈ FOR THE WAY YOU TRADE ◈</div>
            <h2 className="rpc-home-h2" style={{ marginTop: 12 }}>
              BUILT FOR THE WAY COLLECTORS ACTUALLY TRADE
            </h2>
          </div>

          <div className="rpc-home-depth-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {DEPTH_BULLETS.map((b, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                    padding: "12px 14px",
                    background: "var(--rpc-surface-raised)",
                    border: "1px solid var(--rpc-border)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 16,
                      color: "var(--rpc-red)",
                      lineHeight: 1,
                      marginTop: 2,
                      flexShrink: 0,
                      width: 16,
                    }}
                  >
                    {b.icon}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      lineHeight: 1.55,
                      color: "rgba(255,255,255,0.78)",
                    }}
                  >
                    {b.copy}
                  </span>
                </div>
              ))}
            </div>

            {/* TODO: replace this placeholder card with a real screenshot of the wallet analytics view. */}
            <div
              style={{
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: "var(--radius-md)",
                padding: "20px 18px",
                minHeight: 360,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: "0.18em",
                  color: "var(--rpc-text-muted)",
                  textTransform: "uppercase",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "var(--rpc-success)",
                    boxShadow: "0 0 8px var(--rpc-success)",
                  }}
                />
                LIVE FMV PREVIEW
              </div>
              <div
                style={{
                  flex: 1,
                  borderRadius: "var(--radius-sm)",
                  background:
                    "repeating-linear-gradient(0deg,transparent 0,transparent 23px,rgba(255,255,255,0.04) 23px,rgba(255,255,255,0.04) 24px),repeating-linear-gradient(90deg,transparent 0,transparent 23px,rgba(255,255,255,0.04) 23px,rgba(255,255,255,0.04) 24px)",
                  border: "1px solid var(--rpc-border)",
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: 12,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--rpc-text-muted)",
                }}
              >
                <div>
                  <div style={{ color: "var(--rpc-text-secondary)" }}>EDITION 84:2892</div>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: 28,
                      fontWeight: 800,
                      color: "var(--rpc-text-primary)",
                      lineHeight: 1.1,
                    }}
                  >
                    $148.00
                  </div>
                  <div style={{ color: "var(--rpc-success)" }}>↑ 12.4% / 7D</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                  <div>
                    <div style={{ color: "var(--rpc-text-ghost)" }}>P10</div>
                    <div style={{ color: "var(--rpc-text-secondary)" }}>$112</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--rpc-text-ghost)" }}>P50</div>
                    <div style={{ color: "var(--rpc-text-secondary)" }}>$148</div>
                  </div>
                  <div>
                    <div style={{ color: "var(--rpc-text-ghost)" }}>P90</div>
                    <div style={{ color: "var(--rpc-text-secondary)" }}>$210</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CREDIBILITY */}
      <section
        style={{
          background: "var(--rpc-surface)",
          borderTop: "1px solid var(--rpc-border)",
          borderBottom: "1px solid var(--rpc-border)",
          padding: "32px 24px",
        }}
      >
        <div className="rpc-home-trust-grid" style={{ maxWidth: 1200, margin: "0 auto" }}>
          {TRUST.map((t, i) => (
            <div
              key={i}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.55,
                color: "var(--rpc-text-muted)",
                letterSpacing: "0.02em",
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="rpc-home-section" style={{ textAlign: "center" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
          <div className="rpc-home-eyebrow">◈ PRICING ◈</div>
          <h2 className="rpc-home-h2">FREE DURING BETA.</h2>
          <p className="rpc-home-sub">
            RPC is in active development. Sign in to save wallets, set FMV alerts, and track your portfolio over time.
          </p>
          <Link
            href="/dashboard"
            style={{
              marginTop: 8,
              background: "var(--rpc-red)",
              color: "#fff",
              padding: "14px 28px",
              borderRadius: 6,
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            SIGN IN →
          </Link>
        </div>
      </section>

      {/* FINAL CTA */}
      <section
        className="rpc-home-section"
        style={{
          background: "var(--rpc-surface)",
          borderTop: "1px solid var(--rpc-border)",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
          <h2 className="rpc-home-h2">FIND YOUR EDGE.</h2>
          <p className="rpc-home-sub">Type any wallet to start.</p>
          <WalletSearch size="lg" />
        </div>
      </section>

      <SiteFooter />
      <MobileNav />
    </div>
  );
}
