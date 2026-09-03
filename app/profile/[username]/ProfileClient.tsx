"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import RpcLogo from "@/components/RpcLogo";
import CostBasisCard from "@/components/profile/CostBasisCard";
import TopMoversCard from "@/components/profile/TopMoversCard";
import CollectionBreakdownCard from "@/components/profile/CollectionBreakdownCard";
import PublicAchievements from "@/components/profile/PublicAchievements";
import ShareProfileButtons from "@/components/profile/ShareProfileButtons";
import FollowButton from "@/components/profile/FollowButton";
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab";
import { LEAGUES, type UserFavoriteTeam } from "@/lib/teams";
import { borderCosmetic, bannerCosmetic } from "@/lib/cosmetics";
import { resolveAvatarUrl } from "@/lib/profile/default-avatar";
import { avatarDisplayUrl } from "@/lib/media/avatar-proxy";
import { getCollectionByUuid } from "@/lib/collections";

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
  collection_id: string | null;
  cached_fmv: number | null;
  cached_fmv_stale?: number | null;
  cached_stale_count?: number | null;
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

// ── Constants ─────────────────────────────────────────────────────
const monoFont = "var(--font-mono)";
const condensedFont = "var(--font-display)";
const MAX_SLOTS = 6;

// ── Helpers ───────────────────────────────────────────────────────
function fmtDollars(n: number): string {
  // Threshold on magnitude and re-attach the sign so a negative renders
  // "-$1.5K" rather than "$-1500.00" (matches components/profile/_shared.ts).
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(2);
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
  const { data, width = 200, height = 40, color = "#E03A2F" } = props; // brand-exception: passed to SVG <polyline stroke> attr, which can't resolve a CSS var
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
  const accent = props.accent ?? "#E03A2F"; // brand-exception: parsed by hexToRgba — must be a literal hex, not a CSS var
  const accentBg = hexToRgba(accent, 0.15);
  const initials = username ? username.slice(0, 2).toUpperCase() : "?";

  // Equipped border cosmetic overrides the accent ring with a colored ring +
  // outer glow. Falls back to the subtle accent border when none is equipped.
  const border = borderCosmetic(bio?.equipped_border);
  const ringColor = border?.ring ?? hexToRgba(accent, 0.4);
  const ringWidth = border ? 3 : 2;
  const boxShadow = border?.glow ? "0 0 16px " + border.glow : undefined;

  // A collector who has not set an avatar gets the RPC logo (resolveAvatarUrl),
  // so this always renders an <img> and there is no "no avatar" JSX branch any
  // more. The monogram survives ONLY as the onError fallback below — which is
  // now the sole path to it, and it still matters: a collector who saved a
  // broken URL, or whose host is down, must not get an empty circle.
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", border: ringWidth + "px solid " + ringColor, boxShadow, flexShrink: 0 }}>
      <img
        // ⚠ avatarDisplayUrl, not the raw value: proxy.ts's enumerated
        // img-src CSP does not list the NFT image hosts, so a third-party
        // avatar is refused by the BROWSER before a byte moves and falls
        // through to the monogram below. Same-origin bytes satisfy 'self'.
        // Pass-through for hosts already in the CSP, so nothing that works
        // today gains a hop or a dependency.
        src={avatarDisplayUrl(resolveAvatarUrl(bio?.avatar_url))}
        alt={username}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
        onError={function(e) {
          // Capture the parent BEFORE mutating innerHTML: setting
          // parent.innerHTML detaches this <img>, so e.currentTarget.parentElement
          // becomes null and reading .style off it throws (NEXTJS-2D).
          const el = e.currentTarget;
          const parent = el.parentElement;
          el.style.display = "none";
          if (parent) {
            Object.assign(parent.style, {
              background: accentBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: condensedFont,
              fontWeight: "800",
              fontSize: (size * 0.35) + "px",
              color: accent,
            });
            parent.innerHTML = initials;
          }
        }}
      />
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────
// Rendered by the server page.tsx, which fetches /api/public/profile server-
// side and seeds initialBio + initialWallets so the Portfolio FMV hero + moment
// count appear in the SSR HTML (and link/social previews) instead of "—" / "0"
// until the client fetch lands. The client still re-fetches on mount (slabs,
// history, teams, plus a harmless re-confirm of bio/wallets).
export default function ProfileClient(props: {
  initialBio?: ProfileBio | null;
  initialWallets?: SavedWalletPublic[];
  /** DISTINCT wallet addresses — see the WALLETS tile for why not wallets.length. */
  initialWalletCount?: number | null;
  /** The SSR read FAILED, so `initialWallets` is [] out of an outage rather than
   *  out of an empty collection. Without this the two are indistinguishable. */
  initialFailed?: boolean;
}) {
  const params = useParams();
  const username = params?.username as string;

  // State (FMV hero + moment count seeded from the server fetch so they SSR).
  const [slabs, setSlabs] = useState<(TrophySlabData | null)[]>([null, null, null, null, null, null]);
  const [slabsLoading, setSlabsLoading] = useState(true);
  // Distinguishes "this collector has pinned nothing" from "we could not read
  // their case" — the two used to render identically.
  const [slabsError, setSlabsError] = useState(false);
  const [bio, setBio] = useState<ProfileBio | null>(props.initialBio ?? null);
  const [favoriteTeams, setFavoriteTeams] = useState<UserFavoriteTeam[]>([]);
  const [wallets, setWallets] = useState<SavedWalletPublic[]>(props.initialWallets ?? []);
  // ⚠ A FAILED READ IS NOT AN EMPTY PORTFOLIO — the same distinction `slabsError`
  // makes for the trophy case, which sat 20 lines below this one while the wallet
  // read went without it. Seeded from the SERVER's read so the SSR paint is honest
  // too, then re-decided by the client fetch below (cleared on success, set on
  // failure), because the client can succeed where the server timed out.
  const [profileError, setProfileError] = useState(!!props.initialFailed);
  // Server-computed, because `wallets` has had its addresses stripped and so
  // cannot be deduped here. null = the payload did not carry it, which the
  // tile renders by OMITTING the line rather than falling back to
  // wallets.length — that fallback is the bug this replaced.
  const [walletCount, setWalletCount] = useState<number | null>(
    typeof props.initialWalletCount === "number" ? props.initialWalletCount : null
  );
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  // Current viewer's handle + auth id (null = anon). Drives the own-profile
  // share block; the id seeds the referral &ref= on the share link.
  // /api/profile/me returns { user: null } for anon — never 401s.
  const [myUsername, setMyUsername] = useState<string | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);

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

    // ⚠ THROW on a non-ok response rather than resolving null. The old form
    // (`r.ok ? r.json() : null` then `if (!data) return`) swallowed the status,
    // so a 503 left the seeded state in place and rendered as the collector's
    // real portfolio. Both branches now land on setProfileError, exactly as the
    // trophy-slabs read below does.
    const publicP = fetch("/api/public/profile/" + enc)
      .then(function(r) {
        if (!r.ok) throw new Error("public profile " + r.status);
        return r.json();
      })
      .then(function(data) {
        if (!data) throw new Error("public profile: empty body");
        if (data.bio) setBio(data.bio);
        if (Array.isArray(data.wallets)) setWallets(data.wallets);
        if (typeof data.wallet_count === "number") setWalletCount(data.wallet_count);
        // The client succeeded where the server may not have, so a stale
        // server-seeded failure must not outlive it.
        setProfileError(false);
      })
      .catch(function() { setProfileError(true); });

    // Trophy slabs come from the new enriched RPC, not the legacy
    // public-profile aggregation. The RPC returns play_description,
    // collection_display_name, acquired_price, etc. that the slab needs.
    //
    // ⚠ A FAILED READ IS NOT AN EMPTY TROPHY CASE. Both the non-ok branch and
    // the .catch used to leave `slabs` all-null, which renders "No trophies
    // pinned yet." — so a blip told visitors that a collector with a full case
    // had pinned nothing, on the page that collector shares. `slabsError`
    // carries the distinction through to the render.
    setSlabsError(false);
    const slabsP = fetch("/api/profile/trophy-slabs?username=" + enc)
      .then(function(r) {
        if (!r.ok) throw new Error("trophy-slabs " + r.status);
        return r.json();
      })
      .then(function(data) {
        const slots: (TrophySlabData | null)[] = [null, null, null, null, null, null];
        const list: TrophySlabData[] = Array.isArray(data?.slabs) ? data.slabs : [];
        list.forEach(function(s) {
          if (s.slot >= 1 && s.slot <= MAX_SLOTS) slots[s.slot - 1] = s;
        });
        setSlabs(slots);
      })
      .catch(function() { setSlabsError(true); })
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

  // Who's viewing — to show the share block only on the viewer's own profile.
  useEffect(function() {
    fetch("/api/profile/me")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        setMyUsername(data?.user?.username ?? null);
        setMyUserId(data?.user?.id ?? null);
      })
      .catch(function() {});
  }, []);

  // Derived stats
  const accentColor = bio?.accent_color ?? "#E03A2F"; // brand-exception: parsed by hexToRgba — must be a literal hex, not a CSS var
  const accentBg = hexToRgba(accentColor, 0.15);
  const accentBorder = hexToRgba(accentColor, 0.4);
  const filledCount = slabs.filter(Boolean).length;
  // The Top Shot username behind the collector's saved wallet(s), if the
  // payload knows one — the only key the collection page's `?q=` accepts that
  // this public payload carries.
  const analyzeKey = wallets.find(function(w) { return !!w.username; })?.username ?? null;
  const publicSlabs = slabs.filter(Boolean) as TrophySlabData[];
  // ⚠ SAME DEFINITION AS THE DASHBOARD. `cached_fmv` is the TOTAL including
  // stale-priced Moments; the dashboard's headline excludes them and shows the
  // stale portion as a caption (lib/dashboard/aggregate.ts). Until 2026-09-02
  // this page summed the total, so the number a collector posted was ~80%
  // above the one they had just read on their dashboard (QA finding #6).
  const totalFmvAll = wallets.reduce(function(sum, w) { return sum + (w.cached_fmv ?? 0); }, 0);
  const staleFmv = wallets.reduce(function(sum, w) { return sum + (w.cached_fmv_stale ?? 0); }, 0);
  const staleCount = wallets.reduce(function(sum, w) { return sum + (w.cached_stale_count ?? 0); }, 0);
  const totalFmv = totalFmvAll - staleFmv;
  const totalMoments = wallets.reduce(function(sum, w) { return sum + (w.cached_moment_count ?? 0); }, 0);
  const rpcScore = wallets.length > 0 ? wallets[0]?.cached_rpc_score ?? null : null;
  const isOwnProfile =
    !!myUsername && !!username && myUsername.toLowerCase() === username.toLowerCase();

  // Saved wallets, organized by collection (then FMV desc within). The
  // collection label resolves from the collection_id UUID via the registry;
  // null / unknown collapses to "Multi".
  function walletCollectionLabel(w: SavedWalletPublic): string {
    if (!w.collection_id) return "Multi";
    return getCollectionByUuid(w.collection_id)?.label ?? "Multi";
  }
  // What kind of collector this actually is, from the collections they hold
  // moments in. Wallets with a zero/absent moment count are excluded — a
  // saved_wallets row exists for all five published collections after a single
  // association, so counting rows rather than HOLDINGS would label every
  // collector "MULTI-COLLECTION" regardless of what they own.
  const collectorLabel = (function() {
    const held = new Set<string>();
    for (const w of wallets) {
      if ((w.cached_moment_count ?? 0) <= 0) continue;
      const label = w.collection_id ? getCollectionByUuid(w.collection_id)?.label : null;
      if (label) held.add(label);
    }
    if (held.size === 1) return Array.from(held)[0].toUpperCase() + " COLLECTOR";
    if (held.size > 1) return "MULTI-COLLECTION COLLECTOR";
    // No holdings we can see — either the wallet list hasn't loaded or nothing
    // is indexed yet. "COLLECTOR" claims nothing either way.
    return "COLLECTOR";
  })();

  const sortedWallets = wallets.slice().sort(function(a, b) {
    const la = walletCollectionLabel(a);
    const lb = walletCollectionLabel(b);
    if (la !== lb) return la.localeCompare(lb);
    return (b.cached_fmv ?? 0) - (a.cached_fmv ?? 0);
  });

  // Sparkline data
  const sparkData = snapshots.map(function(s) { return s.total_fmv; });
  // ⚠ A percentage change from a ZERO baseline is UNDEFINED, not enormous. The
  // previous `|| 1` divide-by-zero guard silently substituted a $1 baseline, so
  // a collector whose first snapshot was $0 — a new wallet, or one snapshotted
  // before the FMV populate ran — had a rise to $500 rendered as
  // "↑ 50000.0% / 30D" on their PUBLIC profile. Omit the percentage instead;
  // the sparkline itself still shows the real shape.
  const sparkBase = sparkData.length >= 2 ? sparkData[0] : null;
  const sparkChange =
    sparkBase != null && Number.isFinite(sparkBase) && sparkBase > 0
      ? ((sparkData[sparkData.length - 1] - sparkBase) / sparkBase) * 100
      : null;
  // Direction is knowable even when the percentage is not, so the sparkline
  // colour must not fall back to "down" just because the baseline was zero.
  const sparkUp =
    sparkChange != null
      ? sparkChange >= 0
      : sparkData.length >= 2 && sparkData[sparkData.length - 1] >= sparkData[0];

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "#fff" }}>
      {/* Brand fonts are loaded once app-wide from the root layout <head>
          (app/layout.tsx), so no per-page font <link>/@import is needed here. */}
      <style>{`
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
          {/* ⚠ `?q=` is a TOP SHOT username / address search, and the RPC handle
              is a different namespace (profile_bio.username). Until 2026-09-03
              this linked `?q=<handle>`, which resolved only when the two
              happened to coincide — for `qa0903b` it searched Top Shot for a
              collector who does not exist. Use a saved wallet's Top Shot
              username (the address is deliberately stripped from the public
              payload); with none known there is nothing honest to link. */}
          {analyzeKey && (
            <Link href={"/nba-top-shot/collection?q=" + encodeURIComponent(analyzeKey)} className="rpc-btn-ghost" style={{ textDecoration: "none", fontSize: 10, color: accentColor, borderColor: accentBorder }}>
              {"ANALYZE " + username.toUpperCase() + "'S WALLET →"}
            </Link>
          )}
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
            {/* ⚠ This said "NBA TOP SHOT COLLECTOR" for everyone, on a
                five-collection platform — so an All Day or Pinnacle collector's
                own public page misdescribed them. The label is now derived from
                what they actually hold: one collection names it, several say
                "MULTI-COLLECTION", and an unread wallet list says neither.

                The count is withheld while the case is loading or unreadable —
                "0 / 6 TROPHY MOMENTS" is a measurement, and printing it from a
                read we never completed states something we do not know. */}
            {collectorLabel +
              (slabsLoading || slabsError
                ? ""
                : " · " + filledCount + " / " + MAX_SLOTS + " TROPHY MOMENTS")}
          </div>
          {/* Follow — renders null on your own profile (server-decided). */}
          {username && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
              <FollowButton username={username} accentColor={accentColor} />
            </div>
          )}
          {(bio?.twitter || bio?.discord) && (
            <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 10 }}>
              {bio?.twitter && (() => {
                // The stored handle may already carry a leading "@" — strip it
                // so we render a single @ (was "@@jamesdillonbond") and keep the
                // profile URL clean.
                const handle = bio.twitter.replace(/^@+/, "");
                return (
                  <a href={"https://twitter.com/" + handle} target="_blank" rel="noreferrer" style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", textDecoration: "none", letterSpacing: "0.1em" }}>
                    @{handle}
                  </a>
                );
              })()}
              {bio?.discord && (
                <span style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", letterSpacing: "0.1em" }}>
                  {bio.discord}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── Share your collection (own profile only) ── */}
        {isOwnProfile && (
          <section
            style={{
              ...cardStyle,
              marginBottom: 24,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              textAlign: "center",
            }}
          >
            <div style={labelStyle}>SHARE YOUR COLLECTION</div>
            {/* ⚠ NO POINTS/REWARDS COPY HERE. This used to promise "+50 Status
                once a day for sharing" and "more Status when a friend joins
                through your link" — a reward the program is not built enough to
                pay out. Sharing itself is real and stays; the promise does not.
                Do not reinstate any Status/credits language on a public surface
                until the rewards program actually ships. */}
            <div style={{ fontSize: 12, fontFamily: monoFont, color: "var(--rpc-text-secondary)", letterSpacing: "0.04em", maxWidth: 440 }}>
              {/* Copy follows the case: with nothing pinned, "post your trophy
                  case" invites sharing an empty one (re-QA 2026-09-03). The
                  portfolio is still worth posting — say that instead, and
                  point at the dashboard to pin. */}
              {filledCount > 0
                ? "Post your trophy case on X or Discord."
                : "Post your portfolio on X or Discord — or pin a trophy first from your dashboard."}
            </div>
            <ShareProfileButtons username={username} fmv={totalFmv} moments={totalMoments} trophyCount={filledCount} referrerId={myUserId} />
          </section>
        )}

        {/* ── Achievements: REMOVED 2026-08-16 ──
            Badges are part of the same unshipped rewards program as the Status
            copy above, so they were making a promise the product cannot keep.
            The component and its API are intact; re-mount
            <PublicAchievements ownerKey={username} /> here when rewards ship. */}

        {/* ── Stat Tiles ── */}
        <div style={{ display: "grid", gridTemplateColumns: rpcScore != null ? "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 12, marginBottom: 24 }}>
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
            {staleFmv > 0 && (
              <div style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.08em", marginBottom: 4 }}>
                + {fmtDollars(staleFmv)} across {staleCount.toLocaleString()} stale-priced
              </div>
            )}
            {sparkData.length >= 2 && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, marginTop: 4 }}>
                <Sparkline data={sparkData} width={120} height={24} color={sparkUp ? "#34D399" : "#F87171"} />
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
            {/* ⚠ `walletCount` is DISTINCT ADDRESSES from the server, NOT
                `wallets.length`. saved_wallets is keyed per (wallet_addr,
                collection_id), so one pinned address becomes one row per
                collection it holds moments in — a single Dapper wallet read
                "4 WALLETS". The addresses are stripped from this payload for
                privacy, so the count cannot be derived here; when the server
                did not send one we omit the line rather than print a number we
                cannot stand behind. (The FMV and moment totals above are sums
                across those same rows, so they were correct all along.) */}
            {walletCount != null && (
              <div style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em" }}>
                {walletCount} WALLET{walletCount !== 1 ? "S" : ""}
              </div>
            )}
          </div>
        </div>

        {/* ⚠ Says WHY the tiles above are blank. Without this the em-dashes read
            as "this collector holds nothing" — and the saved-wallet list below
            simply does not render when the array is empty, so on their OWN
            profile a collector sees a portfolio they built reduced to nothing
            with no indication anything failed, and re-adds wallets that are
            already there. The wording states which of the two it is; "—" alone
            cannot. Same rule as the trophy case's "couldn't load" branch. */}
        {profileError && (
          <div
            className="rpc-mono"
            style={{ marginBottom: 24, fontSize: 11, fontFamily: monoFont, color: "var(--rpc-text-muted)", letterSpacing: "0.06em", lineHeight: 1.5 }}
          >
            We couldn&rsquo;t load this portfolio, so the figures above are MISSING, not zero — and any
            saved wallets are hidden rather than absent. Refresh to try again.
          </div>
        )}

        {/* ── Trophy Case (all 6, front and center under the KPI row) ── */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, justifyContent: "center" }}>
            <span style={labelStyle}>🏆 TROPHY CASE</span>
            {username && !slabsLoading && slabs.some(Boolean) && (
              <>
              <Link
                href={"/profile/" + encodeURIComponent(username) + "/trophy-case"}
                title="Open the shareable trophy-case page"
                style={{
                  fontSize: 9,
                  fontFamily: monoFont,
                  letterSpacing: "0.1em",
                  color: accentColor,
                  border: "1px solid " + accentColor,
                  borderRadius: 4,
                  padding: "3px 8px",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                SHARE CASE →
              </Link>
              {/* The PDF is a download, not a link preview — pasting one into X
                  or Discord produces a file, not a picture. Kept beside the
                  share page rather than replaced by it: they are different
                  artifacts for different purposes. */}
              <a
                href={"/api/profile/trophy-case/pdf?username=" + encodeURIComponent(username)}
                title="Download this trophy case as a PDF"
                style={{
                  fontSize: 9,
                  fontFamily: monoFont,
                  letterSpacing: "0.1em",
                  color: accentColor,
                  border: "1px solid " + accentColor,
                  borderRadius: 4,
                  padding: "3px 8px",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                EXPORT PDF ↓
              </a>
              </>
            )}
          </div>
          {slabsLoading ? (
            <div className="rpc-trophy-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
              {[0, 1, 2].map(function(i) {
                return <TrophySlab key={"slab-skel-" + i} slab={null} slot={i + 1} mode="public" loading />;
              })}
            </div>
          ) : slabsError ? (
            // Says what is true — that WE could not read it — rather than
            // making a claim about this collector's case out of our own outage.
            <div style={{ textAlign: "center", fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)", letterSpacing: "0.08em", padding: "24px 0" }}>
              Couldn&rsquo;t load this trophy case. Refresh to try again.
            </div>
          ) : publicSlabs.length === 0 ? (
            <div style={{ textAlign: "center", fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)", letterSpacing: "0.08em", padding: "24px 0" }}>
              No trophies pinned yet.
            </div>
          ) : (
            <div className="rpc-trophy-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
              {publicSlabs.map(function(s) {
                return (
                  <TrophySlab
                    key={"slab-" + s.slot}
                    slab={s}
                    slot={s.slot}
                    mode="public"
                  />
                );
              })}
            </div>
          )}
          <style>{`
            @media (max-width: 768px) {
              .rpc-trophy-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
            }
          `}</style>
        </section>

        {/* ── Cost Basis · P/L: REMOVED FROM THIS PAGE 2026-08-16 ──
            Spend and profit/loss do not belong on the shareable profile at all,
            even own-view. This page is the one a collector posts publicly, and
            a card that renders for the owner is one screenshot away from being
            public — the gating was never the risk, the SURFACE was. Portfolio
            FMV stays: a total holdings value is what the page is for; what it
            COST you is not.
            Cost basis is unaffected elsewhere — it still lives per-wallet on
            /[collection]/analytics (components/analytics/CostBasisCard), which
            is where a collector looks at their own numbers. */}

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

        {/* ── Saved Wallets (organized by collection) ── */}
        {sortedWallets.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <div style={{ ...labelStyle, marginBottom: 12 }}>SAVED WALLETS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sortedWallets.map(function(w, i) {
                // One address is one row PER COLLECTION, so an index-based
                // "Wallet N" labelled a single wallet "Wallet 1 … Wallet 5"
                // under a header that correctly said "1 WALLET". The
                // collection is the thing that differs row to row.
                const collectionLabel = walletCollectionLabel(w);
                const label = w.display_name || w.username || collectionLabel;
                const subLabel = label === collectionLabel ? "Saved wallet" : collectionLabel;
                // Per-row value uses the same stale split as the headline.
                const rowFmv = w.cached_fmv != null ? w.cached_fmv - (w.cached_fmv_stale ?? 0) : null;
                return (
                  <div key={i} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 16, padding: "12px 16px" }}>
                    <div style={{ width: 4, height: 28, borderRadius: 2, background: w.accent_color || "var(--rpc-red)", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "var(--rpc-text-primary)", letterSpacing: "0.04em" }}>{label}</div>
                      <span style={{ fontSize: 8, fontFamily: monoFont, color: "var(--rpc-text-secondary)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{subLabel}</span>
                    </div>
                    {rowFmv != null && (
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)" }}>{fmtDollars(rowFmv)}</div>
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

        {/* ── Quick Links ── */}
        <section style={{ marginBottom: 32 }}>
          <div style={Object.assign({}, labelStyle, { marginBottom: 12 })}>TOOLS</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
            {[
              { label: "Collection", icon: "◈", href: "/nba-top-shot/collection", color: "var(--rpc-red)" },
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
