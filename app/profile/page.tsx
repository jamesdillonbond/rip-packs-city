"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import RpcLogo from "@/components/RpcLogo";
import SignOutButton from "@/components/auth/SignOutButton";
import { ConnectButton } from "@/components/auth/ConnectButton";
import { publishedCollections, getCollection } from "@/lib/collections";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const ACCENT_RED = "#E03A2F";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Bio {
  username: string | null;
  display_name: string | null;
  tagline: string | null;
  favorite_team: string | null;
  twitter: string | null;
  discord: string | null;
  avatar_url: string | null;
  accent_color?: string | null;
}

interface SavedWallet {
  wallet_addr: string;
  collection_id: string;
  username: string | null;
  display_name: string | null;
  nickname: string | null;
  cached_fmv: number | null;
  cached_moment_count: number | null;
  cached_top_tier: string | null;
  accent_color: string | null;
  pinned_at: string;
}

interface Trophy {
  slot: number;
  moment_id: string;
  collection_id: string;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  fmv: number | null;
  badges: string[] | null;
}

interface HeroMoment {
  moment_id: string;
  collection_id: string;
  owner_address: string;
  serial_number: number | null;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  circulation_count: number | null;
  thumbnail_url: string | null;
  fmv_usd: number;
}

interface Favorite {
  collection_id: string;
  favorited: boolean;
  created_at: string;
}

interface Activity {
  followee_username: string | null;
  followee_display_name: string | null;
  role: "seller" | "buyer";
  wallet_addr: string;
  collection_id: string;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  thumbnail_url: string | null;
  serial_number: number | null;
  price_usd: number | null;
  sold_at: string;
}

interface RecentSearch {
  id: number;
  query: string;
  query_type: string;
  collection_id: string | null;
  searched_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (!n) return "$0";
  if (n >= 1000) return "$" + Math.round(n).toLocaleString();
  return "$" + n.toFixed(2);
}

function truncateAddress(addr: string): string {
  if (!addr) return "";
  const clean = addr.startsWith("0x") ? addr : "0x" + addr;
  if (clean.length <= 12) return clean;
  return clean.slice(0, 6) + "…" + clean.slice(-4);
}

function tierColor(tier?: string | null): string {
  switch ((tier || "").toLowerCase()) {
    case "ultimate":
    case "moment_tier_ultimate":
      return "#EC4899";
    case "legendary":
    case "moment_tier_legendary":
      return "#F59E0B";
    case "rare":
    case "moment_tier_rare":
      return "#818CF8";
    case "fandom":
    case "moment_tier_fandom":
      return "#34D399";
    case "common":
    case "moment_tier_common":
      return "#9CA3AF";
    default:
      return "#6B7280";
  }
}

function tierHoloClass(tier?: string | null): string {
  const t = (tier || "").toLowerCase();
  if (t.includes("ultimate")) return "rpc-holo-ultimate";
  if (t.includes("legendary")) return "rpc-holo-legendary";
  if (t.includes("rare")) return "rpc-holo-rare";
  return "";
}

function collectionMeta(id: string) {
  const c = getCollection(id);
  return c ? { id: c.id, label: c.label, shortLabel: c.shortLabel, icon: c.icon, accent: c.accent } : null;
}

