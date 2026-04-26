"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import RpcLogo from "@/components/RpcLogo";
import SignOutButton from "@/components/auth/SignOutButton";
import { ConnectButton } from "@/components/auth/ConnectButton";
import SignInWithDapper from "@/components/SignInWithDapper";
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
  hero_moment_id?: string | null;
  hero_moment_collection_id?: string | null;
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
  verified_at: string | null;
  verification_method: string | null;
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
  momentId: string;
  collectionId: string | null;
  collectionUuid: string | null;
  collectionLabel: string | null;
  collectionAccent: string | null;
  editionKey: string | null;
  serialNumber: number | null;
  mintCount?: number | null;
  playerName: string | null;
  setName: string | null;
  tier: string | null;
  imageUrl: string | null;
  fmvUsd: number;
  isLocked?: boolean;
  isManualOverride?: boolean;
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

interface CollectionStat {
  collection_id: string;
  collection_slug: string;
  collection_label: string;
  moment_count: number;
  fmv_total: number;
  fmv_max: number;
  priced_count: number;
  locked_count: number;
  top_tier: string | null;
}

interface TopMoment {
  moment_id: string;
  collection_id: string;
  collection_slug: string;
  wallet_address: string;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  serial_number: number | null;
  mint_count: number | null;
  fmv_usd: number | null;
  image_url: string | null;
  is_locked: boolean;
  series_number: number | null;
  edition_key: string | null;
  character_name?: string | null;
  edition_name?: string | null;
}

interface ChallengeRow {
  id: string;
  wallet_addr: string;
  challenge_amount: number;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_via: string | null;
  matched_moment_id: string | null;
  expired?: boolean;
  msRemaining?: number;
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

function collectionMetaByUuid(uuid: string) {
  for (const c of publishedCollections()) {
    if (c.supabaseCollectionId === uuid) return c;
  }
  return null;
}

function collectionMetaBySlug(slug: string) {
  // collection_slug from RPC may use underscores (e.g. "nba_top_shot")
  const normalized = slug.replace(/_/g, "-");
  return getCollection(normalized) ?? null;
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

function formatCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  // Next 16 requires a Suspense boundary above any tree that reads
  // useSearchParams. The inner component handles its own loading state.
  return (
    <Suspense fallback={null}>
      <ProfilePageInner />
    </Suspense>
  );
}

function ProfilePageInner() {
  const search = useSearchParams();
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [bio, setBio] = useState<Bio | null>(null);
  const [wallets, setWallets] = useState<SavedWallet[]>([]);
  const [trophies, setTrophies] = useState<Trophy[]>([]);
  const [hero, setHero] = useState<HeroMoment | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [statsByWallet, setStatsByWallet] = useState<Record<string, CollectionStat[]>>({});

  const [loading, setLoading] = useState(true);

  const [usernameInput, setUsernameInput] = useState("");
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const indexingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const indexingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [walletForm, setWalletForm] = useState({ addr: "", nickname: "", collectionId: "nba-top-shot" });
  const [walletSaving, setWalletSaving] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; tone: "success" | "info" }>>([]);

  // Pin flow: which slot is being filled, and whether the modal is open.
  const [pinSlot, setPinSlot] = useState<number | null>(null);
  // Hero edit flow: open the same picker but write to profile_bio instead of trophy_moments.
  const [heroEditOpen, setHeroEditOpen] = useState(false);
  // Verification: which wallet is currently in the verify-by-listing modal.
  const [verifyWallet, setVerifyWallet] = useState<string | null>(null);

