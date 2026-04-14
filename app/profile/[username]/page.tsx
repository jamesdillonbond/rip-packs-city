"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import CostBasisCard from "@/components/profile/CostBasisCard";
import TierBreakdownCard from "@/components/profile/TierBreakdownCard";
import TopMoversCard from "@/components/profile/TopMoversCard";
import CollectionBreakdownCard from "@/components/profile/CollectionBreakdownCard";
import PortfolioSparkline from "@/components/profile/PortfolioSparkline";
import PublicTrophyCase from "@/components/profile/PublicTrophyCase";
import AchievementsCard from "@/components/profile/AchievementsCard";

// ── Types ─────────────────────────────────────────────────────────
interface TrophyMoment {
  id?: number;
  slot: number;
  moment_id: string;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  circulation_count: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  fmv: number | null;
  badges: string[] | null;
}

interface ProfileBio {
  display_name: string | null;
  tagline: string | null;
  favorite_team: string | null;
  twitter: string | null;
  discord: string | null;
  avatar_url: string | null;
}

interface SavedWalletPublic {
  wallet_addr: string;
  username: string | null;
  display_name: string | null;
  cached_fmv: number | null;
  cached_moment_count: number | null;
  cached_top_tier: string | null;
  cached_rpc_score: number | null;
  cached_badges: string[] | null;
  accent_color: string;
}

interface PortfolioSnapshot {
  snapshot_date: string;
  total_fmv: number;
}

interface SniperDealPreview {
  playerName: string;
  tier: string;
  askPrice: number;
  adjustedFmv: number;
  discount: number;
  buyUrl: string;
  source: string;
}

// ── Constants ─────────────────────────────────────────────────────
const monoFont = "'Share Tech Mono', monospace";
const condensedFont = "'Barlow Condensed', sans-serif";
const MAX_SLOTS = 6;

// ── Helpers ───────────────────────────────────────────────────────
function fmtDollars(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function tierColor(t: string | null): string {
  switch ((t ?? "").toUpperCase()) {
    case "LEGENDARY": return "var(--tier-legendary)";
    case "ULTIMATE": return "var(--tier-ultimate)";
    case "RARE": return "var(--tier-rare)";
    case "UNCOMMON": return "var(--tier-uncommon)";
    case "FANDOM": return "var(--tier-fandom)";
    default: return "var(--tier-common)";
  }
}

function holoClass(t: string | null): string {
  switch ((t ?? "").toUpperCase()) {
    case "LEGENDARY": return "rpc-holo-legendary";
    case "ULTIMATE": return "rpc-holo-ultimate";
    case "RARE": return "rpc-holo-rare";
    default: return "";
  }
}

function scoreColor(score: number): string {
  if (score >= 800) return "var(--rpc-success)";
  if (score >= 500) return "var(--rpc-warning)";
  return "var(--rpc-danger)";
}

function thumbnailSrc(url: string | null): string {
  if (url) return url;
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23111' width='200' height='200'/%3E%3C/svg%3E";
}

// ── Card style ────────────────────────────────────────────────────
const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.02)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 10,
  padding: "16px 20px",
};

const labelStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: monoFont,
  letterSpacing: "0.2em",
  color: "rgba(255,255,255,0.4)",
  textTransform: "uppercase" as const,
};

