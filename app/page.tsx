"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import RpcLogo from "@/components/RpcLogo";
import { publishedCollections } from "@/lib/collections";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const RED = "#E03A2F";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlatformPerCollection {
  slug: string;
  frontend_slug?: string | null;
  edition_count?: number | null;
  fmv_pct?: number | null;
  volume_24h?: number | null;
  display_order?: number | null;
}

interface PlatformStats {
  collection_count?: number;
  total_editions?: number;
  total_fmv_pct?: number;
  volume_24h?: number;
  per_collection?: PlatformPerCollection[];
}

interface SniperDeal {
  player_name?: string | null;
  set_name?: string | null;
  tier?: string | null;
  ask_price: number;
  fmv?: number | null;
  discount?: number | null;
  buy_url?: string | null;
  thumbnail_url?: string | null;
  serial_number?: number | null;
}

interface CollectionStatsResp {
  sniper_deals?: SniperDeal[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tierColor(tier?: string | null): string {
  switch ((tier || "").toLowerCase()) {
    case "ultimate":   return "#EC4899";
    case "legendary":  return "#F59E0B";
    case "rare":       return "#818CF8";
    case "challenger": return "#818CF8";
    case "uncommon":   return "#14B8A6";
    case "fandom":     return "#34D399";
    case "common":     return "#9CA3AF";
    case "contender":  return "#9CA3AF";
    default:           return "#6B7280";
  }
}

function fmtDollars(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function fmtUsd0(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

// Registry keyed by collection.id (the frontend slug — "nba-top-shot", "ufc",
// etc.). /api/platform-stats emits `frontend_slug` on every row, so we use
// that directly and no longer need to coerce DB slugs client-side.
const COLLECTION_REGISTRY: Record<string, { id: string; label: string; shortLabel: string; icon: string; accent: string }> = (() => {
  const out: Record<string, { id: string; label: string; shortLabel: string; icon: string; accent: string }> = {};
  for (const c of publishedCollections()) {
    out[c.id] = { id: c.id, label: c.label, shortLabel: c.shortLabel, icon: c.icon, accent: c.accent };
  }
  return out;
})();

const QUICK_COLLECTIONS = publishedCollections().map((c) => ({
  id: c.id,
  label: c.label,
  icon: c.icon,
  accent: c.accent,
}));

// ── Component ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [platform, setPlatform] = useState<PlatformStats | null>(null);
  const [platformLoading, setPlatformLoading] = useState(true);
  const [alldaySniper, setAlldaySniper] = useState<SniperDeal[] | null>(null);
  const [alldayError, setAlldayError] = useState(false);
  const [alldayLoading, setAlldayLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPlatformLoading(true);
    fetch("/api/platform-stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && typeof d === "object") setPlatform(d as PlatformStats); })
      .catch(() => { /* swallow */ })
      .finally(() => { if (!cancelled) setPlatformLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAlldayLoading(true);
    fetch("/api/collection-stats?collection=nfl-all-day")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CollectionStatsResp>;
      })
      .then((d) => {
        if (cancelled) return;
        setAlldaySniper(Array.isArray(d?.sniper_deals) ? d.sniper_deals : []);
      })
      .catch(() => { if (!cancelled) setAlldayError(true); })
      .finally(() => { if (!cancelled) setAlldayLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const collectionCount = platform?.collection_count ?? null;
  const totalEditions = platform?.total_editions ?? null;
  const fmvPct = platform?.total_fmv_pct ?? null;
  const volume24h = platform?.volume_24h ?? null;

  const perCollection = (platform?.per_collection ?? []).slice().sort((a, b) => {
    const ao = a.display_order ?? 999;
    const bo = b.display_order ?? 999;
    return ao - bo;
  });

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
          .rpc-kpi-row{grid-template-columns:repeat(2,1fr)!important;}
          .rpc-collection-grid{grid-template-columns:1fr!important;}
        }
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
        <section style={{ textAlign: "center", marginBottom: 32, paddingTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
            <RpcLogo size={92} />
          </div>
          <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 34, letterSpacing: "0.04em", textTransform: "uppercase", color: "#fff", lineHeight: 1.05, marginBottom: 8 }}>
            Rip Packs City
          </h1>
          <p style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.55)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 14 }}>
            Multi-Collection Sports NFT Intelligence
          </p>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", border: "1px solid rgba(224,58,47,0.45)", borderRadius: 999, background: "rgba(224,58,47,0.10)" }}>
            <span style={{ fontSize: 14 }}>{"\u{1F3C0}"}</span>
            <span style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: RED }}>
              {"Portland Trail Blazers \u00B7 Team Captain"}
            </span>
          </div>
        </section>

        {/* Platform KPIs */}
        <section style={{ marginBottom: 24 }}>
          <div className="rpc-kpi-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {(() => {
              const stats: Array<{ label: string; value: string; color: string }> = [
                { label: "Collections",    value: collectionCount != null ? String(collectionCount) : "\u2014", color: "#A855F7" },
                { label: "Total Editions", value: totalEditions != null ? totalEditions.toLocaleString() : "\u2014", color: "#fff" },
                { label: "FMV Coverage",   value: fmvPct != null ? `${Math.round(fmvPct)}%` : "\u2014", color: "#34D399" },
                { label: "24h Volume",     value: volume24h != null ? fmtUsd0(volume24h) : "\u2014", color: RED },
              ];
              return stats.map((s) => (
                <div key={s.label} style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontFamily: condensedFont, fontWeight: 800, color: platformLoading ? "rgba(255,255,255,0.25)" : s.color, lineHeight: 1 }}>
                    {platformLoading ? "\u2014" : s.value}
                  </div>
                </div>
              ));
            })()}
          </div>
        </section>

        {/* Per-collection Market Pulse */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
            Market Pulse
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {platformLoading && perCollection.length === 0 && [0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ flex: "1 1 220px", minWidth: 220, height: 96, background: "#18181b", border: "1px solid #27272a", borderRadius: 8, opacity: 0.6 }} />
            ))}
            {!platformLoading && perCollection.map((row) => {
              const frontendSlug = String(row.frontend_slug ?? row.slug ?? "");
              const meta = COLLECTION_REGISTRY[frontendSlug] ?? { id: frontendSlug, label: frontendSlug, shortLabel: frontendSlug, icon: "\u{1F4CA}", accent: "#9CA3AF" };
              const editions = Number(row.edition_count ?? 0) || 0;
              const fmvCoverage = Number(row.fmv_pct ?? 0) || 0;
              const volume = Number(row.volume_24h ?? 0) || 0;
              return (
                <Link
                  key={meta.id}
                  href={`/${meta.id}/overview`}
                  style={{
                    flex: "1 1 220px",
                    minWidth: 220,
                    background: "#18181b",
                    border: "1px solid #27272a",
                    borderBottom: `2px solid ${meta.accent}`,
                    borderRadius: 8,
                    padding: "12px 14px",
                    textDecoration: "none",
                    color: "#fff",
                    display: "block",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 18 }}>{meta.icon}</span>
                    <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase" }}>{meta.shortLabel}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Editions</div>
                      <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800 }}>{editions.toLocaleString()}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>FMV %</div>
                      <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800, color: "#34D399" }}>{Math.round(fmvCoverage)}%</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>24h Vol</div>
                      <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800, color: meta.accent }}>{fmtUsd0(volume)}</div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        {/* Live Sniper Deals (NFL All Day) */}
        {!alldayError && (
          <LiveSniperDeals deals={alldaySniper} loading={alldayLoading} />
        )}

        {/* Collection quick-access grid */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)", marginBottom: 12 }}>
            &#9670; COLLECTIONS &#9670;
          </div>
          <div className="rpc-collection-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {QUICK_COLLECTIONS.map((col) => (
              <Link
                key={col.id}
                href={`/${col.id}/overview`}
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: "16px 14px 14px",
                  borderBottom: `2px solid ${col.accent}`,
                  textDecoration: "none",
                  color: "#fff",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 24 }}>{col.icon}</span>
                  <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: 1.2 }}>
                    {col.label}
                  </div>
                </div>
                <span
                  style={{
                    alignSelf: "flex-start",
                    fontFamily: condensedFont,
                    fontWeight: 700,
                    fontSize: 10,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: col.accent,
                    border: `1px solid ${col.accent}55`,
                    background: `${col.accent}14`,
                    borderRadius: 4,
                    padding: "3px 8px",
                  }}
                >
                  Browse
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* About */}
        <section style={{ marginTop: 32, marginBottom: 32, padding: "18px 20px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
            About Rip Packs City
          </div>
          <p style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 1.7, color: "rgba(255,255,255,0.6)", letterSpacing: "0.02em" }}>
            RPC is a collector intelligence platform for Flow blockchain sports NFTs — analytics, deal-finding, sniper tools, FMV pricing, and badge tracking across NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike.
          </p>
          <p style={{ fontFamily: monoFont, fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,0.45)", letterSpacing: "0.02em", marginTop: 10 }}>
            Founded by Trevor, official Portland Trail Blazers Team Captain on NBA Top Shot.
          </p>
        </section>

      </main>

      <SiteFooter />
      <MobileNav />
      <SupportChatConnected />
    </div>
  );
}