  const pushToast = useCallback((text: string, tone: "success" | "info" = "success") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const refreshStats = useCallback(async (addrs: string[]) => {
    if (addrs.length === 0) {
      setStatsByWallet({});
      return;
    }
    const out: Record<string, CollectionStat[]> = {};
    await Promise.all(
      addrs.map(async (addr) => {
        try {
          const res = await fetch(
            "/api/profile/collection-stats?wallet_addr=" + encodeURIComponent(addr),
            { cache: "no-store" }
          );
          if (!res.ok) return;
          const d = await res.json();
          out[addr] = (d?.stats ?? []).map((r: any) => ({
            collection_id: r.collection_id,
            collection_slug: r.collection_slug,
            collection_label: r.collection_label,
            moment_count: Number(r.moment_count) || 0,
            fmv_total: Number(r.fmv_total) || 0,
            fmv_max: Number(r.fmv_max) || 0,
            priced_count: Number(r.priced_count) || 0,
            locked_count: Number(r.locked_count) || 0,
            top_tier: r.top_tier ?? null,
          }));
        } catch {
          // swallow per-wallet errors so others still render
        }
      })
    );
    setStatsByWallet(out);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [meRes, bioRes, walletsRes, trophiesRes, favRes, actRes, recRes] = await Promise.all([
        fetch("/api/profile/me", { cache: "no-store" }),
        fetch("/api/profile/bio", { cache: "no-store" }),
        fetch("/api/profile/saved-wallets", { cache: "no-store" }),
        fetch("/api/profile/trophy", { cache: "no-store" }),
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
      let walletList: SavedWallet[] = [];
      if (walletsRes.ok) {
        const w = await walletsRes.json();
        walletList = w?.wallets ?? [];
        setWallets(walletList);
      }
      let trophyList: Trophy[] = [];
      if (trophiesRes.ok) {
        const t = await trophiesRes.json();
        trophyList = t?.trophies ?? [];
        setTrophies(trophyList);
      }
      // Hero: only fetch when there are no trophies pinned. The card is gated
      // by trophyList.length === 0 below, so skipping the round-trip is safe.
      if (trophyList.length === 0) {
        const heroRes = await fetch("/api/profile/hero-moment", { cache: "no-store" });
        if (heroRes.ok) {
          const h = await heroRes.json();
          setHero(h?.hero ?? null);
        }
      } else {
        setHero(null);
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

      // Per-wallet collection stats (one fetch per unique wallet_addr).
      const uniqueAddrs = Array.from(new Set(walletList.map((w) => w.wallet_addr.toLowerCase())));
      refreshStats(uniqueAddrs);
    } finally {
      setLoading(false);
    }
  }, [refreshStats]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Open the pin modal when ?pin=<slot> is present in the URL. Kept around
  // so any old links that still hit /profile?pin= land somewhere useful.
  useEffect(() => {
    const slotParam = search?.get("pin");
    if (!slotParam) return;
    const slot = Number(slotParam);
    if (Number.isFinite(slot) && slot >= 1 && slot <= 6) {
      setPinSlot(slot);
    } else {
      setPinSlot(1);
    }
  }, [search]);

  useEffect(() => {
    return () => {
      if (indexingPollRef.current) clearInterval(indexingPollRef.current);
      if (indexingStopRef.current) clearTimeout(indexingStopRef.current);
    };
  }, []);

  const stopIndexingPoll = useCallback(() => {
    if (indexingPollRef.current) {
      clearInterval(indexingPollRef.current);
      indexingPollRef.current = null;
    }
    if (indexingStopRef.current) {
      clearTimeout(indexingStopRef.current);
      indexingStopRef.current = null;
    }
    setIndexing(false);
  }, []);

  const startIndexingPoll = useCallback(() => {
    if (indexingPollRef.current) clearInterval(indexingPollRef.current);
    if (indexingStopRef.current) clearTimeout(indexingStopRef.current);
    setIndexing(true);
    indexingPollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/profile/saved-wallets", { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        const ws: SavedWallet[] = d?.wallets ?? [];
        setWallets(ws);
        const uniqueAddrs = Array.from(new Set(ws.map((w) => w.wallet_addr.toLowerCase())));
        // Refresh per-collection stats so the spinner numbers populate as the
        // background indexer finishes each collection.
        refreshStats(uniqueAddrs);
        const allHaveStats = uniqueAddrs.every((a) => {
          const stats = statsByWallet[a];
          return stats && stats.some((s) => s.moment_count > 0);
        });
        if (allHaveStats && uniqueAddrs.length > 0) {
          stopIndexingPoll();
          refresh();
        }
      } catch {
        // keep polling
      }
    }, 10000);
    indexingStopRef.current = setTimeout(() => {
      stopIndexingPoll();
      refresh();
    }, 60000);
  }, [refresh, refreshStats, statsByWallet, stopIndexingPoll]);

  const resolveAndAssociate = useCallback(async () => {
    const username = usernameInput.trim();
    if (!username) {
      setUsernameError("Dapper username required");
      return;
    }
    setUsernameSaving(true);
    setUsernameError(null);
    try {
      const res = await fetch("/api/profile/resolve-and-associate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const addr = data.walletAddress as string;
      const count = Array.isArray(data.associatedCollections) ? data.associatedCollections.length : 0;
      pushToast(`Loaded wallet ${truncateAddress(addr)} across ${count} collections`, "success");
      pushToast(
        `Indexing your moments across ${count} collections — this usually takes 30-60 seconds`,
        "info"
      );
      setUsernameInput("");
      await refresh();
      startIndexingPoll();
    } catch (err: any) {
      setUsernameError(err.message || "Failed to resolve");
    } finally {
      setUsernameSaving(false);
    }
  }, [usernameInput, refresh, pushToast, startIndexingPoll]);

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
      pushToast(`Added ${truncateAddress(addr)}`, "success");
      await refresh();
    } catch (err: any) {
      setWalletError(err.message || "Failed to save");
    } finally {
      setWalletSaving(false);
    }
  }, [walletForm, refresh, pushToast]);

  const removeWallet = useCallback(async (w: SavedWallet) => {
    await fetch("/api/profile/saved-wallets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddr: w.wallet_addr }),
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
    () =>
      Object.values(statsByWallet)
        .flat()
        .reduce((s, r) => s + (r.moment_count ?? 0), 0),
    [statsByWallet]
  );
  const totalFmv = useMemo(
    () =>
      Object.values(statsByWallet)
        .flat()
        .reduce((s, r) => s + (r.fmv_total ?? 0), 0),
    [statsByWallet]
  );
  const collectionCount = useMemo(() => {
    const ids = new Set<string>();
    for (const stats of Object.values(statsByWallet)) {
      for (const s of stats) {
        if (s.moment_count > 0 && s.collection_id) ids.add(s.collection_id);
      }
    }
    return ids.size;
  }, [statsByWallet]);

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

  // Group saved_wallets by physical wallet address — one card per unique
  // wallet, with sub-cards from collection-stats inside.
  const groupedWallets = useMemo(() => {
    const map = new Map<string, { addr: string; rows: SavedWallet[]; nickname: string | null; verifiedAt: string | null }>();
    for (const w of wallets) {
      const key = w.wallet_addr.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.rows.push(w);
        if (!existing.nickname && w.nickname) existing.nickname = w.nickname;
        if (!existing.verifiedAt && w.verified_at) existing.verifiedAt = w.verified_at;
      } else {
        map.set(key, {
          addr: w.wallet_addr,
          rows: [w],
          nickname: w.nickname ?? null,
          verifiedAt: w.verified_at ?? null,
        });
      }
    }
    return Array.from(map.values());
  }, [wallets]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <RpcLogo size={56} />
      </div>
    );
  }

  const showHero = trophies.filter(Boolean).length === 0 && hero !== null;

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .rpc-section { background:#18181b; border:1px solid #27272a; border-radius:10px; padding:16px 18px; }
        .rpc-section-title { font-family:${condensedFont}; font-weight:800; font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:rgba(255,255,255,0.7); margin-bottom:12px; }
        .rpc-wallet-card { transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease; }
        .rpc-wallet-subcard { transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease; cursor: pointer; text-decoration: none; color: inherit; }
        .rpc-wallet-subcard:hover { border-color: var(--rpc-accent, #555); transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.55); }
        .rpc-spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff; border-radius: 50%; display: inline-block; animation: rpc-spin 900ms linear infinite; }
        .rpc-spinner-sm { width: 9px; height: 9px; border: 1.5px solid rgba(255,255,255,0.2); border-top-color: #fff; border-radius: 50%; display: inline-block; animation: rpc-spin 900ms linear infinite; }
        @keyframes rpc-spin { to { transform: rotate(360deg); } }
        .rpc-edit-pencil { opacity: 0; transition: opacity 150ms ease; }
        .rpc-hero-section:hover .rpc-edit-pencil { opacity: 1; }
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

        {/* ── Hero: onboarding CTA / HeroMoment / Trophy Case ── */}
        {wallets.length === 0 ? (
          <SignInBanner
            usernameInput={usernameInput}
            setUsernameInput={setUsernameInput}
            onUsernameSubmit={resolveAndAssociate}
            saving={usernameSaving}
            error={usernameError}
          />
        ) : showHero ? (
          <HeroMomentCard
            hero={hero!}
            onEdit={() => setHeroEditOpen(true)}
          />
        ) : trophies.length > 0 ? (
          <TrophyCaseSection trophies={trophies} onPickSlot={setPinSlot} />
        ) : (
          <EmptyHeroState wallets={wallets} indexing={indexing} onPickSlot={setPinSlot} />
        )}

        {/* ── Stats Tiles ── */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
          <StatTile label="Total Moments" value={totalMoments.toLocaleString()} color="#fff" />
          <StatTile label="Portfolio FMV" value={fmtUsd(totalFmv)} color="#34D399" />
          <StatTile label="Collections" value={String(collectionCount)} color="#A855F7" />
        </section>

        {/* Trophy Case is the hero slot when trophies exist; render it again
            below the stats only when the hero card occupied the top slot, so
            users still get the 6-grid pin UI without scrolling past it. */}
        {wallets.length > 0 && showHero && (
          <TrophyCaseSection trophies={trophies} onPickSlot={setPinSlot} />
        )}

        {/* ── Saved Wallets ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Saved Wallets</div>

          <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 8, lineHeight: 1.5 }}>
            Add a wallet by entering your Dapper username — we'll associate it with NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle automatically.
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") resolveAndAssociate(); }}
              placeholder="Dapper username"
              style={{ flex: 1, minWidth: 220, padding: "10px 12px", background: "#0d0d0d", border: `1px solid ${ACCENT_RED}66`, borderRadius: 6, color: "#fff", fontFamily: monoFont, fontSize: 13 }}
            />
            <button onClick={resolveAndAssociate} disabled={usernameSaving} style={primaryBtnStyle}>
              {usernameSaving ? "Loading…" : "Load my collection"}
            </button>
          </div>
          {usernameError && (
            <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginBottom: 10 }}>
              {usernameError}{" "}
              <button onClick={() => setShowAdvanced(true)} style={linkBtnStyle}>
                Advanced: enter wallet address directly
              </button>
            </div>
          )}

          {!showAdvanced && !usernameError && (
            <div style={{ marginBottom: 14 }}>
              <button onClick={() => setShowAdvanced(true)} style={linkBtnStyle}>
                Advanced: enter wallet address directly
              </button>
            </div>
          )}

          {showAdvanced && (
            <div style={{ marginBottom: 14, padding: 12, background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>
                  Advanced: wallet address
                </div>
                <button onClick={() => { setShowAdvanced(false); setWalletError(null); }} style={linkBtnStyle}>
                  Hide
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select
                  value={walletForm.collectionId}
                  onChange={(e) => setWalletForm({ ...walletForm, collectionId: e.target.value })}
                  style={{ padding: "8px 10px", background: "#080808", border: "1px solid #27272a", borderRadius: 6, color: "#fff", fontFamily: monoFont, fontSize: 12 }}
                >
                  {publishedCollections().map((c) => (
                    <option key={c.id} value={c.id}>{c.icon} {c.shortLabel}</option>
                  ))}
                </select>
                <input
                  value={walletForm.addr}
                  onChange={(e) => setWalletForm({ ...walletForm, addr: e.target.value })}
                  placeholder="0x… wallet address"
                  style={{ flex: 1, minWidth: 220, padding: "8px 10px", background: "#080808", border: "1px solid #27272a", borderRadius: 6, color: "#fff", fontFamily: monoFont, fontSize: 12 }}
                />
                <input
                  value={walletForm.nickname}
                  onChange={(e) => setWalletForm({ ...walletForm, nickname: e.target.value })}
                  placeholder="Nickname (optional)"
                  style={{ width: 180, padding: "8px 10px", background: "#080808", border: "1px solid #27272a", borderRadius: 6, color: "#fff", fontFamily: condensedFont, fontSize: 12 }}
                />
                <button onClick={addWallet} disabled={walletSaving} style={primaryBtnStyle}>
                  {walletSaving ? "Saving…" : "+ Add"}
                </button>
              </div>
              {walletError && <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginTop: 8 }}>{walletError}</div>}
            </div>
          )}

          {groupedWallets.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.45)", padding: "12px 0" }}>
              Add a wallet to see your moments across collections.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {groupedWallets.map((g) => (
                <WalletGroupCard
                  key={g.addr}
                  group={g}
                  stats={statsByWallet[g.addr.toLowerCase()] ?? []}
                  indexing={indexing}
                  onRemove={() => removeWallet(g.rows[0])}
                  onVerify={() => setVerifyWallet(g.addr)}
                />
              ))}
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

      {/* ── Modals ── */}
      {pinSlot != null && (
        <PinModal
          slot={pinSlot}
          ownerKey={userId ? null : (wallets[0]?.wallet_addr ?? null)}
          onClose={() => setPinSlot(null)}
          onPinned={async () => { setPinSlot(null); await refresh(); pushToast("Trophy pinned", "success"); }}
        />
      )}
      {heroEditOpen && (
        <HeroEditModal
          ownerKey={userId ? null : (wallets[0]?.wallet_addr ?? null)}
          onClose={() => setHeroEditOpen(false)}
          onPicked={async () => { setHeroEditOpen(false); await refresh(); pushToast("Hero updated", "success"); }}
        />
      )}
      {verifyWallet && (
        <VerifyByListingModal
          walletAddr={verifyWallet}
          onClose={() => setVerifyWallet(null)}
          onVerified={async () => { setVerifyWallet(null); await refresh(); pushToast("Wallet verified", "success"); }}
        />
      )}

      {/* ── Toasts ── */}
      {toasts.length > 0 && (
        <div style={{ position: "fixed", bottom: 80, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, pointerEvents: "none", zIndex: 10000 }}>
          {toasts.map((t) => (
            <div
              key={t.id}
              style={{
                pointerEvents: "auto",
                padding: "10px 16px",
                background: t.tone === "success" ? "#0d1a10" : "#0d0d15",
                border: `1px solid ${t.tone === "success" ? "#34D39966" : "#4F94D466"}`,
                color: t.tone === "success" ? "#34D399" : "#4F94D4",
                borderRadius: 8,
                fontFamily: monoFont,
                fontSize: 12,
                letterSpacing: "0.02em",
                boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
                maxWidth: 520,
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}

      <MobileNav />
      <SupportChatConnected />
    </div>
  );
}

// ── Sign-in Banner (no wallets yet) ─────────────────────────────────────────

function SignInBanner({
  usernameInput,
  setUsernameInput,
  onUsernameSubmit,
  saving,
  error,
}: {
  usernameInput: string;
  setUsernameInput: (v: string) => void;
  onUsernameSubmit: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <section
      className="rpc-card-neon rpc-scanlines"
      style={{ position: "relative", padding: "28px 24px", overflow: "hidden" }}
    >
      <div style={{ fontFamily: monoFont, fontSize: 10, color: ACCENT_RED, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 8 }}>
        Welcome to Rip Packs City
      </div>
      <div
        style={{
          fontFamily: condensedFont,
          fontWeight: 900,
          fontSize: 44,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          lineHeight: 0.95,
          color: "#fff",
          marginBottom: 10,
        }}
      >
        Get Started
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.5, marginBottom: 16, maxWidth: 620 }}>
        Sign in with your Dapper wallet for verified ownership across NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle.
      </div>

      <div style={{ marginBottom: 18 }}>
        <SignInWithDapper variant="primary" />
      </div>

      <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 10 }}>
        — or use a Top Shot username (unverified) —
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <input
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onUsernameSubmit(); }}
          placeholder="Dapper username"
          style={{
            flex: 1,
            minWidth: 260,
            padding: "12px 16px",
            background: "#0a0a0a",
            border: `1.5px solid ${ACCENT_RED}88`,
            borderRadius: 8,
            color: "#fff",
            fontFamily: monoFont,
            fontSize: 14,
            letterSpacing: "0.02em",
            outline: "none",
          }}
        />
        <button
          onClick={onUsernameSubmit}
          disabled={saving}
          style={{
            background: "transparent",
            border: `1.5px solid ${ACCENT_RED}`,
            color: ACCENT_RED,
            padding: "12px 24px",
            borderRadius: 8,
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Loading…" : "Load by username"}
        </button>
      </div>

      {error && (
        <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}

      <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.5, maxWidth: 620 }}>
        Wallet sign-in proves ownership on-chain. Username lookups are read-only and unverified — anyone can load anyone's public collection that way.
      </div>
    </section>
  );
}

// ── Hero Moment ─────────────────────────────────────────────────────────────

function HeroMomentCard({ hero, onEdit }: { hero: HeroMoment; onEdit: () => void }) {
  const holoClass = tierHoloClass(hero.tier);
  const tc = tierColor(hero.tier);
  return (
    <section
      className={`rpc-hero-section ${holoClass}`}
      style={{ position: "relative", background: "#111", border: `2px solid ${tc}`, borderRadius: 14, padding: 14, overflow: "hidden", display: "flex", gap: 16, alignItems: "center", maxHeight: 200 }}
    >
      <HeroMomentImage imageUrl={hero.imageUrl} playerName={hero.playerName} tier={hero.tier} tc={tc} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: monoFont, fontSize: 10, color: tc, letterSpacing: "0.14em", textTransform: "uppercase" }}>Hero Moment</span>
          {hero.isManualOverride && (
            <span style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.45)", letterSpacing: "0.1em", textTransform: "uppercase" }}>· pinned</span>
          )}
          <button
            onClick={onEdit}
            className="rpc-edit-pencil"
            aria-label="Edit hero moment"
            title="Edit hero moment"
            style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", padding: 0, fontSize: 13 }}
          >
            ✎
          </button>
        </div>
        <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 26, letterSpacing: "0.02em", marginTop: 2, lineHeight: 1.1 }}>
          {hero.playerName ?? "Unknown"}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
          {hero.setName ?? ""}
          {hero.serialNumber ? ` · #${hero.serialNumber}` : ""}
          {hero.mintCount ? `/${hero.mintCount}` : ""}
        </div>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, color: "#34D399", marginTop: 8 }}>
          {fmtUsd(hero.fmvUsd)}
        </div>
      </div>
    </section>
  );
}

