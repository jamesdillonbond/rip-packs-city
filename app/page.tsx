"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import RpcLogo from "@/components/RpcLogo";

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

interface CrossDeal {
  collection_slug?: string;
  collection?: string;
  player_name?: string;
  set_name?: string;
  tier?: string;
  ask_price?: number;
  fmv?: number;
  discount?: number;
  discount_pct?: number;
  buy_url?: string;
  thumbnail_url?: string | null;
  [k: string]: unknown;
}

interface CrossDealsResponse {
  deals?: CrossDeal[];
  per_collection?: Record<string, number>;
  total?: number;
  [k: string]: unknown;
}

const DEAL_COLLECTION_META: Record<string, { label: string; icon: string; accent: string; sniperPath: string }> = {
  "nba-top-shot":    { label: "Top Shot",    icon: "\u{1F3C0}", accent: "#E03A2F", sniperPath: "/nba-top-shot/sniper" },
  "nba_top_shot":    { label: "Top Shot",    icon: "\u{1F3C0}", accent: "#E03A2F", sniperPath: "/nba-top-shot/sniper" },
  "nfl-all-day":     { label: "All Day",     icon: "\u{1F3C8}", accent: "#4F94D4", sniperPath: "/nfl-all-day/sniper" },
  "nfl_all_day":     { label: "All Day",     icon: "\u{1F3C8}", accent: "#4F94D4", sniperPath: "/nfl-all-day/sniper" },
  "laliga-golazos":  { label: "Golazos",     icon: "\u26BD",    accent: "#22C55E", sniperPath: "/laliga-golazos/sniper" },
  "laliga_golazos":  { label: "Golazos",     icon: "\u26BD",    accent: "#22C55E", sniperPath: "/laliga-golazos/sniper" },
  "disney-pinnacle": { label: "Pinnacle",    icon: "\u2728",    accent: "#A855F7", sniperPath: "/disney-pinnacle/sniper" },
  "disney_pinnacle": { label: "Pinnacle",    icon: "\u2728",    accent: "#A855F7", sniperPath: "/disney-pinnacle/sniper" },
  "ufc":             { label: "UFC Strike",  icon: "\u{1F94A}", accent: "#EF4444", sniperPath: "/ufc/sniper" },
  "ufc_strike":      { label: "UFC Strike",  icon: "\u{1F94A}", accent: "#EF4444", sniperPath: "/ufc/sniper" },
};

function tierColor(tier?: string): string {
  switch ((tier || "").toLowerCase()) {
    case "ultimate":   return "#EC4899";
    case "legendary":  return "#F59E0B";
    case "rare":       return "#818CF8";
    case "uncommon":   return "#14B8A6";
    case "fandom":     return "#9CA3AF";
    default:           return "#6B7280";
  }
}

function discountColor(pct: number): string {
  if (pct >= 30) return "#22C55E";
  if (pct >= 15) return "#F59E0B";
  return "#9CA3AF";
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
  const [crossDeals, setCrossDeals] = useState<CrossDealsResponse | null>(null);
  const [crossDealsLoading, setCrossDealsLoading] = useState(true);

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

  useEffect(() => {
    setCrossDealsLoading(true);
    fetch("/api/cross-collection-deals?limit=12&minDiscount=10")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d === "object") setCrossDeals(d as CrossDealsResponse); })
      .catch(() => {})
      .finally(() => setCrossDealsLoading(false));
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
            <RpcLogo size={32} />
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
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
            <RpcLogo size={100} />
          </div>
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
                  {(() => {
                    const listings = Number(row.listings_count ?? row.active_listings ?? row.listing_count ?? 0) || 0;
                    return hasActivity ? null : (
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", letterSpacing: "0.06em" }}>No recent sales</span>
                        {listings > 0 && (
                          <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em" }}>
                            &middot; {listings.toLocaleString()} listings
                          </span>
                        )}
                      </div>
                    );
                  })()}
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
                  ) : null}
                </Link>
              );
            })}
          </div>
        </section>

        {/* Cross-collection deals */}
        <CrossCollectionDeals data={crossDeals} loading={crossDealsLoading} />

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