// ── Live Sniper Deals (AllDay) ────────────────────────────────────────────────

function LiveSniperDeals({ deals, loading }: { deals: SniperDeal[] | null; loading: boolean }) {
  const list = deals ?? [];

  return (
    <section style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>
          {"Live Sniper Deals \u00B7 NFL All Day"}
        </div>
        <Link
          href="/nfl-all-day/sniper"
          style={{ marginLeft: "auto", fontSize: 10, fontFamily: monoFont, letterSpacing: "0.08em", textTransform: "uppercase", color: "#4F94D4", textDecoration: "none", border: "1px solid rgba(79,148,212,0.4)", borderRadius: 4, padding: "4px 10px" }}
        >
          {"All Day Sniper \u2192"}
        </Link>
      </div>

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ height: 128, background: "#18181b", border: "1px solid #27272a", borderRadius: 10, opacity: 0.5 }} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div style={{ padding: "20px 18px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, fontFamily: monoFont, color: "rgba(255,255,255,0.45)", letterSpacing: "0.06em", background: "#18181b", border: "1px solid #27272a", borderRadius: 10, flexWrap: "wrap", textAlign: "center" }}>
          <span>No live deals right now — check the</span>
          <Link href="/nfl-all-day/sniper" style={{ color: "#4F94D4", textDecoration: "none" }}>Sniper</Link>
          <span>for fresh listings.</span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {list.slice(0, 12).map((d, i) => {
            const ask = Number(d.ask_price ?? 0) || 0;
            const pct = typeof d.discount === "number" ? d.discount : null;
            const tc = tierColor(d.tier);
            return (
              <a
                key={`${d.buy_url ?? i}`}
                href={d.buy_url ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  background: "#18181b",
                  border: "1px solid #27272a",
                  borderLeft: "3px solid #4F94D4",
                  borderRadius: 10,
                  padding: "12px 14px",
                  textDecoration: "none",
                  color: "#fff",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  {d.tier && (
                    <span style={{ fontSize: 9, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: tc, background: `${tc}22`, border: `1px solid ${tc}55`, padding: "2px 6px", borderRadius: 3 }}>
                      {d.tier}
                    </span>
                  )}
                  {pct != null && pct > 0 && (
                    <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: condensedFont, fontWeight: 800, letterSpacing: "0.05em", color: "#E03A2F", background: "rgba(224,58,47,0.18)", border: "1px solid rgba(224,58,47,0.4)", padding: "2px 6px", borderRadius: 4 }}>
                      -{Math.round(pct)}%
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.02em", lineHeight: 1.15, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.player_name ?? "\u2014"}
                </div>
                <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.45)", letterSpacing: "0.04em", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.set_name ?? ""}
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 18, color: "#34D399", lineHeight: 1 }}>
                    {fmtDollars(ask)}
                  </div>
                  <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: condensedFont, fontWeight: 700, letterSpacing: "0.08em", color: "#4F94D4", border: "1px solid rgba(79,148,212,0.45)", borderRadius: 4, padding: "3px 8px", textTransform: "uppercase" }}>
                    Buy
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