function HeroMomentImage({ imageUrl, playerName, tier, tc }: { imageUrl: string | null; playerName: string | null; tier: string | null; tc: string; }) {
  const [failed, setFailed] = useState(false);
  const placeholderGlyph = (tier || "").toLowerCase().includes("ultimate")
    ? "◆"
    : (tier || "").toLowerCase().includes("legendary")
      ? "★"
      : "●";
  const commonStyle: React.CSSProperties = {
    width: 120,
    height: 120,
    objectFit: "cover",
    objectPosition: "center",
    borderRadius: 10,
    border: `1px solid ${tc}66`,
    flexShrink: 0,
  };
  if (!imageUrl || failed) {
    return (
      <div
        style={{
          ...commonStyle,
          background: `radial-gradient(circle at 30% 30%, ${tc}55, ${tc}11 70%, #111 100%)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: condensedFont,
          fontWeight: 900,
          fontSize: 44,
          color: tc,
        }}
        aria-label={playerName ? `${playerName} placeholder art` : "Hero moment placeholder"}
      >
        {placeholderGlyph}
      </div>
    );
  }
  return <img src={imageUrl} alt={playerName ?? ""} onError={() => setFailed(true)} style={commonStyle} />;
}

function EmptyHeroState({ wallets, indexing, onPickSlot }: { wallets: SavedWallet[]; indexing: boolean; onPickSlot: (slot: number) => void }) {
  const isIndexing = indexing && wallets.length > 0;
  return (
    <section className="rpc-section rpc-binder-slot" style={{ padding: "28px 20px", textAlign: "center" }}>
      <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.85)", display: "inline-flex", alignItems: "center", gap: 10 }}>
        {isIndexing && <span className="rpc-spinner" aria-hidden />}
        {isIndexing ? "Indexing your collection" : "Pin a moment to your trophy case"}
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 6, letterSpacing: "0.04em" }}>
        {isIndexing ? "This usually takes 30-60 seconds." : "Pick from your top-FMV moments to build your six-slot showcase."}
      </div>
      {!isIndexing && (
        <button onClick={() => onPickSlot(1)} style={{ ...primaryBtnStyle, marginTop: 12 }}>
          + Pick a moment
        </button>
      )}
    </section>
  );
}

// ── Trophy Case ─────────────────────────────────────────────────────────────

function TrophyCaseSection({ trophies, onPickSlot }: { trophies: Trophy[]; onPickSlot: (slot: number) => void }) {
  const emptySlotStyle: React.CSSProperties = {
    aspectRatio: "1/1",
    background: "#0d0d0d",
    border: "1px dashed #27272a",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: condensedFont,
    fontWeight: 800,
    fontSize: 36,
    color: "rgba(255,255,255,0.3)",
    textDecoration: "none",
    cursor: "pointer",
    width: "100%",
  };

  return (
    <section className="rpc-section">
      <div className="rpc-section-title">Trophy Case</div>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 12, letterSpacing: "0.02em", lineHeight: 1.5 }}>
        Pin your 6 best moments across any collection — your permanent flex.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
        {[1, 2, 3, 4, 5, 6].map((slot) => {
          const t = trophies.find((x) => x.slot === slot);
          if (!t) {
            return (
              <button
                key={slot}
                onClick={() => onPickSlot(slot)}
                className="rpc-binder-slot"
                style={emptySlotStyle}
                aria-label={`Pin moment to slot ${slot}`}
              >
                +
              </button>
            );
          }
          const cMeta = collectionMetaByUuid(t.collection_id);
          return (
            <div key={slot} className={`rpc-binder-slot ${tierHoloClass(t.tier)}`} style={{ position: "relative", aspectRatio: "1/1", background: "#111", border: `1px solid ${tierColor(t.tier)}66`, borderRadius: 8, overflow: "hidden" }}>
              {t.thumbnail_url && <img src={t.thumbnail_url} alt={t.player_name || ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "6px 8px", background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))", fontSize: 10, fontFamily: condensedFont, fontWeight: 700 }}>
                <div style={{ color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.player_name ?? t.moment_id}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 2, alignItems: "center" }}>
                  {cMeta && <span style={{ fontSize: 9, letterSpacing: "0.08em", color: cMeta.accent, textTransform: "uppercase" }}>{cMeta.shortLabel}</span>}
                  <span style={{ fontSize: 9, color: "#34D399", marginLeft: "auto" }}>{t.fmv != null ? fmtUsd(Number(t.fmv)) : ""}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Wallet Group Card (one per physical wallet, sub-cards per collection) ──

function WalletGroupCard({
  group,
  stats,
  indexing,
  onRemove,
  onVerify,
}: {
  group: { addr: string; rows: SavedWallet[]; nickname: string | null; verifiedAt: string | null };
  stats: CollectionStat[];
  indexing: boolean;
  onRemove: () => void;
  onVerify: () => void;
}) {
  const verified = !!group.verifiedAt;
  return (
    <div
      className="rpc-wallet-card"
      style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 10, padding: "12px 14px" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, letterSpacing: "0.02em", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {group.nickname ? `${group.nickname} — ` : ""}{truncateAddress(group.addr)}
          </div>
          {verified ? (
            <span
              title={`Verified ${group.verifiedAt}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                background: "#0a1f15",
                border: "1px solid #34D39966",
                color: "#34D399",
                fontFamily: monoFont,
                fontSize: 9,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderRadius: 12,
              }}
            >
              ✓ Verified
            </span>
          ) : (
            <button
              onClick={onVerify}
              style={{
                padding: "2px 10px",
                background: "transparent",
                border: "1px solid #F59E0B66",
                color: "#F59E0B",
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderRadius: 12,
                cursor: "pointer",
              }}
            >
              Verify by listing
            </button>
          )}
        </div>
        <button
          onClick={onRemove}
          aria-label="Remove saved wallet"
          style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 13, cursor: "pointer" }}
        >
          ✕
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
        {publishedCollections().map((col) => {
          const stat = stats.find(
            (s) => s.collection_id === col.supabaseCollectionId || s.collection_slug === col.id.replace(/-/g, "_")
          );
          const slug = col.id;
          const href = `/${slug}/collection?q=${encodeURIComponent(group.addr)}`;
          const moments = stat?.moment_count ?? 0;
          const fmv = stat?.fmv_total ?? 0;
          const locked = stat?.locked_count ?? 0;
          const fmvMax = stat?.fmv_max ?? 0;
          const showSpinner = moments === 0 && indexing;
          return (
            <Link
              key={col.id}
              href={href}
              className="rpc-wallet-subcard"
              style={{
                background: "#080808",
                border: "1px solid #1f1f23",
                borderBottom: `2px solid ${col.accent}`,
                borderRadius: 8,
                padding: "8px 10px",
                display: "block",
                ["--rpc-accent" as any]: col.accent,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: col.accent }}>
                  {col.icon} {col.shortLabel}
                </div>
                {showSpinner && <span className="rpc-spinner-sm" aria-hidden />}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                <div>
                  <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Moments</div>
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "#fff" }}>{moments.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>FMV</div>
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "#34D399" }}>{fmtUsd(fmv)}</div>
                </div>
              </div>
              {(fmvMax > 0 || locked > 0) && (
                <div style={{ display: "flex", gap: 8, marginTop: 4, fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.5)" }}>
                  {fmvMax > 0 && <span>Top {fmtUsd(fmvMax)}</span>}
                  {locked > 0 && <span>🔒 {locked.toLocaleString()}</span>}
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ── PinModal: tabbed grid + manual ──────────────────────────────────────────

function PinModal({
  slot,
  ownerKey,
  onClose,
  onPinned,
}: {
  slot: number;
  ownerKey: string | null;
  onClose: () => void;
  onPinned: () => void;
}) {
  const [tab, setTab] = useState<"grid" | "manual">("grid");
  const [moments, setMoments] = useState<TopMoment[] | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Manual entry
  const [manualId, setManualId] = useState("");
  const [manualPreview, setManualPreview] = useState<TopMoment | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = "/api/profile/top-moments?limit=24" + (ownerKey ? `&ownerKey=${encodeURIComponent(ownerKey)}` : "");
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setMoments(d?.moments ?? []); })
      .catch(() => { if (!cancelled) setMoments([]); });
    return () => { cancelled = true; };
  }, [ownerKey]);

  const pin = useCallback(async (m: TopMoment) => {
    setSaving(true);
    setPickError(null);
    try {
      const res = await fetch("/api/profile/trophy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot,
          momentId: m.moment_id,
          collectionId: m.collection_id,
          editionId: m.edition_key,
          playerName: m.player_name,
          setName: m.set_name,
          serialNumber: m.serial_number,
          circulationCount: m.mint_count,
          tier: m.tier,
          thumbnailUrl: m.image_url,
          fmv: m.fmv_usd,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onPinned();
    } catch (err: any) {
      setPickError(err?.message ?? "Failed to pin");
    } finally {
      setSaving(false);
    }
  }, [slot, onPinned]);

  return (
    <ModalShell onClose={onClose} title={`Pin to slot ${slot}`}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, borderBottom: "1px solid #27272a" }}>
        <TabBtn active={tab === "grid"} onClick={() => setTab("grid")}>Pick from collection</TabBtn>
        <TabBtn active={tab === "manual"} onClick={() => setTab("manual")}>Enter ID manually</TabBtn>
      </div>

      {tab === "grid" && (
        <>
          {moments == null ? (
            <div style={{ textAlign: "center", padding: 24 }}>
              <span className="rpc-spinner" />
            </div>
          ) : moments.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)", padding: 16, textAlign: "center" }}>
              No owned moments found yet — try the manual tab if you know the moment ID.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, maxHeight: 480, overflowY: "auto", paddingRight: 4 }}>
              {moments.map((m) => (
                <PickerCard key={`${m.collection_id}-${m.moment_id}`} m={m} disabled={saving} onClick={() => pin(m)} />
              ))}
            </div>
          )}
          {pickError && <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginTop: 8 }}>{pickError}</div>}
        </>
      )}

      {tab === "manual" && (
        <ManualPinForm
          slot={slot}
          manualId={manualId}
          setManualId={setManualId}
          preview={manualPreview}
          setPreview={setManualPreview}
          saving={saving}
          setSaving={setSaving}
          onPinned={onPinned}
        />
      )}
    </ModalShell>
  );
}