function CrossCollectionDeals({ data, loading }: { data: CrossDealsResponse | null; loading: boolean }) {
  const deals = data?.deals ?? [];
  const perCollection = data?.per_collection ?? {};
  const total = data?.total ?? deals.length;

  const summaryParts: string[] = [];
  for (const [slug, count] of Object.entries(perCollection)) {
    const meta = DEAL_COLLECTION_META[slug];
    if (!meta || !count) continue;
    summaryParts.push(`${count} ${meta.label}`);
  }

  return (
    <section style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>
          Best Deals · All Collections
        </div>
        {!loading && total > 0 && (
          <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.08em" }}>
            {total} deals{summaryParts.length > 0 ? ` — ${summaryParts.join(", ")}` : ""}
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ height: 128, background: "#18181b", border: "1px solid #27272a", borderRadius: 10, opacity: 0.5 }} />
          ))}
        </div>
      ) : deals.length === 0 ? (
        <div style={{ padding: "20px 18px", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 12, fontFamily: monoFont, color: "rgba(255,255,255,0.45)", letterSpacing: "0.06em" }}>
          <span style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.15)", borderTopColor: RED, borderRadius: "50%", display: "inline-block", animation: "rpcSpin 0.9s linear infinite" }} />
          <span>No cross-collection deals right now &mdash; Top Shot deals loading&hellip;</span>
          <style>{`@keyframes rpcSpin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {deals.map((d, i) => {
            const slug = String(d.collection_slug ?? d.collection ?? "");
            const meta = DEAL_COLLECTION_META[slug] ?? { label: slug, icon: "\u{1F4CA}", accent: "#9CA3AF", sniperPath: "/" };
            const ask = Number(d.ask_price ?? 0) || 0;
            const fmv = Number(d.fmv ?? 0) || 0;
            const pct = Number(d.discount_pct ?? d.discount ?? 0) || 0;
            const tc = tierColor(d.tier);
            const dc = discountColor(pct);
            return (
              <a
                key={`${slug}-${d.buy_url ?? i}`}
                href={d.buy_url ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  background: "#18181b",
                  border: "1px solid #27272a",
                  borderLeft: `3px solid ${meta.accent}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                  textDecoration: "none",
                  color: "#fff",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14 }}>{meta.icon}</span>
                  <span style={{ fontSize: 9, fontFamily: monoFont, letterSpacing: "0.12em", textTransform: "uppercase", color: meta.accent }}>{meta.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: condensedFont, fontWeight: 800, letterSpacing: "0.05em", color: dc, background: `${dc}22`, border: `1px solid ${dc}55`, padding: "2px 6px", borderRadius: 4 }}>
                    -{pct.toFixed(0)}%
                  </span>
                </div>
                <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.02em", lineHeight: 1.15, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.player_name ?? "Unknown"}
                </div>
                <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.45)", letterSpacing: "0.04em", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.set_name ?? ""}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {d.tier && (
                    <span style={{ fontSize: 9, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: tc, background: `${tc}22`, border: `1px solid ${tc}55`, padding: "2px 6px", borderRadius: 3 }}>
                      {d.tier}
                    </span>
                  )}
                  <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 17, color: "#fff", lineHeight: 1 }}>
                      {fmtDollars(ask)}
                    </div>
                    {fmv > 0 && (
                      <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.35)", textDecoration: "line-through", marginTop: 2 }}>
                        {fmtDollars(fmv)}
                      </div>
                    )}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}

      {!loading && deals.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {QUICK_COLLECTIONS.map((col) => (
            <Link
              key={col.id}
              href={`/${col.id}/sniper`}
              style={{ fontSize: 10, fontFamily: monoFont, letterSpacing: "0.08em", textTransform: "uppercase", color: col.accent, textDecoration: "none", border: `1px solid ${col.accent}55`, borderRadius: 4, padding: "4px 10px" }}
            >
              {col.icon} {col.label} Sniper
            </Link>
          ))}
        </div>
      )}
    </section>
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
