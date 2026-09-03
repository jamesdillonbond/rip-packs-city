"use client";

import { useEffect } from "react";
import Link from "next/link";
import { trackFunnelEvent } from "@/lib/track-funnel";
import WalletSearch from "@/components/WalletSearch";
import RpcLogo from "@/components/RpcLogo";
import SiteFooter from "@/components/SiteFooter";
import MobileNav from "@/components/MobileNav";
import PinwheelDivider from "@/components/visual/PinwheelDivider";
import HomeFmvPreview from "@/components/HomeFmvPreview";
import { publishedCollections } from "@/lib/collections";
import { organizationJsonLd } from "@/lib/seo";

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
          <Link href="/insights" style={navLinkStyle}>
            Insights
          </Link>
          <a href="#collections" style={navLinkStyle}>
            Collections
          </a>
          <a href="#how-it-works" style={navLinkStyle}>
            How it works
          </a>
          <a href="#pricing" style={navLinkStyle}>
            Pricing
          </a>
          {/* /login, NOT /dashboard. /dashboard is gated, so an anonymous visitor
              clicking "Sign In" was bounced through proxy.ts to /login anyway —
              an extra redirect on the single most important funnel click, and one
              that loses the click if the proxy round-trip hiccups. (2026-08-01) */}
          <Link
            href="/login"
            onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: "home_header" })}
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
  // Defensible, non-fabricated values. "5 collections" is exact; "4M+ sales
  // indexed" is a safe floor (the sales table only grows — live row estimate
  // ~4.7M on 2026-08-05, and reltuples under-counts between analyzes); "20 MIN"
  // is the cron cadence; "24/7" reflects the always-on pipeline. Avoid absolute/
  // stale claims like "100% Uptime" or a precise refresh count that drifts.
  { value: "5", label: "Collections Tracked" },
  { value: "4M+", label: "Sales Indexed" },
  { value: "20 MIN", label: "Live Refresh" },
  { value: "24/7", label: "Live Pipeline" },
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
    copy: "We pull live FMV from sales data, real listings from Top Shot, badges, serials, and series labels.",
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
  { icon: "⚡", copy: "Real-time deal sniping on Top Shot." },
  { icon: "✦", copy: "Badge-aware pricing — Top Shot Debut, Rookie Year, Championship, Fresh." },
  { icon: "◉", copy: "Set bottleneck finder — cheapest path to completion." },
  // NOT "buy / skip recommendations": RPC does not make buy/sell calls — the
  // concierge system prompt bans that phrasing outright. What actually ships is
  // the typical-pull median alongside EV-vs-retail, which is the honest claim.
  { icon: "▣", copy: "Pack EV calculations, depletion-aware, led by the typical pull — not the average." },
];

const TRUST: string[] = [
  "Built in Portland, Oregon by an independent collector.",
  "Live pipelines updated every 20 minutes.",
  "Automated monitoring and alerting on every data pipeline.",
];