function HeroEditModal({
  ownerKey,
  onClose,
  onPicked,
}: {
  ownerKey: string | null;
  onClose: () => void;
  onPicked: () => void;
}) {
  const [moments, setMoments] = useState<TopMoment[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = "/api/profile/top-moments?limit=24" + (ownerKey ? `&ownerKey=${encodeURIComponent(ownerKey)}` : "");
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setMoments(d?.moments ?? []); })
      .catch(() => { if (!cancelled) setMoments([]); });
    return () => { cancelled = true; };
  }, [ownerKey]);

  const pick = useCallback(async (m: TopMoment) => {
    setSaving(true);
    setPickError(null);
    try {
      const res = await fetch("/api/profile/bio", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heroMomentId: m.moment_id, heroMomentCollectionId: m.collection_id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onPicked();
    } catch (err: any) {
      setPickError(err?.message ?? "Failed to set hero");
    } finally {
      setSaving(false);
    }
  }, [onPicked]);

  const clear = useCallback(async () => {
    setSaving(true);
    setPickError(null);
    try {
      await fetch("/api/profile/bio", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heroMomentId: null, heroMomentCollectionId: null }),
      });
      onPicked();
    } catch (err: any) {
      setPickError(err?.message ?? "Failed to clear");
    } finally {
      setSaving(false);
    }
  }, [onPicked]);

  return (
    <ModalShell onClose={onClose} title="Set Hero Moment">
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 10 }}>
        Pick the moment you want featured in your Hero card. Clear to fall back to your top-FMV moment automatically.
      </div>
      {moments == null ? (
        <div style={{ textAlign: "center", padding: 24 }}><span className="rpc-spinner" /></div>
      ) : moments.length === 0 ? (
        <div style={{ fontFamily: monoFont, fontSize: 12, color: "rgba(255,255,255,0.6)", padding: 16, textAlign: "center" }}>
          No owned moments found.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, maxHeight: 480, overflowY: "auto", paddingRight: 4 }}>
          {moments.map((m) => (
            <PickerCard key={`${m.collection_id}-${m.moment_id}`} m={m} disabled={saving} onClick={() => pick(m)} />
          ))}
        </div>
      )}
      {pickError && <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginTop: 8 }}>{pickError}</div>}
      <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
        <button onClick={clear} disabled={saving} style={{ ...linkBtnStyle, color: "#F59E0B" }}>
          Clear manual override
        </button>
      </div>
    </ModalShell>
  );
}

