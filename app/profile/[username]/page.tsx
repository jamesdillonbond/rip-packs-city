"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import RpcLogo from "@/components/RpcLogo";
import CostBasisCard from "@/components/profile/CostBasisCard";
import TierBreakdownCard from "@/components/profile/TierBreakdownCard";
import TopMoversCard from "@/components/profile/TopMoversCard";
import CollectionBreakdownCard from "@/components/profile/CollectionBreakdownCard";
import PortfolioSparkline from "@/components/profile/PortfolioSparkline";
import PublicAchievements from "@/components/profile/PublicAchievements";
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab";
import { LEAGUES, type UserFavoriteTeam } from "@/lib/teams";
import { borderCosmetic, bannerCosmetic } from "@/lib/cosmetics";

// ── Types ─────────────────────────────────────────────────────────
interface ProfileBio {
  display_name: string | null;
  tagline: string | null;
  favorite_team: string | null;
  twitter: string | null;
  discord: string | null;
  avatar_url: string | null;
  accent_color?: string | null;
  equipped_border?: string | null;
  equipped_banner?: string | null;
}

interface SavedWalletPublic {
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
const monoFont = "var(--font-mono)";
const condensedFont = "var(--font-display)";
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

function scoreColor(score: number): string {
  if (score >= 800) return "var(--rpc-success)";
  if (score >= 500) return "var(--rpc-warning)";
  return "var(--rpc-danger)";
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

// ── Avatar ────────────────────────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || "").replace("#", "");
  if (clean.length !== 6) return "rgba(224,58,47," + alpha + ")";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

function Avatar(props: { username: string; bio: ProfileBio | null; size?: number; accent?: string }) {
  const { username, bio, size = 64 } = props;
  const accent = props.accent ?? "#E03A2F";
  const accentBg = hexToRgba(accent, 0.15);
  const initials = username ? username.slice(0, 2).toUpperCase() : "?";

  // Equipped border cosmetic overrides the accent ring with a colored ring +
  // outer glow. Falls back to the subtle accent border when none is equipped.
  const border = borderCosmetic(bio?.equipped_border);
  const ringColor = border?.ring ?? hexToRgba(accent, 0.4);
  const ringWidth = border ? 3 : 2;
  const boxShadow = border?.glow ? "0 0 16px " + border.glow : undefined;

  if (bio?.avatar_url) {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", border: ringWidth + "px solid " + ringColor, boxShadow, flexShrink: 0 }}>
        <img
          src={bio.avatar_url}
          alt={username}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={function(e) {
            e.currentTarget.style.display = "none";
            if (e.currentTarget.parentElement) {
              e.currentTarget.parentElement.innerHTML = initials;
              Object.assign(e.currentTarget.parentElement.style, {
                background: accentBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: condensedFont,
                fontWeight: "800",
                fontSize: (size * 0.35) + "px",
                color: accent,
              });
            }
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: accentBg, border: ringWidth + "px solid " + ringColor, boxShadow, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, fontWeight: 800, color: accent, fontFamily: condensedFont, flexShrink: 0 }}>
      {initials}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────
export default function PublicProfilePage() {
  const params = useParams();
  const username = params?.username as string;

  // State
  const [slabs, setSlabs] = useState<(TrophySlabData | null)[]>([null, null, null, null, null, null]);
  const [slabsLoading, setSlabsLoading] = useState(true);
  const [showAllSlabs, setShowAllSlabs] = useState(false);
  const [bio, setBio] = useState<ProfileBio | null>(null);
  const [favoriteTeams, setFavoriteTeams] = useState<UserFavoriteTeam[]>([]);
  const [wallets, setWallets] = useState<SavedWalletPublic[]>([]);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [sniperDeals, setSniperDeals] = useState<SniperDealPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [sniperLoading, setSniperLoading] = useState(true);

  // Fetch all data on mount.
  //
  // /api/profile/{trophy,bio,saved-wallets} are all auth-gated (requireUser)
  // and silently 401 for public profile views, leaving trophies / bio /
  // wallets empty. The /api/public/profile/[username] aggregated endpoint
  // returns the same fields with privacy-stripped wallet summaries and is
  // intentionally unauthenticated. Phase 7.5 consolidated those three reads
  // into the public endpoint; portfolio-history stays as a separate call
  // because the public endpoint doesn't include sparkline snapshots.
  useEffect(function() {
    if (!username) return;
    setLoading(true);
    setSlabsLoading(true);

    const enc = encodeURIComponent(username);

    const publicP = fetch("/api/public/profile/" + enc)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        if (data.bio) setBio(data.bio);
        if (Array.isArray(data.wallets)) setWallets(data.wallets);
      })
      .catch(function() {});

    // Trophy slabs come from the new enriched RPC, not the legacy
    // public-profile aggregation. The RPC returns play_description,
    // collection_display_name, acquired_price, etc. that the slab needs.
    const slabsP = fetch("/api/profile/trophy-slabs?username=" + enc)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        const slots: (TrophySlabData | null)[] = [null, null, null, null, null, null];
        const list: TrophySlabData[] = Array.isArray(data?.slabs) ? data.slabs : [];
        list.forEach(function(s) {
          if (s.slot >= 1 && s.slot <= MAX_SLOTS) slots[s.slot - 1] = s;
        });
        setSlabs(slots);
      })
      .catch(function() {})
      .finally(function() { setSlabsLoading(false); });

    // Fetch portfolio history for sparkline (public, ownerKey-driven endpoint).
    const historyP = fetch("/api/profile/portfolio-history?ownerKey=" + enc + "&days=30")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (data?.snapshots) setSnapshots(data.snapshots); })
      .catch(function() {});