function collectionMetaByUuid(uuid: string) {
  for (const c of publishedCollections()) {
    if (c.supabaseCollectionId === uuid) return c;
  }
  return null;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [bio, setBio] = useState<Bio | null>(null);
  const [wallets, setWallets] = useState<SavedWallet[]>([]);
  const [trophies, setTrophies] = useState<Trophy[]>([]);
  const [hero, setHero] = useState<HeroMoment | null>(null);
  const [heroReason, setHeroReason] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);

  const [loading, setLoading] = useState(true);
  const [walletForm, setWalletForm] = useState({ addr: "", nickname: "", collectionId: "nba-top-shot" });
  const [walletSaving, setWalletSaving] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [meRes, bioRes, walletsRes, trophiesRes, heroRes, favRes, actRes, recRes] = await Promise.all([
        fetch("/api/profile/me", { cache: "no-store" }),
        fetch("/api/profile/bio", { cache: "no-store" }),
        fetch("/api/profile/saved-wallets", { cache: "no-store" }),
        fetch("/api/profile/trophy", { cache: "no-store" }),
        fetch("/api/profile/hero-moment", { cache: "no-store" }),
        fetch("/api/profile/favorites", { cache: "no-store" }),
        fetch("/api/profile/activity", { cache: "no-store" }),
        fetch("/api/profile/recent-searches", { cache: "no-store" }),
      ]);
      const me = meRes.ok ? await meRes.json() : { user: null };
      setEmail(me?.user?.email ?? null);
      setUserId(me?.user?.id ?? null);

      if (bioRes.ok) {
        const b = await bioRes.json();
        setBio(b?.bio ?? null);
      }
      if (walletsRes.ok) {
        const w = await walletsRes.json();
        setWallets(w?.wallets ?? []);
      }
      if (trophiesRes.ok) {
        const t = await trophiesRes.json();
        setTrophies(t?.trophies ?? []);
      }
      if (heroRes.ok) {
        const h = await heroRes.json();
        setHero(h?.hero ?? null);
        setHeroReason(h?.reason ?? null);
      }
      if (favRes.ok) {
        const f = await favRes.json();
        setFavorites(f?.favorites ?? []);
      }
      if (actRes.ok) {
        const a = await actRes.json();
        setActivity(a?.activity ?? []);
      }
      if (recRes.ok) {
        const r = await recRes.json();
        setRecentSearches(r?.searches ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addWallet = useCallback(async () => {
    const addr = walletForm.addr.trim().toLowerCase();
    if (!addr) {
      setWalletError("Address required");
      return;
    }
    setWalletSaving(true);
    setWalletError(null);
    try {
      const collection = getCollection(walletForm.collectionId);
      const res = await fetch("/api/profile/saved-wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddr: addr,
          collectionId: collection?.supabaseCollectionId,
          nickname: walletForm.nickname.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setWalletForm({ addr: "", nickname: "", collectionId: "nba-top-shot" });
      await refresh();
    } catch (err: any) {
      setWalletError(err.message || "Failed to save");
    } finally {
      setWalletSaving(false);
    }
  }, [walletForm, refresh]);

  const removeWallet = useCallback(async (w: SavedWallet) => {
    await fetch("/api/profile/saved-wallets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddr: w.wallet_addr, collectionId: w.collection_id }),
    });
    await refresh();
  }, [refresh]);

  const toggleFavorite = useCallback(async (collectionUuid: string, currentlyFav: boolean) => {
    await fetch("/api/profile/favorites", {
      method: currentlyFav ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId: collectionUuid }),
    });
    await refresh();
  }, [refresh]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const totalMoments = useMemo(
    () => wallets.reduce((s, w) => s + (w.cached_moment_count ?? 0), 0),
    [wallets]
  );
  const totalFmv = useMemo(
    () => wallets.reduce((s, w) => s + (Number(w.cached_fmv) || 0), 0),
    [wallets]
  );
  const collectionCount = useMemo(
    () => new Set(wallets.map((w) => w.collection_id)).size,
    [wallets]
  );

  // News feed: flatten news from favorited collections, sort by date desc
  const newsItems = useMemo(() => {
    const favSet = new Set(favorites.filter((f) => f.favorited).map((f) => f.collection_id));
    const out: Array<{ title: string; date: string; summary: string; url: string; collectionId: string; collectionLabel: string; accent: string }> = [];
    for (const col of publishedCollections()) {
      if (!col.supabaseCollectionId || !favSet.has(col.supabaseCollectionId)) continue;
      for (const n of col.news ?? []) {
        out.push({ ...n, collectionId: col.id, collectionLabel: col.shortLabel, accent: col.accent });
      }
    }
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    return out;
  }, [favorites]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <RpcLogo size={56} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .rpc-section { background:#18181b; border:1px solid #27272a; border-radius:10px; padding:16px 18px; }
        .rpc-section-title { font-family:${condensedFont}; font-weight:800; font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:rgba(255,255,255,0.7); margin-bottom:12px; }
        @media (max-width: 768px){ .rpc-profile-main { padding: 14px 14px 80px !important; } }
      `}</style>

      <main className="rpc-profile-main" style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 24px 60px", display: "flex", flexDirection: "column", gap: 18 }}>

        {/* ── Header ── */}
        <section className="rpc-section" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <RpcLogo size={40} />
            <div>
              <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                {bio?.display_name ?? (email?.split("@")[0] ?? "Profile")}
              </div>
              <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.04em", marginTop: 2 }}>
                {email ?? "Not signed in"}
              </div>
            </div>
          </div>
          <SignOutButton />
        </section>

        {/* ── Hero Holo Moment ── */}
        <HeroMomentCard hero={hero} reason={heroReason} />

        {/* ── Stats Tiles ── */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
          <StatTile label="Total Moments" value={totalMoments.toLocaleString()} color="#fff" />
          <StatTile label="Portfolio FMV" value={fmtUsd(totalFmv)} color="#34D399" />
          <StatTile label="Collections" value={String(collectionCount)} color="#A855F7" />
        </section>

        {/* ── Trophy Case ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Trophy Case</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
            {[1, 2, 3, 4, 5, 6].map((slot) => {
              const t = trophies.find((x) => x.slot === slot);
              if (!t) {
                return (
                  <div key={slot} className="rpc-binder-slot" style={{ aspectRatio: "1/1", background: "#0d0d0d", border: "1px dashed #27272a", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em" }}>
                    SLOT {slot}
                  </div>
                );
              }
              const cMeta = collectionMetaByUuid(t.collection_id);
              return (
                <div key={slot} className={`rpc-binder-slot ${tierHoloClass(t.tier)}`} style={{ position: "relative", aspectRatio: "1/1", background: "#111", border: `1px solid ${tierColor(t.tier)}66`, borderRadius: 8, overflow: "hidden" }}>
                  {t.thumbnail_url && (
                    <img src={t.thumbnail_url} alt={t.player_name || ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )}
                  <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "6px 8px", background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))", fontSize: 10, fontFamily: condensedFont, fontWeight: 700 }}>
                    <div style={{ color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.player_name ?? t.moment_id}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 2, alignItems: "center" }}>
                      {cMeta && (
                        <span style={{ fontSize: 9, letterSpacing: "0.08em", color: cMeta.accent, textTransform: "uppercase" }}>{cMeta.shortLabel}</span>
                      )}
                      <span style={{ fontSize: 9, color: "#34D399", marginLeft: "auto" }}>{t.fmv != null ? fmtUsd(Number(t.fmv)) : ""}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Saved Wallets ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Saved Wallets</div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            <select
              value={walletForm.collectionId}
              onChange={(e) => setWalletForm({ ...walletForm, collectionId: e.target.value })}
              style={{ padding: "8px 10px", background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 6, color: "#fff", fontFamily: monoFont, fontSize: 12 }}
            >
              {publishedCollections().map((c) => (
                <option key={c.id} value={c.id}>{c.icon} {c.shortLabel}</option>
              ))}
            </select>
            <input
              value={walletForm.addr}
              onChange={(e) => setWalletForm({ ...walletForm, addr: e.target.value })}
              placeholder="0x… wallet address"
              style={{ flex: 1, minWidth: 220, padding: "8px 10px", background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 6, color: "#fff", fontFamily: monoFont, fontSize: 12 }}
            />
            <input
              value={walletForm.nickname}
              onChange={(e) => setWalletForm({ ...walletForm, nickname: e.target.value })}
              placeholder="Nickname (optional)"
              style={{ width: 180, padding: "8px 10px", background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 6, color: "#fff", fontFamily: condensedFont, fontSize: 12 }}
            />
            <button onClick={addWallet} disabled={walletSaving} style={primaryBtnStyle}>
              {walletSaving ? "Saving…" : "+ Add"}
            </button>
          </div>
          {walletError && <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginBottom: 10 }}>{walletError}</div>}

          {wallets.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.45)", padding: "12px 0" }}>
              Add a wallet to see your moments across collections.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
              {wallets.map((w) => {
                const cMeta = collectionMetaByUuid(w.collection_id);
                return (
                  <div key={`${w.wallet_addr}_${w.collection_id}`} style={{ background: "#0d0d0d", border: "1px solid #27272a", borderBottom: `2px solid ${cMeta?.accent ?? "#333"}`, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {cMeta?.icon} {cMeta?.shortLabel}
                      </div>
                      <button onClick={() => removeWallet(w)} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 12, cursor: "pointer" }}>✕</button>
                    </div>
                    <div style={{ fontFamily: monoFont, fontSize: 11, color: "#fff", marginTop: 4 }}>
                      {w.nickname ? `${w.nickname} — ` : ""}{truncateAddress(w.wallet_addr)}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                      <div>
                        <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Moments</div>
                        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14 }}>{(w.cached_moment_count ?? 0).toLocaleString()}</div>
                      </div>
                      <div>
                        <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>FMV</div>
                        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "#34D399" }}>{fmtUsd(Number(w.cached_fmv) || 0)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Favorite Collections + News Feed ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Favorite Collections</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {publishedCollections().map((c) => {
              const uuid = c.supabaseCollectionId;
              const isFav = uuid ? favorites.some((f) => f.collection_id === uuid && f.favorited) : false;
              return (
                <button
                  key={c.id}
                  onClick={() => uuid && toggleFavorite(uuid, isFav)}
                  style={{
                    background: isFav ? `${c.accent}22` : "#0d0d0d",
                    border: `1px solid ${isFav ? c.accent : "#27272a"}`,
                    color: isFav ? c.accent : "rgba(255,255,255,0.6)",
                    padding: "8px 14px",
                    borderRadius: 20,
                    fontFamily: condensedFont,
                    fontWeight: 700,
                    fontSize: 12,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {isFav ? "★" : "☆"} {c.icon} {c.shortLabel}
                </button>
              );
            })}
          </div>

          {newsItems.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="rpc-section-title">News Feed</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {newsItems.map((n, i) => (
                  <a key={i} href={n.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", background: "#0d0d0d", border: "1px solid #27272a", borderLeft: `3px solid ${n.accent}`, borderRadius: 6, padding: "10px 12px", textDecoration: "none", color: "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontFamily: monoFont, fontSize: 10, color: n.accent, letterSpacing: "0.08em", textTransform: "uppercase" }}>{n.collectionLabel}</span>
                      <span style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{n.date}</span>
                    </div>
                    <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, letterSpacing: "0.02em" }}>{n.title}</div>
                    <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 4, lineHeight: 1.4 }}>{n.summary}</div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── Friend Activity ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Friend Activity</div>
          {activity.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
              Follow other collectors to see their sales here.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activity.map((a, i) => {
                const cMeta = collectionMetaByUuid(a.collection_id);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 6 }}>
                    {a.thumbnail_url && <img src={a.thumbnail_url} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.followee_username ?? "someone"} {a.role === "seller" ? "sold" : "bought"} {a.player_name ?? "a moment"}{a.serial_number ? ` #${a.serial_number}` : ""}
                      </div>
                      <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", display: "flex", gap: 8, marginTop: 2 }}>
                        {cMeta && <span style={{ color: cMeta.accent }}>{cMeta.shortLabel}</span>}
                        <span>{timeAgo(a.sold_at)}</span>
                      </div>
                    </div>
                    <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "#34D399" }}>
                      {a.price_usd != null ? fmtUsd(Number(a.price_usd)) : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Recent Searches ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Recent Searches</div>
          {recentSearches.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>No searches yet.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {recentSearches.map((s) => (
                <span key={s.id} style={{ padding: "4px 10px", background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 16, fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
                  {s.query}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* ── Link Flow Wallet (on-chain actions) ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Link a Flow Wallet (on-chain actions)</div>
          <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 10, lineHeight: 1.5 }}>
            Connect a Dapper wallet to execute cart purchases, place offers, or sign on-chain actions. This is separate from email sign-in.
          </div>
          <ConnectButton />
        </section>

      </main>

      <MobileNav />
      <SupportChatConnected />
    </div>
  );
}

function HeroMomentCard({ hero, reason }: { hero: HeroMoment | null; reason: string | null }) {
  if (!hero) {
    return (
      <section className="rpc-section rpc-binder-slot" style={{ padding: "28px 20px", textAlign: "center" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.85)" }}>
          Add a wallet to reveal your hero moment
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 6, letterSpacing: "0.04em" }}>
          {reason === "no_moments" ? "We know your wallet but haven't ingested its moments yet." : reason === "no_fmv_yet" ? "Moments indexed — FMV pipeline catching up." : "No wallets saved."}
        </div>
      </section>
    );
  }

  const holoClass = tierHoloClass(hero.tier);
  const tc = tierColor(hero.tier);

  return (
    <section className={`rpc-binder-slot ${holoClass}`} style={{ position: "relative", background: "#111", border: `2px solid ${tc}`, borderRadius: 14, padding: 14, overflow: "hidden", display: "flex", gap: 16, alignItems: "center" }}>
      {hero.thumbnail_url && (
        <img src={hero.thumbnail_url} alt={hero.player_name ?? ""} style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 10, border: `1px solid ${tc}66`, flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: monoFont, fontSize: 10, color: tc, letterSpacing: "0.14em", textTransform: "uppercase" }}>Hero Moment</div>
        <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 26, letterSpacing: "0.02em", marginTop: 2, lineHeight: 1.1 }}>
          {hero.player_name ?? "Unknown"}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
          {hero.set_name ?? ""}{hero.serial_number ? ` · #${hero.serial_number}${hero.circulation_count ? `/${hero.circulation_count}` : ""}` : ""}
        </div>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, color: "#34D399", marginTop: 8 }}>
          {fmtUsd(hero.fmv_usd)}
        </div>
      </div>
    </section>
  );
}

function StatTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: condensedFont, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  background: ACCENT_RED,
  border: "none",
  color: "#fff",
  padding: "8px 18px",
  borderRadius: 6,
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
};