function PickerCard({ m, disabled, onClick }: { m: TopMoment; disabled: boolean; onClick: () => void }) {
  const tc = tierColor(m.tier);
  const borderColor = m.is_locked ? "#F59E0B" : "#34D399";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rpc-binder-slot ${tierHoloClass(m.tier)}`}
      style={{
        background: "#111",
        border: `2px solid ${borderColor}88`,
        borderRadius: 10,
        padding: 0,
        cursor: disabled ? "wait" : "pointer",
        position: "relative",
        textAlign: "left",
        overflow: "hidden",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div style={{ position: "relative", aspectRatio: "1/1", background: "#0a0a0a" }}>
        {m.image_url ? (
          <img src={m.image_url} alt={m.player_name ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: tc, fontSize: 32, fontFamily: condensedFont, fontWeight: 900 }}>●</div>
        )}
        {m.is_locked && (
          <div style={{ position: "absolute", top: 6, right: 6, fontSize: 12, color: "#F59E0B", textShadow: "0 0 4px rgba(0,0,0,0.8)" }} aria-label="Locked">🔒</div>
        )}
      </div>
      <div style={{ padding: "6px 8px" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 12, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {m.player_name ?? m.moment_id}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 9, color: "rgba(255,255,255,0.6)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {(m.set_name ?? "—")}{m.serial_number ? ` #${m.serial_number}` : ""}{m.mint_count ? `/${m.mint_count}` : ""}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, fontFamily: condensedFont, fontWeight: 800 }}>
          <span style={{ fontSize: 9, color: tc, letterSpacing: "0.1em", textTransform: "uppercase" }}>{m.tier ?? ""}</span>
          <span style={{ fontSize: 12, color: "#34D399" }}>{m.fmv_usd != null ? fmtUsd(Number(m.fmv_usd)) : "—"}</span>
        </div>
      </div>
    </button>
  );
}