    // Structured favorite teams (4-league dropdown picks). Public, ownerKey-
    // driven. Replaces the legacy free-text profile_bio.favorite_team for
    // header chip rendering — bio.favorite_team only shows as a (legacy)
    // fallback when this returns zero rows.
    const teamsP = fetch("/api/profile/teams?ownerKey=" + enc)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (Array.isArray(data?.teams)) setFavoriteTeams(data.teams); })
      .catch(function() {});

    Promise.all([publicP, slabsP, historyP, teamsP]).finally(function() { setLoading(false); });
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
  const accentColor = bio?.accent_color ?? "#E03A2F";
  const accentBg = hexToRgba(accentColor, 0.15);
  const accentBorder = hexToRgba(accentColor, 0.4);
  const filledCount = slabs.filter(Boolean).length;
  const hasOverflowSlabs = slabs.slice(3).some(Boolean);
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
            <RpcLogo size={32} />
          </Link>
          <div style={{ flex: 1 }} />
          <Link href={"/nba-top-shot/collection?q=" + encodeURIComponent(username)} className="rpc-btn-ghost" style={{ textDecoration: "none", fontSize: 10, color: accentColor, borderColor: accentBorder }}>
            {"ANALYZE " + username.toUpperCase() + "'S WALLET →"}
          </Link>
        </div>
      </header>

      <main style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px 60px", animation: "fadeIn 0.4s ease both" }}>

        {/* ── Profile Header + Bio ── */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          {(function() {
            const banner = bannerCosmetic(bio?.equipped_banner);
            if (!banner) return null;
            return (
              <div
                aria-hidden
                title={banner.label + " banner"}
                style={{ height: 88, borderRadius: 12, background: banner.background, marginBottom: -40, border: "1px solid rgba(255,255,255,0.08)" }}
              />
            );
          })()}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16, position: "relative" }}>
            <Avatar username={username} bio={bio} size={72} accent={accentColor} />
          </div>
          <h1 style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 32, letterSpacing: "0.06em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1, marginBottom: 6 }}>
            {bio?.display_name ?? username}
          </h1>
          {bio?.tagline && (
            <div style={{ fontSize: 11, fontFamily: monoFont, color: "var(--rpc-text-secondary)", marginBottom: 6, letterSpacing: "0.06em" }}>
              {bio.tagline}
            </div>
          )}
          {/* Favorite-team chips — primary gets a colored 1px border in
              the team's primary_color; others render subtle. Falls back to
              the legacy free-text bio.favorite_team only when the user has
              no structured picks yet. */}
          {favoriteTeams.length > 0 ? (
            <div style={{ display: "flex", justifyContent: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {favoriteTeams.map(function(t) {
                const meta = LEAGUES.find(function(l) { return l.value === t.league; });
                const emoji = meta ? meta.emoji : "";
                return (
                  <span
                    key={t.league}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "3px 8px",
                      borderRadius: 999,
                      fontFamily: monoFont,
                      fontSize: 10,
                      letterSpacing: "0.08em",
                      color: "var(--rpc-text-primary)",
                      background: "var(--rpc-surface)",
                      border: t.is_primary ? ("1px solid " + t.primary_color) : "1px solid var(--rpc-border)",
                    }}
                    title={t.team_name}
                  >
                    <span aria-hidden>{emoji}</span>
                    <span>{t.abbreviation}</span>
                  </span>
                );
              })}
            </div>
          ) : bio?.favorite_team ? (
            <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 8, alignItems: "center" }}>
              <span style={{ fontSize: 10, fontFamily: monoFont, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>
                {bio.favorite_team}
              </span>
              <span style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", padding: "1px 6px", border: "1px solid var(--rpc-border)", borderRadius: 999 }}>
                LEGACY
              </span>
            </div>
          ) : null}
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", letterSpacing: "0.15em" }}>
            {"NBA TOP SHOT COLLECTOR · " + filledCount + " / " + MAX_SLOTS + " TROPHY MOMENTS"}
          </div>
          {isTeamCaptain && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, padding: "4px 12px", background: accentBg, border: "1px solid " + accentBorder, borderRadius: "var(--radius-sm)", fontSize: 9, fontFamily: monoFont, letterSpacing: "0.1em", color: accentColor }}>
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
        {username && <PublicAchievements ownerKey={username} />}

        {/* ── Stat Tiles ── */}
        <div style={{ display: "grid", gridTemplateColumns: rpcScore != null ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
          {/* RPC Score */}
          {rpcScore != null && (
            <div style={{ ...cardStyle, textAlign: "center", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accentColor, opacity: 0.7 }} />
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
            <PortfolioSparkline ownerKey={username} currentFmv={totalFmv} lineColor={accentColor} />
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
          <div className="rpc-trophy-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
            {[0, 1, 2].map(function(i) {
              return (
                <TrophySlab
                  key={"slab-" + i}
                  slab={slabs[i]}
                  slot={i + 1}
                  mode="public"
                  loading={slabsLoading}
                />
              );
            })}
          </div>
          {hasOverflowSlabs && (
            <>
              <div style={{ textAlign: "center", marginTop: 14 }}>
                <button
                  type="button"
                  onClick={function() { setShowAllSlabs(function(v) { return !v; }); }}
                  style={{
                    background: "transparent",
                    border: "1px solid var(--rpc-border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "8px 16px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    letterSpacing: "0.15em",
                    color: "var(--rpc-text-secondary)",
                    cursor: "pointer",
                    textTransform: "uppercase",
                  }}
                >
                  {showAllSlabs ? "HIDE EXTRA TROPHIES" : "SHOW ALL TROPHIES"}
                </button>
              </div>
              {showAllSlabs && (
                <div className="rpc-trophy-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16, marginTop: 16 }}>
                  {[3, 4, 5].map(function(i) {
                    return (
                      <TrophySlab
                        key={"slab-" + i}
                        slab={slabs[i]}
                        slot={i + 1}
                        mode="public"
                        loading={slabsLoading}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
          <style>{`
            @media (max-width: 768px) {
              .rpc-trophy-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
            }
          `}</style>
        </section>

        {/* ── Saved Wallets ── */}
        {wallets.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <div style={{ ...labelStyle, marginBottom: 12 }}>SAVED WALLETS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {wallets.map(function(w, i) {
                const label = w.display_name || w.username || ("Wallet " + (i + 1));
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
                    {w.username && (
                      <Link
                        href={"/nba-top-shot/collection?q=" + encodeURIComponent(w.username)}
                        className="rpc-chip"
                        style={{ textDecoration: "none", flexShrink: 0 }}
                      >
                        LOAD →
                      </Link>
                    )}
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
            {[
              { label: "Collection", icon: "◈", href: "/nba-top-shot/collection", color: "#E03A2F" },
              { label: "Pack EV", icon: "▣", href: "/nba-top-shot/packs", color: "#F59E0B" },
              { label: "Sniper", icon: "⚡", href: "/nba-top-shot/sniper", color: "#34D399" },
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
          <Link href="/dashboard" className="rpc-btn-primary" style={{ textDecoration: "none", display: "inline-block", fontSize: 13, padding: "10px 24px", background: accentColor, borderColor: accentColor }}>
            BUILD YOUR OWN PROFILE →
          </Link>
        </div>
      </main>
    </div>
  );
}
