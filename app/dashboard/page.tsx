"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import FirstRunTourMount from "@/components/onboarding/FirstRunTourMount";
import RpcLogo from "@/components/RpcLogo";
import SignOutButton from "@/components/auth/SignOutButton";
import SignInWithDapper from "@/components/SignInWithDapper";
import * as fcl from "@onflow/fcl";
import { configureFclAuth } from "@/lib/fcl-config";
import { publishedCollections, getCollection } from "@/lib/collections";
import { isSolanaAddress } from "@/lib/address";
import TrophyPickerModal from "@/components/profile/TrophyPickerModal";
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab";
import { proxyIpfsUrl } from "@/lib/ipfs-media";

const condensedFont = "var(--font-display)";
const monoFont = "var(--font-mono)";
const ACCENT_RED = "#E03A2F"; // brand-exception: concatenated with alpha suffixes (`${ACCENT_RED}66`/`88`) in CSS borders — must stay a literal hex

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

// Trophy slab shape comes from the get_trophy_slab_data RPC via
// /api/profile/trophy-slabs?mine=1. See components/TrophySlab.tsx.
type Trophy = TrophySlabData;

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

interface CollectionStat {
  collection_id: string;
  collection_slug: string;
  collection_label: string;
  moment_count: number;
  fmv_total: number;
  fmv_stale_total: number;
  stale_count: number;
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
  target_moment_id?: string | null;
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
  // Solana (base58) addresses have no 0x prefix and must not get one glued on —
  // doing so corrupts the displayed address for a Candy/Solana wallet.
  const clean = addr.startsWith("0x") || isSolanaAddress(addr) ? addr : "0x" + addr;
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
  const [resolvedDisplayName, setResolvedDisplayName] = useState<string | null>(null);
  const [bio, setBio] = useState<Bio | null>(null);
  const [wallets, setWallets] = useState<SavedWallet[]>([]);
  const [slabs, setSlabs] = useState<(TrophySlabData | null)[]>([null, null, null, null, null, null]);
  const [hero, setHero] = useState<HeroMoment | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
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
  // Deep-link: /dashboard?verify=<addr|1> opens the verify-by-listing modal
  // (the /rewards "Verify wallet" CTA routes here). Handle once per mount.
  const verifyParamHandled = useRef(false);
  // iOS WebKit surfaces transient network aborts as "TypeError: Load failed";
  // the dashboard refresh() had no catch, so on Mobile Safari that rejection
  // went unhandled (Sentry NEXTJS-1M/1K). This guards a single retry.
  const refreshRetried = useRef(false);