function ManualPinForm({
  slot,
  manualId,
  setManualId,
  preview,
  setPreview,
  saving,
  setSaving,
  onPinned,
}: {
  slot: number;
  manualId: string;
  setManualId: (v: string) => void;
  preview: TopMoment | null;
  setPreview: (m: TopMoment | null) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  onPinned: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(async () => {
    const id = manualId.trim();
    if (!id) return;
    setError(null);
    try {
      // Lookup by raw moment ID against the user's own top-moments first;
      // most users will pin from their own collection. If absent, FMV will
      // be null but the trophy will still pin.
      const res = await fetch("/api/profile/top-moments?limit=96", { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        const found = (d?.moments ?? []).find((m: TopMoment) => String(m.moment_id) === id);
        if (found) {
          setPreview(found);
          return;
        }
      }
      setPreview({
        moment_id: id,
        collection_id: "",
        collection_slug: "",
        wallet_address: "",
        player_name: null,
        set_name: null,
        tier: null,
        serial_number: null,
        mint_count: null,
        fmv_usd: null,
        image_url: null,
        is_locked: false,
        series_number: null,
        edition_key: null,
      });
    } catch (e: any) {
      setError(e?.message ?? "Lookup failed");
    }
  }, [manualId, setPreview]);

  const pin = useCallback(async () => {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/trophy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot,
          momentId: preview.moment_id,
          collectionId: preview.collection_id || undefined,
          editionId: preview.edition_key,
          playerName: preview.player_name,
          setName: preview.set_name,
          serialNumber: preview.serial_number,
          circulationCount: preview.mint_count,
          tier: preview.tier,
          thumbnailUrl: preview.image_url,
          fmv: preview.fmv_usd,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onPinned();
    } catch (err: any) {
      setError(err?.message ?? "Failed to pin");
    } finally {
      setSaving(false);
    }
  }, [preview, slot, setSaving, onPinned]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
        Paste a moment ID to pin a trophy directly. Useful for moments outside your saved wallets (gifts, friends' moments you're holding).
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          placeholder="Moment ID"
          style={{ flex: 1, padding: "10px 12px", background: "#0a0a0a", border: "1px solid #27272a", borderRadius: 6, color: "#fff", fontFamily: monoFont, fontSize: 13 }}
        />
        <button onClick={lookup} style={primaryBtnStyle}>Look up</button>
      </div>
      {preview && (
        <div style={{ background: "#0a0a0a", border: "1px solid #27272a", borderRadius: 8, padding: 12, display: "flex", gap: 12 }}>
          {preview.image_url && <img src={preview.image_url} alt="" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6 }} />}
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "#fff" }}>{preview.player_name ?? preview.moment_id}</div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 4 }}>
              {preview.set_name ?? "—"}{preview.serial_number ? ` #${preview.serial_number}` : ""}{preview.mint_count ? `/${preview.mint_count}` : ""}
            </div>
            <div style={{ marginTop: 6, fontFamily: condensedFont, fontWeight: 800, color: "#34D399" }}>
              {preview.fmv_usd != null ? fmtUsd(Number(preview.fmv_usd)) : "FMV unknown"}
            </div>
          </div>
          <button onClick={pin} disabled={saving} style={primaryBtnStyle}>
            {saving ? "Pinning…" : "Pin"}
          </button>
        </div>
      )}
      {error && <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11 }}>{error}</div>}
    </div>
  );
}