// ── Sparkline SVG ─────────────────────────────────────────────────
function Sparkline(props: { data: number[]; width?: number; height?: number; color?: string }) {
  const { data, width = 200, height = 40, color = "#E03A2F" } = props;
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map(function(v, i) {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return x + "," + y;
  }).join(" ");
  return (
    <svg width={width} height={height} viewBox={"0 0 " + width + " " + height} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Trophy Slot ───────────────────────────────────────────────────
function PublicTrophySlot(props: { slot: number; trophy: TrophyMoment | null }) {
  const [hovered, setHovered] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const t = props.trophy;
  const tc = tierColor(t?.tier ?? null);
  const slotLabels = ["", "🥇", "🥈", "🥉", "⭐", "⭐", "⭐"];

  if (!t) {
    return (
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 10, aspectRatio: "3/4", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <div style={{ fontSize: 24, opacity: 0.15 }}>🏆</div>
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.2)", letterSpacing: "0.1em" }}>EMPTY SLOT</div>
      </div>
    );
  }

  return (
    <div
      className={holoClass(t.tier)}
      style={{ position: "relative", borderRadius: 10, overflow: "hidden", aspectRatio: "3/4", border: "1px solid " + tc + "44", cursor: "default", transition: "all 0.2s", transform: hovered ? "translateY(-3px)" : "translateY(0)", boxShadow: hovered ? "0 12px 40px " + tc + "22" : "none" }}
      onMouseEnter={function() { setHovered(true); }}
      onMouseLeave={function() { setHovered(false); }}
    >
      <div style={{ position: "absolute", inset: 0, background: "#111" }}>
        {t.video_url && !videoError && hovered ? (
          <video src={t.video_url} autoPlay muted loop playsInline onError={function() { setVideoError(true); }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <img src={thumbnailSrc(t.thumbnail_url)} alt={t.player_name ?? "Moment"} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={function(e) { e.currentTarget.style.opacity = "0.3"; }} />
        )}
      </div>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.3) 50%, transparent 100%)" }} />
      <div style={{ position: "absolute", top: 10, left: 10 }}>
        <span className="rpc-chip" style={{ color: tc, background: tc + "18", borderColor: tc + "44" }}>{(t.tier ?? "COMMON").toUpperCase()}</span>
      </div>
      <div style={{ position: "absolute", top: 10, right: 10 }}>
        <span style={{ fontSize: 14 }}>{slotLabels[props.slot]}</span>
      </div>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "12px 12px 14px" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 15, color: "#fff", letterSpacing: "0.04em", lineHeight: 1.1, marginBottom: 4 }}>{t.player_name ?? "Unknown"}</div>
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.5)", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.set_name ?? ""}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontFamily: condensedFont, fontWeight: 700, color: tc }}>
            {t.serial_number != null ? ("#" + t.serial_number + " / " + (t.circulation_count ?? "?")) : ""}
          </span>
          {t.fmv != null && <span style={{ fontSize: 10, fontFamily: monoFont, color: "var(--rpc-success)" }}>{fmtDollars(t.fmv)}</span>}
        </div>
        {(t.badges ?? []).length > 0 && (
          <div style={{ display: "flex", gap: 3, marginTop: 5 }}>
            {(t.badges ?? []).slice(0, 3).map(function(b, i) { return <span key={i} style={{ fontSize: 10 }}>{b}</span>; })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Avatar ────────────────────────────────────────────────────────
function Avatar(props: { username: string; bio: ProfileBio | null; size?: number }) {
  const { username, bio, size = 64 } = props;
  const initials = username ? username.slice(0, 2).toUpperCase() : "?";

  if (bio?.avatar_url) {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", border: "2px solid rgba(224,58,47,0.4)", flexShrink: 0 }}>
        <img
          src={bio.avatar_url}
          alt={username}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={function(e) {
            e.currentTarget.style.display = "none";
            if (e.currentTarget.parentElement) {
              e.currentTarget.parentElement.innerHTML = initials;
              Object.assign(e.currentTarget.parentElement.style, {
                background: "rgba(224,58,47,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: condensedFont,
                fontWeight: "800",
                fontSize: (size * 0.35) + "px",
                color: "#E03A2F",
              });
            }
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "rgba(224,58,47,0.15)", border: "2px solid rgba(224,58,47,0.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, fontWeight: 800, color: "#E03A2F", fontFamily: condensedFont, flexShrink: 0 }}>
      {initials}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────
export default function PublicProfilePage() {
  const router = useRouter();
  const params = useParams();
  const username = params?.username as string;

  // State
  const [trophies, setTrophies] = useState<(TrophyMoment | null)[]>([null, null, null, null, null, null]);
  const [bio, setBio] = useState<ProfileBio | null>(null);
  const [wallets, setWallets] = useState<SavedWalletPublic[]>([]);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [sniperDeals, setSniperDeals] = useState<SniperDealPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [sniperLoading, setSniperLoading] = useState(true);

  // Fetch all data on mount
  useEffect(function() {
    if (!username) return;
    setLoading(true);

    const enc = encodeURIComponent(username);

    // Fetch trophies
    const trophyP = fetch("/api/profile/trophy?username=" + enc)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        const slots: (TrophyMoment | null)[] = [null, null, null, null, null, null];
        (data.trophies ?? []).forEach(function(t: TrophyMoment) {
          if (t.slot >= 1 && t.slot <= MAX_SLOTS) slots[t.slot - 1] = t;
        });
        setTrophies(slots);
      })
      .catch(function() {});

    // Fetch bio
    const bioP = fetch("/api/profile/bio?ownerKey=" + enc)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (data?.bio) setBio(data.bio); })
      .catch(function() {});

    // Fetch saved wallets (for stats)
    const walletsP = fetch("/api/profile/saved-wallets?ownerKey=" + enc)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data?.wallets) setWallets(data.wallets);
      })
      .catch(function() {});

    // Fetch portfolio history for sparkline
    const historyP = fetch("/api/profile/portfolio-history?ownerKey=" + enc + "&days=30")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (data?.snapshots) setSnapshots(data.snapshots); })
      .catch(function() {});

    Promise.all([trophyP, bioP, walletsP, historyP]).finally(function() { setLoading(false); });
  }, [username]);

  // Fetch sniper deals
  useEffect(function() {
    setSniperLoading(true);
    fetch("/api/sniper-feed?limit=3")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data?.deals) return;
        setSniperDeals(data.deals.slice(0, 3));
      })
      .catch(function() {})
      .finally(function() { setSniperLoading(false); });
  }, []);

  // Derived stats
  const filledCount = trophies.filter(Boolean).length;
  const totalFmv = wallets.reduce(function(sum, w) { return sum + (w.cached_fmv ?? 0); }, 0);
  const totalMoments = wallets.reduce(function(sum, w) { return sum + (w.cached_moment_count ?? 0); }, 0);
  const totalBadges = wallets.reduce(function(sum, w) { return sum + (w.cached_badges?.length ?? 0); }, 0);
  const rpcScore = wallets.length > 0 ? wallets[0]?.cached_rpc_score ?? null : null;
  const isTeamCaptain = username === "jamesdillonbond";

  // Sparkline data
  const sparkData = snapshots.map(function(s) { return s.total_fmv; });
  const sparkChange = sparkData.length >= 2
    ? ((sparkData[sparkData.length - 1] - sparkData[0]) / (sparkData[0] || 1)) * 100
    : null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "#fff" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      `}</style>

      {/* NAV */}
      <header style={{ background: "rgba(8,8,8,0.97)", borderBottom: "1px solid var(--rpc-border)", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", gap: 20 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <svg width="28" height="28" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" fill="none" stroke="#E03A2F" strokeWidth="4" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(0 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(72 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(144 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(216 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill="#E03A2F" transform="rotate(288 50 50)" />
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 17, letterSpacing: "0.06em", color: "#F1F1F1", lineHeight: 1, textTransform: "uppercase" }}>
              {"Rip Packs "}<span style={{ color: "#E03A2F" }}>City</span>
            </div>
          </Link>
          <div style={{ flex: 1 }} />
          <Link href={"/nba-top-shot/collection?q=" + encodeURIComponent(username)} className="rpc-btn-ghost" style={{ textDecoration: "none", fontSize: 10 }}>
            {"ANALYZE " + username.toUpperCase() + "'S WALLET →"}
          </Link>
        </div>
      </header>

      <main style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px 60px", animation: "fadeIn 0.4s ease both" }}>

        {/* ── Profile Header + Bio ── */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
            <Avatar username={username} bio={bio} size={72} />
          </div>
          <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 32, letterSpacing: "0.06em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1, marginBottom: 6 }}>
            {bio?.display_name ?? username}
          </h1>
          {bio?.tagline && (
            <div style={{ fontSize: 11, fontFamily: monoFont, color: "var(--rpc-text-secondary)", marginBottom: 6, letterSpacing: "0.06em" }}>
              {bio.tagline}
            </div>
          )}
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", letterSpacing: "0.15em" }}>
            {"NBA TOP SHOT COLLECTOR · " + filledCount + " / " + MAX_SLOTS + " TROPHY MOMENTS"}
          </div>
          {isTeamCaptain && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, padding: "4px 12px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: "var(--radius-sm)", fontSize: 9, fontFamily: monoFont, letterSpacing: "0.1em", color: "var(--rpc-red)" }}>
              <span style={{ color: "var(--rpc-success)" }}>✓</span> PORTLAND TRAIL BLAZERS TEAM CAPTAIN
            </div>
          )}
          {(bio?.twitter || bio?.discord) && (
            <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 10 }}>
              {bio?.twitter && (
                <a href={"https://twitter.com/" + bio.twitter} target="_blank" rel="noreferrer" style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", textDecoration: "none", letterSpacing: "0.1em" }}>
                  @{bio.twitter}
                </a>
              )}
              {bio?.discord && (
                <span style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", letterSpacing: "0.1em" }}>
                  {bio.discord}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── Achievements ── */}
        {username && (
          <div style={{ marginBottom: 24 }}>
            <AchievementsCard ownerKey={username} />
          </div>
        )}

        {/* ── Stat Tiles ── */}
        <div style={{ display: "grid", gridTemplateColumns: rpcScore != null ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
          {/* RPC Score */}
          {rpcScore != null && (
            <div style={{ ...cardStyle, textAlign: "center", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: scoreColor(rpcScore), opacity: 0.7 }} />
              <div style={labelStyle}>RPC SCORE</div>
              <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 28, color: scoreColor(rpcScore), lineHeight: 1, margin: "8px 0 4px" }}>{rpcScore}</div>
              <div style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em" }}>POWERED BY TOP SHOT SCORE</div>
            </div>
          )}
          {/* Portfolio FMV */}
          <div style={{ ...cardStyle, textAlign: "center" }}>
            <div style={labelStyle}>PORTFOLIO FMV</div>
            <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 24, color: "var(--rpc-text-primary)", lineHeight: 1, margin: "8px 0 4px" }}>
              {totalFmv > 0 ? fmtDollars(totalFmv) : "—"}
            </div>
            {sparkData.length >= 2 && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, marginTop: 4 }}>
                <Sparkline data={sparkData} width={120} height={24} color={sparkChange != null && sparkChange >= 0 ? "#34D399" : "#F87171"} />
                {sparkChange != null && (
                  <span style={{ fontSize: 9, fontFamily: monoFont, color: sparkChange >= 0 ? "var(--rpc-success)" : "var(--rpc-danger)", letterSpacing: "0.1em" }}>
                    {sparkChange >= 0 ? "↑" : "↓"} {Math.abs(sparkChange).toFixed(1)}% / 30D
                  </span>
                )}
              </div>
            )}
          </div>
          {/* Moments */}
          <div style={{ ...cardStyle, textAlign: "center" }}>
            <div style={labelStyle}>MOMENTS</div>
            <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 24, color: "var(--rpc-text-primary)", lineHeight: 1, margin: "8px 0 4px" }}>
              {totalMoments > 0 ? totalMoments.toLocaleString() : "—"}
            </div>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em" }}>
              {wallets.length} WALLET{wallets.length !== 1 ? "S" : ""}
            </div>
          </div>
          {/* Badges */}
          <div style={{ ...cardStyle, textAlign: "center" }}>
            <div style={labelStyle}>BADGES</div>
            <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 24, color: "var(--rpc-text-primary)", lineHeight: 1, margin: "8px 0 4px" }}>
              {totalBadges > 0 ? totalBadges : "—"}
            </div>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em" }}>BADGE MOMENTS</div>
          </div>
        </div>

        {/* ── Portfolio Sparkline ── */}
        {username && (
          <div style={{ marginBottom: 16 }}>
            <PortfolioSparkline ownerKey={username} currentFmv={totalFmv} />
          </div>
        )}

        {/* ── Cost Basis + Tier Breakdown ── */}
        {username && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <CostBasisCard ownerKey={username} />
            <TierBreakdownCard ownerKey={username} />
          </div>
        )}

        {/* ── Collection Breakdown ── */}
        {username && (
          <div style={{ marginBottom: 14 }}>
            <CollectionBreakdownCard ownerKey={username} />
          </div>
        )}

        {/* ── Top Movers ── */}
        {username && (
          <div style={{ marginBottom: 18 }}>
            <TopMoversCard ownerKey={username} />
          </div>
        )}

        {/* ── Trophy Case ── */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, justifyContent: "center" }}>
            <span style={labelStyle}>🏆 TROPHY CASE</span>
          </div>
          {loading ? (
            <div style={{ padding: "48px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              {[100, 80, 60].map(function(w, i) {
                return <div key={i} className="rpc-skeleton" style={{ width: w + "%", maxWidth: 300, height: 14 }} />;
              })}
              <p className="rpc-label" style={{ marginTop: 8 }}>LOADING TROPHY CASE&hellip;</p>
            </div>
          ) : (
            <PublicTrophyCase trophies={trophies} />
          )}
        </section>

        {/* ── Saved Wallets ── */}
        {wallets.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <div style={{ ...labelStyle, marginBottom: 12 }}>SAVED WALLETS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {wallets.map(function(w, i) {
                const label = w.display_name || w.username || (w.wallet_addr ? w.wallet_addr.slice(0, 12) + "…" : "Wallet " + (i + 1));
                return (
                  <div key={i} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 16, padding: "12px 16px" }}>
                    <div style={{ width: 4, height: 28, borderRadius: 2, background: w.accent_color || "#E03A2F", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "var(--rpc-text-primary)", letterSpacing: "0.04em" }}>{label}</div>
                      {w.cached_top_tier && (
                        <span style={{ fontSize: 8, fontFamily: monoFont, color: tierColor(w.cached_top_tier), letterSpacing: "0.1em" }}>{w.cached_top_tier.toUpperCase()}</span>
                      )}
                    </div>
                    {w.cached_fmv != null && (
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)" }}>{fmtDollars(w.cached_fmv)}</div>
                        <div style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)" }}>{w.cached_moment_count ?? 0} MOMENTS</div>
                      </div>
                    )}
                    <Link
                      href={"/nba-top-shot/collection?q=" + encodeURIComponent(w.username ?? w.wallet_addr)}
                      className="rpc-chip"
                      style={{ textDecoration: "none", flexShrink: 0 }}
                    >
                      LOAD →
                    </Link>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Live Sniper Deals ── */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={labelStyle}>⚡ LIVE SNIPER DEALS</span>
            <Link href="/nba-top-shot/sniper" style={{ marginLeft: "auto", fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", textDecoration: "none", letterSpacing: "0.1em" }}>VIEW ALL →</Link>
          </div>
          {sniperLoading ? (
            <div style={{ padding: "24px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              {[100, 80, 60].map(function(w, i) {
                return <div key={i} className="rpc-skeleton" style={{ width: w + "%", maxWidth: 400, height: 12 }} />;
              })}
            </div>
          ) : sniperDeals.length === 0 ? (
            <div style={{ ...cardStyle, textAlign: "center", padding: "24px", color: "var(--rpc-text-ghost)", fontFamily: monoFont, fontSize: 11 }}>No live deals available right now.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sniperDeals.map(function(deal, i) {
                return (
                  <a key={i} href={deal.buyUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                    <div style={{ ...cardStyle, display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, padding: "10px 14px", alignItems: "center" }}>
                      <div>
                        <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "var(--rpc-text-primary)", letterSpacing: "0.02em" }}>{deal.playerName}</div>
                        <span style={{ fontSize: 9, fontFamily: monoFont, color: tierColor(deal.tier) }}>{deal.tier}</span>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-primary)" }}>{fmtDollars(deal.askPrice)}</div>
                        <div style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)" }}>FMV {fmtDollars(deal.adjustedFmv)}</div>
                      </div>
                      <div style={{ fontFamily: monoFont, fontSize: 12, fontWeight: 700, color: "var(--rpc-danger)" }}>-{deal.discount.toFixed(0)}%</div>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Quick Links ── */}
        <section style={{ marginBottom: 32 }}>
          <div style={Object.assign({}, labelStyle, { marginBottom: 12 })}>TOOLS</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
            {[
              { label: "Collection", icon: "◈", href: "/nba-top-shot/collection", color: "#E03A2F" },
              { label: "Pack EV", icon: "▣", href: "/nba-top-shot/packs", color: "#F59E0B" },
              { label: "Sniper", icon: "⚡", href: "/nba-top-shot/sniper", color: "#34D399" },
              { label: "Badges", icon: "⭐", href: "/nba-top-shot/badges", color: "#818CF8" },
              { label: "Sets", icon: "◉", href: "/nba-top-shot/sets", color: "#F472B6" },
            ].map(function(link) {
              return (
                <Link key={link.label} href={link.href} style={{ textDecoration: "none" }}>
                  <div className="rpc-card" style={{ padding: "14px 16px", cursor: "pointer", position: "relative", overflow: "hidden", textAlign: "left" }}>
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: link.color, opacity: 0.5 }} />
                    <div style={{ fontSize: 18, marginBottom: 7, color: link.color }}>{link.icon}</div>
                    <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 12, color: "var(--rpc-text-primary)", letterSpacing: "0.05em", textTransform: "uppercase" }}>{link.label}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        {/* ── CTA Footer ── */}
        <div style={{ textAlign: "center", paddingTop: 32, borderTop: "1px solid var(--rpc-border)" }}>
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.15em", marginBottom: 12 }}>POWERED BY RIP PACKS CITY</div>
          <Link href="/profile" className="rpc-btn-primary" style={{ textDecoration: "none", display: "inline-block", fontSize: 13, padding: "10px 24px" }}>
            BUILD YOUR OWN PROFILE →
          </Link>
        </div>
      </main>
    </div>
  );
}