export default function HomePageMarketing() {
  const collections = publishedCollections();

  // Funnel: log the anon arrival once per mount. Fire-and-forget.
  useEffect(() => {
    trackFunnelEvent({ eventType: "home_view", surface: "home" });
  }, []);

  // WebSite entity carrying the sitelinks SearchAction. The root layout already
  // emits the WebApplication (organizationJsonLd) on every page; this is a
  // distinct WebSite type (where schema.org expects potentialAction) rather
  // than a second near-identical WebApplication — fixes the duplicate-JSON-LD
  // finding from the 2026-06-12 audit. (2026-06-13)
  const webSiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: organizationJsonLd.name,
    url: organizationJsonLd.url,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"}/share/{search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webSiteJsonLd) }}
      />

      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
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
        .rpc-home-trophy-grid{display:grid;grid-template-columns:1fr 1.2fr;gap:48px;align-items:center;}
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
          .rpc-home-trophy-grid{grid-template-columns:1fr;gap:24px;}
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
        {/*
          The <h1> is the SEARCHED QUESTION, not the brand name (changed
          2026-08-01). "Rip Packs City" optimised for people who already knew RPC
          existed — a set that numbered 39 Google referrals lifetime. The brand
          still carries in the eyebrow, the nav logo and <title>; the h1 now
          matches what a collector actually types. The wallet input sits directly
          beneath it, above the fold, so the page answers its own headline.
        */}
        <div className="rpc-home-eyebrow">◈ RIP PACKS CITY · COLLECTOR INTELLIGENCE ◈</div>
        <h1 className="rpc-home-h1">
          What is your <span className="rpc-home-h1-accent">collection</span> worth?
        </h1>
        <p className="rpc-home-sub">
          Paste a Top Shot username or Flow wallet and see every moment priced at live FMV — free, no signup. Covering NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike.
        </p>
        <WalletSearch
            surface="home"
            variant="hero"
            hint="No signup required. Try a wallet address, username, or moment ID."
          />
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

      {/* PUBLIC INSIGHTS PROMO */}
      <section
        className="rpc-home-section"
        style={{
          background: "var(--rpc-surface)",
          borderTop: "1px solid var(--rpc-red-border)",
          borderBottom: "1px solid var(--rpc-border)",
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 18 }}>
          <div className="rpc-home-eyebrow">◈ FREE INTELLIGENCE · NO SIGNUP ◈</div>
          <h2 className="rpc-home-h2">THINGS TOP SHOT WON&rsquo;T TELL YOU</h2>
          <p className="rpc-home-sub">
            The Lock-Rate Squeeze Board, Pack Reality, the 2025 Rookie Index, First-Mint Trophy Tracker, and the Cross-Collection Whale Map — the math the marketplace structurally won&rsquo;t ship. Free, no account needed.
          </p>
          <Link
            href="/insights"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 22px",
              background: "var(--rpc-red)",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: 13,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            EXPLORE PUBLIC INSIGHTS →
          </Link>
        </div>
      </section>

      {/* FAST BREAK OPTIMIZER PROMO - HIDDEN for launch; set NEXT_PUBLIC_SHOW_FAST_BREAK=1 to restore */}
      {process.env.NEXT_PUBLIC_SHOW_FAST_BREAK === "1" && (
      <section
        className="rpc-home-section"
        style={{
          background: "var(--rpc-surface)",
          borderTop: "1px solid var(--rpc-red-border)",
          borderBottom: "1px solid var(--rpc-border)",
        }}
      >
        <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 18 }}>
          <div className="rpc-home-eyebrow">◈ FREE TOOL · NO SIGNUP ◈</div>
          <h2 className="rpc-home-h2">FAST BREAK LINEUP OPTIMIZER</h2>
          <p className="rpc-home-sub">
            Daily optimal NBA Top Shot Fast Break lineups for the Playoffs. Top projected fantasy scorers, captain picks, and matchup analysis — refreshed every 15 minutes.
          </p>
          <Link
            href="/nba/fast-break"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 22px",
              background: "var(--rpc-red)",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: 13,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            VIEW TODAY&rsquo;S OPTIMAL LINEUP →
          </Link>
        </div>
      </section>
      )}

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

            {/* Live FMV preview — fetches the public /api/fmv/demo endpoint and
                renders a real recent sample (FMV + confidence + serial-premium
                math), with a clearly-labelled SAMPLE fallback. */}
            <HomeFmvPreview />
          </div>
        </div>
      </section>

      {/* TROPHY CASE — the thing the campaign asks people to build, which
          this page never mentioned (2026-09-02 onboarding QA, finding #8). The
          example is a REAL case (the OG card the share link unfurls into), not
          a mock-up, so the promise and the product are the same picture. */}
      <section className="rpc-home-section" data-home-trophy-case>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div className="rpc-home-trophy-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 16, justifyContent: "center" }}>
              <div className="rpc-home-eyebrow">◈ SHOW OFF YOUR BEST ◈</div>
              <h2 className="rpc-home-h2">BUILD YOUR TROPHY CASE</h2>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  lineHeight: 1.7,
                  color: "rgba(255,255,255,0.78)",
                  margin: 0,
                  maxWidth: 460,
                }}
              >
                Pin your 6 best Moments from any collection, add a caption to each, and get a page
                and social card of your own — rippackscity.com/profile/<span style={{ color: "var(--rpc-text-primary)" }}>you</span>/trophy-case.
                Post it on X or drop it in Discord; the card unfurls with your slabs on it.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <Link
                  href="/login"
                  onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: "home_trophy_case" })}
                  style={{
                    background: "var(--rpc-red)",
                    color: "#fff",
                    padding: "12px 22px",
                    borderRadius: 6,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 700,
                    fontSize: 12,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    textDecoration: "none",
                  }}
                >
                  BUILD YOURS — FREE →
                </Link>
                <Link
                  href="/profile/jamesdillonbond/trophy-case"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--rpc-text-muted)",
                    textDecoration: "none",
                  }}
                >
                  See a live case →
                </Link>
              </div>
            </div>
            <Link
              href="/profile/jamesdillonbond/trophy-case"
              aria-label="A real Rip Packs City trophy case"
              style={{
                display: "block",
                borderRadius: 12,
                overflow: "hidden",
                border: "1px solid var(--rpc-border)",
                background: "var(--rpc-surface)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- the OG route renders a PNG at 1200x630; next/image cannot optimise a dynamic route */}
              <img
                src="/api/og/trophy-case/jamesdillonbond"
                alt="Example trophy case: six slabbed Moments with tier-coloured frames on a Rip Packs City share card"
                width={1200}
                height={630}
                loading="lazy"
                style={{ display: "block", width: "100%", height: "auto" }}
              />
            </Link>
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
            Searching wallets and public insights are free with no signup. A free account — instant, no invite needed — adds saved wallets, FMV alerts, and portfolio tracking over time.
          </p>
          <Link
            href="/login"
            onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: "home_pricing" })}
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
            CREATE FREE ACCOUNT →
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
          <WalletSearch
            surface="home"
            variant="hero"
            hint="No signup required. Try a wallet address, username, or moment ID."
          />
        </div>
      </section>

      <SiteFooter />
      <MobileNav />
    </div>
  );
}