  const pushToast = useCallback((text: string, tone: "success" | "info" = "success") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  // Open the verify-by-listing modal when arriving via /dashboard?verify=...
  // (the /rewards CTA). The value may be a specific 0x wallet, or "1" to mean
  // "pick the first wallet that still needs verifying".
  useEffect(() => {
    if (verifyParamHandled.current) return;
    const param = search.get("verify");
    if (!param || wallets.length === 0) return;
    verifyParamHandled.current = true;
    const want = param.trim().toLowerCase();
    let target: string | null = null;
    if (want.startsWith("0x")) {
      target = wallets.find((w) => w.wallet_addr.toLowerCase() === want)?.wallet_addr ?? null;
    }
    if (!target) {
      target =
        wallets.find((w) => !w.verified_at)?.wallet_addr ??
        wallets[0]?.wallet_addr ??
        null;
    }
    if (target) setVerifyWallet(target);
  }, [search, wallets]);

  // Phase 7 — DELETE /api/profile/trophy unpins a slot. Optimistically removes
  // the row from local state so the slot flips back to "empty" immediately,
  // then surfaces a toast on success/failure. Failure rolls the row back.
  const handleRemoveTrophy = useCallback(async (slot: number) => {
    const previous = slabs;
    setSlabs((prev) => {
      const next = prev.slice();
      if (slot >= 1 && slot <= 6) next[slot - 1] = null;
      return next;
    });
    try {
      const res = await fetch("/api/profile/trophy", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      pushToast("Trophy removed", "info");
    } catch (err) {
      setSlabs(previous);
      pushToast(err instanceof Error ? err.message : "Failed to remove trophy", "info");
    }
  }, [slabs, pushToast]);

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
            fmv_stale_total: Number(r.fmv_stale_total) || 0,
            stale_count: Number(r.stale_count) || 0,
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
      const [meRes, bioRes, walletsRes, slabsRes, favRes, actRes] = await Promise.all([
        fetch("/api/profile/me", { cache: "no-store" }),
        fetch("/api/profile/bio", { cache: "no-store" }),
        fetch("/api/profile/saved-wallets", { cache: "no-store" }),
        fetch("/api/profile/trophy-slabs?mine=1", { cache: "no-store" }),
        fetch("/api/profile/favorites", { cache: "no-store" }),
        fetch("/api/profile/activity", { cache: "no-store" }),
      ]);
      const me = meRes.ok ? await meRes.json() : { user: null };
      setEmail(me?.user?.email ?? null);
      setUserId(me?.user?.id ?? null);
      setResolvedDisplayName(me?.user?.display_name ?? null);

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
      let slabList: TrophySlabData[] = [];
      if (slabsRes.ok) {
        const t = await slabsRes.json();
        slabList = Array.isArray(t?.slabs) ? t.slabs : [];
        const next: (TrophySlabData | null)[] = [null, null, null, null, null, null];
        slabList.forEach((s) => {
          if (s.slot >= 1 && s.slot <= 6) next[s.slot - 1] = s;
        });
        setSlabs(next);
      }
      // Hero: only fetch when there are no trophies pinned. The card is gated
      // by slabList.length === 0 below, so skipping the round-trip is safe.
      if (slabList.length === 0) {
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

      // Per-wallet collection stats (one fetch per unique wallet_addr).
      const uniqueAddrs = Array.from(new Set(walletList.map((w) => w.wallet_addr.toLowerCase())));
      refreshStats(uniqueAddrs);
      refreshRetried.current = false; // clean load resets the retry guard
    } catch (e) {
      // A network-level fetch rejection (iOS "TypeError: Load failed", flaky
      // mobile connection) lands here instead of going unhandled. Retry once
      // after a short delay, then degrade to a friendly toast rather than a
      // blank/broken dashboard.
      if (!refreshRetried.current) {
        refreshRetried.current = true;
        setTimeout(() => {
          refresh().catch(() => {});
        }, 1500);
        return;
      }
      console.warn(
        "[dashboard] refresh failed after retry:",
        e instanceof Error ? e.message : String(e)
      );
      pushToast("Couldn't load your dashboard — check your connection and refresh.", "info");
    } finally {
      setLoading(false);
    }
  }, [refreshStats, pushToast]);

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
  // STALE-confidence FMV is excluded from the headline total (the price hasn't
  // refreshed recently and over/under-states the holding). Surface it as a
  // footnote so the number isn't silently lost.
  const staleFmv = useMemo(
    () =>
      Object.values(statsByWallet)
        .flat()
        .reduce((s, r) => s + (r.fmv_stale_total ?? 0), 0),
    [statsByWallet]
  );
  const staleCount = useMemo(
    () =>
      Object.values(statsByWallet)
        .flat()
        .reduce((s, r) => s + (r.stale_count ?? 0), 0),
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
      <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <RpcLogo size={56} />
      </div>
    );
  }

  const filledSlabs = slabs.filter((s): s is TrophySlabData => !!s);
  const showHero = filledSlabs.length === 0 && hero !== null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", paddingBottom: 80 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .rpc-section { background:var(--rpc-surface); border:1px solid var(--rpc-border); border-radius:10px; padding:16px 18px; }
        .rpc-section-title { font-family:${condensedFont}; font-weight:800; font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:var(--rpc-text-secondary); margin-bottom:12px; }
        .rpc-wallet-card { transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease; }
        .rpc-wallet-subcard { transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease; cursor: pointer; text-decoration: none; color: inherit; }
        .rpc-wallet-subcard:hover { border-color: var(--rpc-accent, #555); transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.55); }
        .rpc-spinner { width: 12px; height: 12px; border: 2px solid var(--rpc-border); border-top-color: var(--rpc-text-primary); border-radius: 50%; display: inline-block; animation: rpc-spin 900ms linear infinite; }
        .rpc-spinner-sm { width: 9px; height: 9px; border: 1.5px solid var(--rpc-border); border-top-color: var(--rpc-text-primary); border-radius: 50%; display: inline-block; animation: rpc-spin 900ms linear infinite; }
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
                {/* Server-side resolver chain: user_profiles → profile_bio → allow_list.username
                    → email-local → short wallet. Profanity-guarded.
                    See lib/user/resolveDisplayName.ts. */}
                {resolvedDisplayName ?? bio?.display_name ?? (email?.split("@")[0] ?? "Profile")}
              </div>
              <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.04em", marginTop: 2 }}>
                {email ?? "Not signed in"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Link
              href="/dashboard/packs"
              style={{
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--rpc-text-secondary)",
                textDecoration: "none",
                padding: "7px 12px",
                border: `1px solid ${ACCENT_RED}66`,
                borderRadius: 5,
              }}
            >
              Pack History
            </Link>
            <Link
              href="/dashboard/history"
              style={{
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--rpc-text-secondary)",
                textDecoration: "none",
                padding: "7px 12px",
                border: `1px solid ${ACCENT_RED}66`,
                borderRadius: 5,
              }}
            >
              History
            </Link>
            <Link
              href="/alerts"
              style={{
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--rpc-text-secondary)",
                textDecoration: "none",
                padding: "7px 12px",
                border: `1px solid ${ACCENT_RED}66`,
                borderRadius: 5,
              }}
            >
              Alerts
            </Link>
            <Link
              href="/profile/edit"
              style={{
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--rpc-text-secondary)",
                textDecoration: "none",
                padding: "7px 12px",
                border: `1px solid ${ACCENT_RED}66`,
                borderRadius: 5,
              }}
            >
              Edit profile
            </Link>
            <SignOutButton />
          </div>
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
        ) : filledSlabs.length > 0 ? (
          <TrophyCaseSection slabs={slabs} onPickSlot={setPinSlot} onRemove={handleRemoveTrophy} />
        ) : (
          <EmptyHeroState wallets={wallets} indexing={indexing} onPickSlot={setPinSlot} />
        )}

        {/* ── Stats Tiles ── */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
          <StatTile label="Total Moments" value={totalMoments.toLocaleString()} color="var(--rpc-text-primary)" />
          <StatTile
            label="Portfolio FMV"
            value={fmtUsd(totalFmv)}
            color="#34D399"
            caption={staleCount > 0 ? `+ ${fmtUsd(staleFmv)} across ${staleCount.toLocaleString()} stale-priced moments` : undefined}
          />
          <StatTile label="Collections" value={String(collectionCount)} color="#A855F7" />
        </section>

        {/* ── Alerts front door ── the omni-channel alerts hub (/alerts) has no
            other prominent entry point, so surface it here for signed-in users. */}
        <Link
          href="/alerts"
          className="rpc-section"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            textDecoration: "none",
            border: `1px solid ${ACCENT_RED}66`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden>🔔</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
                Set up alerts
              </div>
              <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2, lineHeight: 1.5 }}>
                Get pinged on email, Telegram, or Discord when a moment drops below FMV.
              </div>
            </div>
          </div>
          <span
            style={{
              fontFamily: condensedFont,
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: ACCENT_RED,
              whiteSpace: "nowrap",
            }}
          >
            Create alert →
          </span>
        </Link>

        {/* Trophy Case is the hero slot when trophies exist; render it again
            below the stats only when the hero card occupied the top slot, so
            users still get the 6-grid pin UI without scrolling past it. */}
        {wallets.length > 0 && showHero && (
          <TrophyCaseSection slabs={slabs} onPickSlot={setPinSlot} onRemove={handleRemoveTrophy} />
        )}

        {/* ── Saved Wallets ── */}
        <section className="rpc-section" data-tour-anchor="saved-wallets-card">
          <div className="rpc-section-title">Saved Wallets</div>

          <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 8, lineHeight: 1.5 }}>
            Add a wallet by entering your Dapper username — we'll associate it with NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, and UFC Strike automatically.
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") resolveAndAssociate(); }}
              placeholder="Dapper username"
              style={{ flex: 1, minWidth: 220, padding: "10px 12px", background: "var(--rpc-surface)", border: `1px solid ${ACCENT_RED}66`, borderRadius: 6, color: "var(--rpc-text-primary)", fontFamily: monoFont, fontSize: 13 }}
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
            <div style={{ marginBottom: 14, padding: 12, background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-secondary)" }}>
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
                  style={{ padding: "8px 10px", background: "var(--rpc-black)", border: "1px solid var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-primary)", fontFamily: monoFont, fontSize: 12 }}
                >
                  {publishedCollections().map((c) => (
                    <option key={c.id} value={c.id}>{c.icon} {c.shortLabel}</option>
                  ))}
                </select>
                <input
                  value={walletForm.addr}
                  onChange={(e) => setWalletForm({ ...walletForm, addr: e.target.value })}
                  placeholder="0x… wallet address"
                  style={{ flex: 1, minWidth: 220, padding: "8px 10px", background: "var(--rpc-black)", border: "1px solid var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-primary)", fontFamily: monoFont, fontSize: 12 }}
                />
                <input
                  value={walletForm.nickname}
                  onChange={(e) => setWalletForm({ ...walletForm, nickname: e.target.value })}
                  placeholder="Nickname (optional)"
                  style={{ width: 180, padding: "8px 10px", background: "var(--rpc-black)", border: "1px solid var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-primary)", fontFamily: condensedFont, fontSize: 12 }}
                />
                <button onClick={addWallet} disabled={walletSaving} style={primaryBtnStyle}>
                  {walletSaving ? "Saving…" : "+ Add"}
                </button>
              </div>
              {walletError && <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11, marginTop: 8 }}>{walletError}</div>}
            </div>
          )}

          {groupedWallets.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)", padding: "12px 0" }}>
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
                    background: isFav ? `${c.accent}22` : "var(--rpc-surface)",
                    border: `1px solid ${isFav ? c.accent : "var(--rpc-border)"}`,
                    color: isFav ? c.accent : "var(--rpc-text-secondary)",
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

        </section>

        {/* ── Friend Activity ── */}
        <section className="rpc-section">
          <div className="rpc-section-title">Friend Activity</div>
          {activity.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>
              Follow other collectors to see their sales here.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activity.map((a, i) => {
                const cMeta = collectionMetaByUuid(a.collection_id);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 6 }}>
                    {a.thumbnail_url && <img src={proxyIpfsUrl(a.thumbnail_url) ?? undefined} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.followee_username ?? "someone"} {a.role === "seller" ? "sold" : "bought"} {a.player_name ?? "a moment"}{a.serial_number ? ` #${a.serial_number}` : ""}
                      </div>
                      <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", display: "flex", gap: 8, marginTop: 2 }}>
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

      </main>

      {/* ── Modals ── */}
      {pinSlot != null && (
        <TrophyPickerModal
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
      <FirstRunTourMount />
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
          color: "var(--rpc-text-primary)",
          marginBottom: 10,
        }}
      >
        Get Started
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.5, marginBottom: 16, maxWidth: 620 }}>
        Sign in with your Dapper wallet for verified ownership across NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle.
      </div>

      <div style={{ marginBottom: 18 }}>
        <SignInWithDapper variant="primary" />
      </div>

      <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 10 }}>
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
            background: "var(--rpc-surface)",
            border: `1.5px solid ${ACCENT_RED}88`,
            borderRadius: 8,
            color: "var(--rpc-text-primary)",
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

      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5, maxWidth: 620 }}>
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
      style={{ position: "relative", background: "var(--rpc-surface)", border: `2px solid ${tc}`, borderRadius: 14, padding: 14, overflow: "hidden", display: "flex", gap: 16, alignItems: "center", maxHeight: 200 }}
    >
      <HeroMomentImage imageUrl={hero.imageUrl} playerName={hero.playerName} tier={hero.tier} tc={tc} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: monoFont, fontSize: 10, color: tc, letterSpacing: "0.14em", textTransform: "uppercase" }}>Hero Moment</span>
          {hero.isManualOverride && (
            <span style={{ fontFamily: monoFont, fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" }}>· pinned</span>
          )}
          <button
            onClick={onEdit}
            className="rpc-edit-pencil"
            aria-label="Edit hero moment"
            title="Edit hero moment"
            style={{ background: "transparent", border: "none", color: "var(--rpc-text-secondary)", cursor: "pointer", padding: 0, fontSize: 13 }}
          >
            ✎
          </button>
        </div>
        <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 26, letterSpacing: "0.02em", marginTop: 2, lineHeight: 1.1 }}>
          {hero.playerName ?? "Unknown"}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 4 }}>
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
          background: `radial-gradient(circle at 30% 30%, ${tc}55, ${tc}11 70%, var(--rpc-surface) 100%)`,
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
  return <img src={proxyIpfsUrl(imageUrl) ?? undefined} alt={playerName ?? ""} onError={() => setFailed(true)} style={commonStyle} />;
}

