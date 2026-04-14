"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const RED = "#E03A2F";

interface MarketPulse {
  commonFloor: number | null;
  rareFloor: number | null;
  legendaryFloor: number | null;
  indexedEditions: number;
}

interface CollectionPulseRow {
  collection_slug?: string;
  collection?: string;
  slug?: string;
  volume_24h?: number | null;
  sales_24h?: number | null;
  top_sale_24h?: number | null;
  [k: string]: unknown;
}

function fmtDollars(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function fmtUsd0(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

const PULSE_SLUG_MAP: Record<string, string> = {
  nba_top_shot: "nba-top-shot",
  nfl_all_day: "nfl-all-day",
  laliga_golazos: "laliga-golazos",
  disney_pinnacle: "disney-pinnacle",
};

const PULSE_COLLECTION_META: Record<string, { label: string; icon: string; accent: string }> = {
  "nba-top-shot": { label: "NBA Top Shot", icon: "\u{1F3C0}", accent: "#E03A2F" },
  "nfl-all-day": { label: "NFL All Day", icon: "\u{1F3C8}", accent: "#4F94D4" },
  "laliga-golazos": { label: "LaLiga Golazos", icon: "\u26BD", accent: "#22C55E" },
  "disney-pinnacle": { label: "Disney Pinnacle", icon: "\u2728", accent: "#A855F7" },
};

const QUICK_COLLECTIONS = [
  { id: "nba-top-shot", label: "NBA Top Shot", icon: "\u{1F3C0}", accent: "#E03A2F" },
  { id: "nfl-all-day", label: "NFL All Day", icon: "\u{1F3C8}", accent: "#4F94D4" },
  { id: "laliga-golazos", label: "LaLiga Golazos", icon: "\u26BD", accent: "#22C55E" },
  { id: "disney-pinnacle", label: "Disney Pinnacle", icon: "\u2728", accent: "#A855F7" },
];

export default function HomePage() {
  const [pulse, setPulse] = useState<MarketPulse | null>(null);
  const [pulseLoading, setPulseLoading] = useState(false);
  const [crossPulse, setCrossPulse] = useState<CollectionPulseRow[] | null>(null);
  const [crossPulseLoading, setCrossPulseLoading] = useState(true);

  useEffect(() => {
    setPulseLoading(true);
    fetch("/api/profile/market-pulse")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setPulse(d); })
      .catch(() => {})
      .finally(() => setPulseLoading(false));
  }, []);

  useEffect(() => {
    setCrossPulseLoading(true);
    fetch("/api/market-pulse")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d)) setCrossPulse(d as CollectionPulseRow[]);
      })
      .catch(() => {})
      .finally(() => setCrossPulseLoading(false));
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#111}
        ::-webkit-scrollbar-thumb{background:rgba(224,58,47,0.3);border-radius:2px}
        @media(max-width:768px){
          .rpc-main{padding:16px 16px 80px!important;}
        }
        .rpc-coll-card:hover .rpc-coll-glow{box-shadow:0 0 12px var(--glow-color)!important;border-color:var(--glow-color)!important;}
      `}</style>

      {/* Header */}
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid rgba(255,255,255,0.06)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, textDecoration: "none" }}>
            <svg width="28" height="28" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" fill="none" stroke="#E03A2F" strokeWidth="4" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(0 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(72 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(144 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(216 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(288 50 50)" />
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <div>
              <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 17, letterSpacing: "0.06em", color: "#F1F1F1", lineHeight: 1, textTransform: "uppercase" }}>
                Rip Packs <span style={{ color: RED }}>City</span>
              </div>
              <div style={{ fontSize: 7, fontFamily: monoFont, letterSpacing: "0.2em", color: "rgba(224,58,47,0.5)" }}>@RIPPACKSCITY</div>
            </div>
          </Link>
          <div style={{ flex: 1 }} />
          <Link href="/profile" style={{ background: "rgba(224,58,47,0.15)", border: "1px solid rgba(224,58,47,0.4)", color: RED, padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}>
            Profile
          </Link>
        </div>
      </header>

      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>

        {/* Hero */}
        <section style={{ textAlign: "center", marginBottom: 40, paddingTop: 24 }}>
          <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 42, letterSpacing: "0.04em", textTransform: "uppercase", lineHeight: 1.1, marginBottom: 10 }}>
            Rip Packs <span style={{ color: RED }}>City</span>
          </h1>
          <p style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.45)", letterSpacing: "0.06em", maxWidth: 480, margin: "0 auto" }}>
            Collector intelligence for NBA Top Shot, NFL All Day, LaLiga Golazos &amp; Disney Pinnacle. FMV pricing, sniper deals, badge tracking, and portfolio analytics.
          </p>
        </section>

        {/* Cross-collection Market Pulse */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
            Market Pulse
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {crossPulseLoading && !crossPulse && [0, 1, 2, 3].map((i) => (
              <div key={i} style={{ flex: "1 1 220px", minWidth: 220, height: 92, background: "#18181b", border: "1px solid #27272a", borderRadius: 8, opacity: 0.6 }} />
            ))}
            {!crossPulseLoading && crossPulse && crossPulse.map((row, i) => {
              const rawSlug = String(row.collection_slug ?? row.collection ?? row.slug ?? "");
              const slug = PULSE_SLUG_MAP[rawSlug] ?? rawSlug.replace(/_/g, "-");
              const meta = PULSE_COLLECTION_META[slug] ?? { label: slug, icon: "\u{1F4CA}", accent: "#9CA3AF" };
              const volume = Number(row.volume_24h ?? 0) || 0;
              const sales = Number(row.sales_24h ?? 0) || 0;
              const topSale = Number(row.top_sale_24h ?? 0) || 0;
              const hasActivity = volume > 0 || sales > 0;
              return (
                <Link
                  key={slug + i}
                  href={`/${slug}/analytics`}
                  style={{
                    flex: "1 1 220px",
                    minWidth: 220,
                    background: "#18181b",
                    border: "1px solid #27272a",
                    borderLeft: `3px solid ${meta.accent}`,
                    borderRadius: 8,
                    padding: "12px 14px",
                    textDecoration: "none",
                    color: "#fff",
                    display: "block",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 18 }}>{meta.icon}</span>
                    <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase" }}>{meta.label}</span>
                  </div>
                  {hasActivity ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>24h Vol</div>
                        <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800, color: meta.accent }}>{fmtDollars(volume)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Sales</div>
                        <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800 }}>{sales.toLocaleString()}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Top Sale</div>
                        <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800 }}>{fmtUsd0(topSale)}</div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em", textTransform: "uppercase" }}>No activity</div>
                  )}
                </Link>
              );
            })}
          </div>
        </section>

        {/* Collection quick-access grid */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: 12 }}>
            &#9670; COLLECTIONS &#9670;
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
            {QUICK_COLLECTIONS.map((col) => (
              <Link
                key={col.id}
                href={`/${col.id}/overview`}
                className="rpc-coll-card"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "16px 14px 12px",
                  position: "relative",
                  borderBottom: `2px solid ${col.accent}`,
                  transition: "all 0.2s ease",
                  textDecoration: "none",
                  color: "#fff",
                  display: "block",
                  // @ts-expect-error CSS custom property
                  "--glow-color": `${col.accent}66`,
                }}
              >
                <div className="rpc-coll-glow" style={{ position: "absolute", inset: 0, borderRadius: 8, border: "1px solid transparent", transition: "all 0.2s ease", pointerEvents: "none" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 24 }}>{col.icon}</span>
                  <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: 1.2 }}>
                    {col.label}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Market Pulse */}
        <MarketPulseWidget pulse={pulse} loading={pulseLoading} />

      </main>

      <SiteFooter />
      <MobileNav />
      <SupportChatConnected />
    </div>
  );
}

function MarketPulseWidget(props: { pulse: MarketPulse | null; loading: boolean }) {
  const stats = [
    { label: "Common Floor", value: props.pulse?.commonFloor != null ? fmtDollars(props.pulse.commonFloor) : "\u2014", color: "#6B7280" },
    { label: "Rare Floor", value: props.pulse?.rareFloor != null ? fmtDollars(props.pulse.rareFloor) : "\u2014", color: "#818CF8" },
    { label: "Legendary Floor", value: props.pulse?.legendaryFloor != null ? fmtDollars(props.pulse.legendaryFloor) : "\u2014", color: "#F59E0B" },
    { label: "Indexed Editions", value: props.pulse?.indexedEditions ? props.pulse.indexedEditions.toLocaleString() : "\u2014", color: "#34D399" },
  ];
  return (
    <section style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "14px 18px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34D399", animation: "pulse 2s infinite" }} />
        <span style={{ fontSize: 9, fontFamily: monoFont, letterSpacing: "0.2em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase" }}>Market Pulse</span>
        <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)", letterSpacing: "0.1em", marginLeft: "auto" }}>60s cache</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
        {stats.map((s) => (
          <div key={s.label}>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", marginBottom: 4, textTransform: "uppercase" }}>{s.label}</div>
            <div style={{ fontSize: 18, fontFamily: condensedFont, fontWeight: 800, color: props.loading ? "rgba(255,255,255,0.2)" : s.color }}>{props.loading ? "\u2026" : s.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