// ── Verify by Listing ──────────────────────────────────────────────────────

function VerifyByListingModal({
  walletAddr,
  onClose,
  onVerified,
}: {
  walletAddr: string;
  onClose: () => void;
  onVerified: () => void;
}) {
  const [challenge, setChallenge] = useState<ChallengeRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load (or auto-mint) a challenge on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/profile/verify-challenge?wallet_addr=${encodeURIComponent(walletAddr)}`, { cache: "no-store" });
        if (res.ok) {
          const d = await res.json();
          if (cancelled) return;
          if (d?.challenge && !d.challenge.resolved_at && !d.challenge.expired) {
            setChallenge(d.challenge);
            return;
          }
        }
        // No active challenge — mint one.
        const minted = await fetch("/api/profile/verify-challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet_addr: walletAddr }),
        });
        const md = await minted.json();
        if (!minted.ok) throw new Error(md?.error ?? `HTTP ${minted.status}`);
        if (!cancelled) setChallenge(md.challenge);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to start verification");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddr]);

  const checkNow = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/verify-challenge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet_addr: walletAddr }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
      setChallenge(d.challenge);
      if (d.challenge?.resolved_at) onVerified();
    } catch (e: any) {
      setError(e?.message ?? "Check failed");
    } finally {
      setLoading(false);
    }
  }, [walletAddr, onVerified]);

  const expiresMs = challenge ? new Date(challenge.expires_at).getTime() - now : 0;

  return (
    <ModalShell onClose={onClose} title={`Verify ${truncateAddress(walletAddr)} by listing`}>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
        We'll prove you own this wallet by asking you to list any moment at a unique price for a few minutes. Once we see the listing in our cache, the wallet flips to verified automatically.
      </div>

      {loading && !challenge && (
        <div style={{ textAlign: "center", padding: 24 }}><span className="rpc-spinner" /></div>
      )}

      {challenge && (
        <div style={{ marginTop: 16, padding: 14, background: "#0a0a0a", border: "1px solid #27272a", borderRadius: 10 }}>
          <div style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>
            List any moment at exactly
          </div>
          <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 38, color: "#34D399", lineHeight: 1 }}>
            ${Number(challenge.challenge_amount).toFixed(2)}
          </div>
          <div style={{ marginTop: 8, fontFamily: monoFont, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
            On Top Shot or Flowty. We'll detect it within ~20 minutes (or click the button below to check immediately).
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={checkNow} disabled={loading} style={primaryBtnStyle}>
              {loading ? "Checking…" : "Check now"}
            </button>
            <span style={{ fontFamily: monoFont, fontSize: 11, color: expiresMs <= 0 ? "#F87171" : "rgba(255,255,255,0.6)" }}>
              {challenge.resolved_at
                ? "Verified ✓"
                : `Expires in ${formatCountdown(expiresMs)}`}
            </span>
          </div>
          {challenge.resolved_at && (
            <div style={{ marginTop: 12, color: "#34D399", fontFamily: monoFont, fontSize: 12 }}>
              ✓ Match found{challenge.matched_moment_id ? ` (moment ${challenge.matched_moment_id})` : ""}.
            </div>
          )}
        </div>
      )}

      {error && <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginTop: 10 }}>{error}</div>}
    </ModalShell>
  );
}

// ── Modal shell ────────────────────────────────────────────────────────────

function ModalShell({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 720, maxHeight: "90vh", overflow: "auto", background: "#111", border: "1px solid #27272a", borderRadius: 12, padding: 20, color: "#fff", boxShadow: "0 30px 80px rgba(0,0,0,0.7)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: "#fff", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? "#34D399" : "transparent"}`,
        color: active ? "#fff" : "rgba(255,255,255,0.55)",
        padding: "10px 14px",
        fontFamily: condensedFont,
        fontWeight: 800,
        fontSize: 12,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
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

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  color: "rgba(255,255,255,0.55)",
  fontFamily: monoFont,
  fontSize: 11,
  letterSpacing: "0.04em",
  textDecoration: "underline",
  cursor: "pointer",
};