function EmptyHeroState({ wallets, indexing, onPickSlot }: { wallets: SavedWallet[]; indexing: boolean; onPickSlot: (slot: number) => void }) {
  const isIndexing = indexing && wallets.length > 0;
  return (
    <section className="rpc-section rpc-binder-slot" style={{ padding: "28px 20px", textAlign: "center" }}>
      <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-secondary)", display: "inline-flex", alignItems: "center", gap: 10 }}>
        {isIndexing && <span className="rpc-spinner" aria-hidden />}
        {isIndexing ? "Indexing your collection" : "Pin a moment to your trophy case"}
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 6, letterSpacing: "0.04em" }}>
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

function TrophyCaseSection({
  slabs,
  onPickSlot,
  onRemove,
}: {
  slabs: (TrophySlabData | null)[];
  onPickSlot: (slot: number) => void;
  onRemove?: (slot: number) => void;
}) {
  const filledCount = slabs.filter(Boolean).length;
  return (
    <section className="rpc-section">
      <style>{`
        @media (max-width: 768px) {
          .rpc-trophy-slab-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div className="rpc-section-title" style={{ marginBottom: 0 }}>Trophy Case</div>
        <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.15em" }}>
          {filledCount} / 6
        </div>
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 12, letterSpacing: "0.02em", lineHeight: 1.5 }}>
        Pin your 6 best moments across any collection — your permanent flex.
      </div>
      <div className="rpc-trophy-slab-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <TrophySlab
            key={"slab-" + i}
            slab={slabs[i]}
            slot={i + 1}
            mode="owner"
            onEmptyClick={onPickSlot}
            onRemove={onRemove}
          />
        ))}
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
      style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, padding: "12px 14px" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, letterSpacing: "0.02em", color: "var(--rpc-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
          style={{ background: "transparent", border: "none", color: "var(--rpc-text-muted)", fontSize: 13, cursor: "pointer" }}
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
                background: "var(--rpc-black)",
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
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 6, marginTop: 6 }}>
                <div>
                  <div style={{ fontFamily: monoFont, fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Moments</div>
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "var(--rpc-text-primary)" }}>{moments.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontFamily: monoFont, fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" }}>FMV</div>
                  {/* No priced editions (e.g. thin-market UFC) -> em dash, not a misleading "$0". */}
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: fmv > 0 ? "#34D399" : "var(--rpc-text-ghost)" }}>{fmv > 0 ? fmtUsd(fmv) : "—"}</div>
                </div>
              </div>
              {(fmvMax > 0 || locked > 0) && (
                <div style={{ display: "flex", gap: 8, marginTop: 4, fontFamily: monoFont, fontSize: 9, color: "var(--rpc-text-muted)" }}>
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
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)", marginBottom: 10 }}>
        Pick the moment you want featured in your Hero card. Clear to fall back to your top-FMV moment automatically.
      </div>
      {moments == null ? (
        <div style={{ textAlign: "center", padding: 24 }}><span className="rpc-spinner" /></div>
      ) : moments.length === 0 ? (
        <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-secondary)", padding: 16, textAlign: "center" }}>
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
        background: "var(--rpc-surface)",
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
      <div style={{ position: "relative", aspectRatio: "1/1", background: "var(--rpc-surface)" }}>
        {m.image_url ? (
          <img src={proxyIpfsUrl(m.image_url) ?? undefined} alt={m.player_name ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: tc, fontSize: 32, fontFamily: condensedFont, fontWeight: 900 }}>●</div>
        )}
        {m.is_locked && (
          <div style={{ position: "absolute", top: 6, right: 6, fontSize: 12, color: "#F59E0B", textShadow: "0 0 4px rgba(0,0,0,0.8)" }} aria-label="Locked">🔒</div>
        )}
      </div>
      <div style={{ padding: "6px 8px" }}>
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 12, color: "var(--rpc-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {m.player_name ?? m.moment_id}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 9, color: "var(--rpc-text-secondary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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

// ── Verify by Listing ──────────────────────────────────────────────────────

interface VerifyTarget {
  moment_id: string;
  edition_key: string | null;
  serial_number: number | null;
  player_name: string | null;
  set_name: string | null;
  image_url: string | null;
  fmv_usd: number | null;
  list_url: string;
}

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
  const [target, setTarget] = useState<VerifyTarget | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [checkHint, setCheckHint] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  // Read-only HybridCustody path: connect any account-linked Flow wallet via FCL
  // account-proof (no tx signed) and verify THIS wallet when it's on-chain-linked
  // to the signed address. Falls through to the listing challenge if not linked.
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkHint, setLinkHint] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const verifyViaLink = useCallback(async () => {
    setLinkLoading(true);
    setLinkError(null);
    setLinkHint(null);
    try {
      configureFclAuth();
      const u: any = await fcl.authenticate();
      const addr: string | undefined = u?.addr;
      // Dapper-custodied wallets (Top Shot accounts) return no address from FCL
      // here — guide the user to the listing method instead of a raw error
      // (known-issue 0).
      if (!addr)
        throw new Error(
          "This wallet looks Dapper-custodied — Dapper wallets can't connect here yet. Use the listing method below instead."
        );
      const proofService = (u.services ?? []).find(
        (s: any) => s?.type === "account-proof" || s?.f_type === "AccountProofService"
      );
      const data = proofService?.data;
      if (!data?.signatures || !data?.nonce) {
        throw new Error("No account proof returned by wallet");
      }
      const res = await fetch("/api/profile/verify-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet_addr: walletAddr,
          accountProof: { address: addr, nonce: data.nonce, signatures: data.signatures },
        }),
      });
      const d = await res.json();
      if (res.ok && d?.ok) {
        setVerified(true);
        onVerified();
        return;
      }
      if (res.status === 403 && d?.error === "not_linked") {
        // Not account-linked — point them at the listing challenge below.
        setLinkHint(d?.hint ?? "That wallet isn't linked to the one you signed with — list a Moment below instead.");
      } else {
        setLinkError(d?.hint ?? d?.error ?? `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setLinkError(e?.message ?? "Sign-in failed");
      try { await fcl.unauthenticate(); } catch { /* ignore */ }
    } finally {
      setLinkLoading(false);
    }
  }, [walletAddr, onVerified]);

  // Load the active challenge; if none, mint a fresh one (which picks the
  // target Moment server-side). A challenge with no target_moment_id is legacy
  // and not actionable — mint fresh instead.
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
          if (d?.challenge && d.challenge.target_moment_id && !d.challenge.resolved_at && !d.challenge.expired) {
            setChallenge(d.challenge);
            setTarget(d.target ?? null);
            return;
          }
        }
        // No actionable challenge — mint one (picks the target).
        const minted = await fetch("/api/profile/verify-challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet_addr: walletAddr }),
        });
        const md = await minted.json();
        if (cancelled) return;
        if (md?.unavailable) {
          setUnavailable(md?.message ?? "Verification by listing isn't available for this wallet.");
          return;
        }
        if (!minted.ok) throw new Error(md?.error ?? `HTTP ${minted.status}`);
        setChallenge(md.challenge);
        setTarget(md.target ?? null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to start verification");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddr]);

  // Live check: confirm the target Moment is listed at exactly the challenge
  // amount via Top Shot's API. On a match the server resolves the challenge,
  // flips the wallet to verified, and awards +500 credits.
  const checkNow = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCheckHint(null);
    try {
      const res = await fetch("/api/profile/verify-challenge/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet_addr: walletAddr,
          // Referral stash from RefCapture. The server validates the shape and
          // the DB function owns the guards (first-verification-only, no
          // self-referral, referrer must exist), so sending it is safe.
          ref:
            (typeof window !== "undefined" && localStorage.getItem("rpc_ref")) ||
            undefined,
        }),
      });
      const d = await res.json();
      if (d?.ok && d?.matched) {
        setVerified(true);
        // Verified = the referral (if any) is now credited server-side. Clear
        // the stash so it can't be reused on a later verify.
        try {
          localStorage.removeItem("rpc_ref");
        } catch {
          // ignore
        }
        setChallenge((prev) =>
          prev
            ? { ...prev, resolved_at: new Date().toISOString(), resolved_via: "gql_on_demand", matched_moment_id: d.moment ?? null }
            : prev
        );
        onVerified();
        return;
      }
      setCheckHint(d?.hint ?? d?.error ?? "No matching listing found yet.");
    } catch (e: any) {
      setError(e?.message ?? "Check failed");
    } finally {
      setLoading(false);
    }
  }, [walletAddr, onVerified]);

  const expiresMs = challenge ? new Date(challenge.expires_at).getTime() - now : 0;
  const priceLabel = challenge ? `$${Number(challenge.challenge_amount).toFixed(2)}` : "";
  const done = verified || !!challenge?.resolved_at;

  return (
    <ModalShell onClose={onClose} title={`Verify ${truncateAddress(walletAddr)}`}>
      {!done && (
        <div style={{ padding: 14, background: "var(--rpc-surface)", border: "1px solid #1f3a34", borderRadius: 10, marginBottom: 16 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Fastest: verify with a linked wallet
          </div>
          <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.6, marginTop: 6 }}>
            Connect any Flow wallet that&apos;s account-linked to this one. <strong>Read-only — we never ask you to sign a transaction.</strong> Earns <strong>+500 credits</strong>.
          </div>
          <button onClick={verifyViaLink} disabled={linkLoading} style={{ ...primaryBtnStyle, marginTop: 10 }}>
            {linkLoading ? "Connecting…" : "Verify via linked wallet (read-only)"}
          </button>
          {linkHint && (
            <div style={{ marginTop: 8, color: "#FBBF24", fontFamily: monoFont, fontSize: 11, lineHeight: 1.5 }}>
              {linkHint} ↓
            </div>
          )}
          {linkError && (
            <div style={{ marginTop: 8, color: "#F87171", fontFamily: monoFont, fontSize: 11 }}>{linkError}</div>
          )}
        </div>
      )}

      {!done && (
        <div style={{ marginBottom: 12, fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.14em", textTransform: "uppercase", textAlign: "center" }}>
          — or list one of your Moments —
        </div>
      )}

      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
        We picked one of your cheap Moments. List it on Top Shot at the exact price below, then click <strong>I&apos;ve listed it — Done</strong>. We confirm the live listing and verify you instantly — earning <strong>+500 credits</strong>. The price is ~100× the Moment&apos;s value (and at least $10), so nobody will buy it — you can delist right after.
      </div>

      {loading && !challenge && !unavailable && (
        <div style={{ textAlign: "center", padding: 24 }}><span className="rpc-spinner" /></div>
      )}

      {unavailable && (
        <div style={{ marginTop: 16, padding: 14, background: "var(--rpc-surface)", border: "1px solid #3a2a2a", borderRadius: 10, fontFamily: monoFont, fontSize: 12, color: "#FBBF24", lineHeight: 1.6 }}>
          {unavailable}
        </div>
      )}

      {challenge && !unavailable && (
        <div style={{ marginTop: 16, padding: 14, background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10 }}>
          {/* Target Moment card */}
          {target && (
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
              {target.image_url && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={proxyIpfsUrl(target.image_url) ?? undefined}
                  alt={target.player_name ?? "Moment"}
                  width={56}
                  height={56}
                  style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover", background: "var(--rpc-surface-raised)", flexShrink: 0 }}
                />
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 15, color: "var(--rpc-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {target.player_name ?? `Moment ${target.moment_id}`}
                </div>
                <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)" }}>
                  {target.set_name ?? "Top Shot"}{target.serial_number ? ` · #${target.serial_number}` : ""}
                </div>
              </div>
            </div>
          )}

          <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>
            List this Moment for exactly
          </div>
          <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 38, color: "#34D399", lineHeight: 1 }}>
            {priceLabel}
          </div>

          {!done && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {target?.list_url && (
                <a href={target.list_url} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtnStyle, textDecoration: "none", display: "inline-block" }}>
                  Open on Top Shot ↗
                </a>
              )}
              <button onClick={checkNow} disabled={loading} style={secondaryBtnStyle}>
                {loading ? "Checking…" : "I've listed it — Done"}
              </button>
              <span style={{ fontFamily: monoFont, fontSize: 11, color: expiresMs <= 0 ? "#F87171" : "var(--rpc-text-secondary)" }}>
                {`Expires in ${formatCountdown(expiresMs)}`}
              </span>
            </div>
          )}

          {done && (
            <div style={{ marginTop: 12, color: "#34D399", fontFamily: monoFont, fontSize: 12 }}>
              ✓ Wallet verified — +500 credits earned. You can delist the Moment now.
            </div>
          )}
          {checkHint && !done && (
            <div style={{ marginTop: 10, color: "#FBBF24", fontFamily: monoFont, fontSize: 11, lineHeight: 1.5 }}>
              {checkHint}
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
        style={{ width: "100%", maxWidth: 720, maxHeight: "90vh", overflow: "auto", background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 12, padding: 20, color: "var(--rpc-text-primary)", boxShadow: "0 30px 80px rgba(0,0,0,0.7)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: "var(--rpc-text-primary)", fontSize: 18, cursor: "pointer" }}>✕</button>
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
        color: active ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
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

function StatTile({ label, value, color, caption }: { label: string; value: string; color: string; caption?: string }) {
  return (
    <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: condensedFont, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      {caption ? (
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.04em", marginTop: 5, lineHeight: 1.3 }}>{caption}</div>
      ) : null}
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  background: ACCENT_RED,
  border: "none",
  color: "var(--rpc-text-primary)",
  padding: "8px 18px",
  borderRadius: 6,
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3f3f46",
  color: "var(--rpc-text-primary)",
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
  color: "var(--rpc-text-muted)",
  fontFamily: monoFont,
  fontSize: 11,
  letterSpacing: "0.04em",
  textDecoration: "underline",
  cursor: "pointer",
};
