"use client";

import { apiErrorMessage } from "@/lib/api-error-message"
import { reconcileDeviceKeysForUser } from "@/lib/auth/device-keys";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import MobileNav from "@/components/MobileNav";
import SupportChatConnected from "@/components/SupportChatConnected";
import FirstRunTourMount from "@/components/onboarding/FirstRunTourMount";
import RpcLogo from "@/components/RpcLogo";
import SignOutButton from "@/components/auth/SignOutButton";
import { trophyComparator, TROPHY_SORTS, tierRank, type TrophySortKey } from "@/lib/trophy-comparator";
import { sumMoments, sumFmv, sumStaleFmv, sumStaleCount, countActiveCollections, groupWalletsByAddress } from "@/lib/dashboard/aggregate";
import { publishedCollections, getCollection, getPublishedCollection } from "@/lib/collections";
import { detectAddressChain, normalizeAddress } from "@/lib/address";
import {
  fmtUsd,
  truncateAddress,
  tierColor,
  tierHoloClass,
  collectionMetaByUuid,
  collectionMetaBySlug,
  timeAgo,
  formatCountdown,
} from "@/lib/dashboard-format";
import { tierColorAlpha } from "@/lib/tier-color";
import TrophyPickerModal from "@/components/profile/TrophyPickerModal";
import TrophyNoteEditor from "@/components/profile/TrophyNoteEditor";
import { occupantOfSlot, reorderByDelta, reorderByTarget } from "@/lib/trophy/reorder";
import ShareProfileButtons from "@/components/profile/ShareProfileButtons";
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
// Pure formatters/mappers extracted to @/lib/dashboard-format (measured by the
// coverage ratchet); imported below. Bodies are byte-identical.

// ── Component ─────────────────────────────────────────────────────────────────

export default function DashboardClient() {
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
  // ⚠ /dashboard is auth-gated by proxy.ts, so a reader who sees this page IS
  // signed in. `email` going null therefore has two very different causes, and
  // the render collapsed them: a genuinely absent session (possible — a session
  // can expire mid-visit) versus /api/profile/me failing. The second rendered
  // "Not signed in" at a collector who was, on the one page that proves it.
  const [meFailed, setMeFailed] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [resolvedDisplayName, setResolvedDisplayName] = useState<string | null>(null);
  const [bio, setBio] = useState<Bio | null>(null);
  // True once /api/profile/bio has answered OK. A null `bio` before that is
  // "unknown", not "no handle" — the claim-your-handle card below must not
  // render on a read that has not happened or failed.
  const [bioLoaded, setBioLoaded] = useState(false);
  const [wallets, setWallets] = useState<SavedWallet[]>([]);
  const [slabs, setSlabs] = useState<(TrophySlabData | null)[]>([null, null, null, null, null, null]);
  // Did the TROPHY-SLABS read itself fail this pass? Same reasoning as
  // `walletsFailed` below: an empty `slabs` is ambiguous — "has pinned none"
  // or "we could not read them" — and only the first justifies an onboarding
  // prompt. Without this, a failed read sends an owner with a full case to
  // EmptyHeroState, i.e. "pick a hero Moment", which is a false claim about
  // their own account AND tells them to redo finished work.
  const [slabsFailed, setSlabsFailed] = useState(false);
  // Same class again, one panel over. A failed `/api/profile/activity` read
  // leaves `activity` empty, and the empty state tells a collector to "Follow
  // other collectors" — the /my-teams "Follow a team to build your hub"
  // incident verbatim, on a signed-in surface, about their own account, and
  // ACTIONABLE: it sends someone who already follows people to go do it again.
  const [activityFailed, setActivityFailed] = useState(false);
  const [hero, setHero] = useState<HeroMoment | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [statsByWallet, setStatsByWallet] = useState<Record<string, CollectionStat[]>>({});
  // Addresses whose collection-stats fetch FAILED this pass. Load-bearing for
  // honesty: without it a failed fetch leaves statsByWallet[addr] unset, which
  // the sum helpers happily reduce to 0 — rendering a confident "$0 / 0 moments"
  // that a collector cannot distinguish from actually owning nothing. See the
  // 2026-08-05 incident (get_wallet_collection_stats crossed its statement
  // timeout -> 503 -> false $0 on a 19,213-moment wallet).
  const [statsFailed, setStatsFailed] = useState<string[]>([]);
  // Did the SAVED-WALLETS read itself fail this pass? Distinct from statsFailed,
  // which covers per-wallet holdings once the list is known — and load-bearing
  // for the same reason one step earlier.
  //
  // ⚠ A failed `/api/profile/saved-wallets` leaves `walletList` at [], and an
  // empty list is indistinguishable from "this collector has added no wallets".
  // That drove THREE false claims at once on the primary signed-in surface:
  // the hero rendered `SignInBanner` — the onboarding "add a wallet" prompt —
  // to someone who has already added one (a claim about the reader's OWN
  // account, and ACTIONABLE: it asks them to redo finished work), and because
  // `refreshStats([])` early-returns and CLEARS `statsFailed`, the tiles fell
  // through to a confident "0 moments / $0" with no incomplete notice — the
  // exact false-$0 the statsFailed comment above exists to prevent, reached by
  // an upstream route it does not cover.
  const [walletsFailed, setWalletsFailed] = useState(false);

  const [loading, setLoading] = useState(true);

  const [usernameInput, setUsernameInput] = useState("");
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const indexingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const indexingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Re-opens the "add a wallet" form for a user who ALREADY has one. Once a
  // wallet is saved the onboarding prompt collapses to a link — repeatedly
  // asking a collector for the Dapper username they already gave reads as the
  // product having forgotten them (Trevor, 2026-08-05).
  const [showAddWallet, setShowAddWallet] = useState(false);
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
        throw new Error(apiErrorMessage(data, res.status));
      }
      pushToast("Trophy removed", "info");
    } catch (err) {
      setSlabs(previous);
      pushToast(err instanceof Error ? err.message : "Failed to remove trophy", "info");
    }
  }, [slabs, pushToast]);

  // Reflect a saved caption into slab state. The editor has already persisted
  // it and only calls this on a 2xx, so this is a local sync, not an optimistic
  // write — there is nothing to roll back.
  //
  // ⚠ Matches on the slab's OWN `slot`, not on array position. Filled slabs
  // pack to the front of `slabs` while `slot` is the persisted DB column, so
  // after a reorder the two diverge and indexing by `slot - 1` would caption
  // the wrong Moment.
  const handleNoteSaved = useCallback((slot: number, note: string | null) => {
    setSlabs((prev) => prev.map((s) => (s && s.slot === slot ? { ...s, note } : s)));
  }, []);

  // Reorder the trophy case (Auto-Arrange + drag-to-reorder). `orderedIds` are
  // the currently-filled slab row ids in their desired slot order (index 0 ->
  // slot 1). Filled slabs pack to the front, so any empty cells collapse to the
  // trailing slots. Optimistic: reflow local state immediately, persist, and
  // roll back + toast on failure. Returns whether the save stuck (undo/redo
  // both call through here and rely on the boolean).
  const handleReorderTrophies = useCallback(
    async (orderedIds: number[]): Promise<boolean> => {
      const previous = slabs;
      const byId = new Map<number, TrophySlabData>();
      previous.forEach((s) => { if (s) byId.set(s.id, s); });
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((s): s is TrophySlabData => Boolean(s));
      const filledCount = previous.filter(Boolean).length;
      // Guard against a stale order set (must be exactly the filled slabs).
      if (reordered.length !== filledCount || reordered.length !== orderedIds.length) {
        return false;
      }
      const next: (TrophySlabData | null)[] = [null, null, null, null, null, null];
      reordered.forEach((s, i) => { next[i] = { ...s, slot: i + 1 }; });
      setSlabs(next);
      try {
        const res = await fetch("/api/profile/trophy/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderedIds }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(apiErrorMessage(data, res.status));
        }
        return true;
      } catch (err) {
        setSlabs(previous);
        pushToast(
          err instanceof Error ? err.message : "Couldn't save arrangement",
          "info"
        );
        return false;
      }
    },
    [slabs, pushToast]
  );

  const refreshStats = useCallback(async (addrs: string[]) => {
    if (addrs.length === 0) {
      setStatsByWallet({});
      setStatsFailed([]);
      return {};
    }
    const out: Record<string, CollectionStat[]> = {};
    const failed: string[] = [];
    await Promise.all(
      addrs.map(async (addr) => {
        try {
          const url =
            "/api/profile/collection-stats?wallet_addr=" + encodeURIComponent(addr);
          let res = await fetch(url, { cache: "no-store" });
          if (!res.ok) {
            // The stats RPC can transiently 503 under DB contention (whale
            // wallets). A silent skip here would zero the WHOLE portfolio tile
            // (false $0), so retry once with a small backoff before giving up.
            await new Promise((r) => setTimeout(r, 800));
            res = await fetch(url, { cache: "no-store" });
            if (!res.ok) {
              // Still failing -> record it. The tiles render "—" + a retry
              // rather than summing this wallet as a real zero.
              failed.push(addr);
              return;
            }
          }
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
          // Swallow per-wallet errors so the OTHER wallets still render — but
          // record the failure so the totals stay honest about being partial.
          failed.push(addr);
        }
      })
    );
    setStatsByWallet(out);
    setStatsFailed(failed);
    return out;
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
      setMeFailed(!meRes.ok);
      setEmail(me?.user?.email ?? null);
      setUserId(me?.user?.id ?? null);
      // Every sign-in path lands here; the branded token-hash link skips
      // /auth/confirm entirely (see lib/auth/device-keys.ts).
      reconcileDeviceKeysForUser(me?.user?.id ?? null);
      setResolvedDisplayName(me?.user?.display_name ?? null);

      if (bioRes.ok) {
        const b = await bioRes.json();
        setBio(b?.bio ?? null);
        setBioLoaded(true);
      }
      let walletList: SavedWallet[] = [];
      setWalletsFailed(!walletsRes.ok);
      if (walletsRes.ok) {
        const w = await walletsRes.json();
        walletList = w?.wallets ?? [];
        setWallets(walletList);
      }
      let slabList: TrophySlabData[] = [];
      setSlabsFailed(!slabsRes.ok);
      if (slabsRes.ok) {
        const t = await slabsRes.json();
        slabList = Array.isArray(t?.slabs) ? t.slabs : [];
        const next: (TrophySlabData | null)[] = [null, null, null, null, null, null];
        slabList.forEach((s) => {
          if (s.slot >= 1 && s.slot <= 6) next[s.slot - 1] = s;
        });
        setSlabs(next);
      }
      // Hero: only fetch when there are genuinely no trophies pinned.
      //
      // ⚠ `slabList` is empty in TWO cases — the owner has pinned nothing, and
      // the read failed — and this branch used to treat them alike. On a failed
      // read that meant an owner with a full case was shown the empty-state
      // "pick a hero Moment" onboarding card instead of their trophies, which
      // reads as "your trophy case is gone". Gate on the read having SUCCEEDED,
      // so an outage leaves the case as it was rather than replacing it with an
      // onboarding prompt.
      if (slabsRes.ok && slabList.length === 0) {
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
      setActivityFailed(!actRes.ok);
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
        // background indexer finishes each collection. Read the FRESHLY-returned
        // stats for the early-exit check — reading the `statsByWallet` state here
        // would be a stale closure captured when the interval was created (empty
        // for a just-added wallet), so the early exit never fired and the poll
        // always ran the full 60s safety timeout.
        const fresh = await refreshStats(uniqueAddrs);
        const allHaveStats = uniqueAddrs.every((a) => {
          const stats = fresh[a];
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
  }, [refresh, refreshStats, stopIndexingPoll]);

  // One field, chain-detected. RPC asks only for a public identifier — it never
  // connects or signs a wallet (Trevor, 2026-08-08). The shape decides the path:
  //   cadence (0x + 16 hex) → resolve-and-associate with { address }, which fans
  //                           the wallet out across all 5 published Flow surfaces
  //   solana (base58)       → a single Candy saved_wallets row + its own backfill
  //                           (Candy is a different chain; the Flow orchestrator
  //                           takes a Flow address and must NOT be handed this)
  //   anything else         → a Top Shot username, resolved via GQL
  const resolveAndAssociate = useCallback(async () => {
    const raw = usernameInput.trim();
    if (!raw) {
      setUsernameError("Wallet address or username required");
      return;
    }
    const chain = detectAddressChain(raw);
    const candy = getPublishedCollection("candy-mlb");

    setUsernameSaving(true);
    setUsernameError(null);
    try {
      if (chain === "solana") {
        if (!candy?.supabaseCollectionId) {
          throw new Error("That looks like a Solana address — Candy isn't available yet.");
        }
        // normalizeAddress, NOT toLowerCase: base58 is case-sensitive, so
        // lowercasing a Candy address stores it mangled and it matches no
        // wallet_moments_cache row.
        const address = normalizeAddress(raw);
        const saveRes = await fetch("/api/profile/saved-wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddr: address, collectionId: candy.supabaseCollectionId }),
        });
        const saveData = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok) throw new Error(saveData.error || `HTTP ${saveRes.status}`);
        pushToast(`Loaded Candy wallet ${truncateAddress(address)}`, "success");
        pushToast("Indexing your Candy collection — this usually takes 30-60 seconds", "info");
        setUsernameInput("");
        setShowAddWallet(false);
        setShowAdvanced(false);
        await refresh();
        startIndexingPoll();
        return;
      }

      const res = await fetch("/api/profile/resolve-and-associate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          chain === "cadence" ? { address: normalizeAddress(raw) } : { username: raw }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(apiErrorMessage(data, res.status));
      }
      const addr = data.walletAddress as string;
      const count = Array.isArray(data.associatedCollections) ? data.associatedCollections.length : 0;
      pushToast(`Loaded wallet ${truncateAddress(addr)} across ${count} collections`, "success");
      pushToast(
        `Indexing your moments across ${count} collections — this usually takes 30-60 seconds`,
        "info"
      );
      // The handle is now defaulted from the Dapper username server-side, which
      // is the moment a collector's public profile starts existing. Announce it
      // ONLY on the call that created it — `profileHandleClaimed` is false on
      // every re-resolve, so refreshing a collection doesn't re-announce a
      // profile the collector has had for weeks.
      if (data.profileHandleClaimed && typeof data.profileHandle === "string") {
        pushToast(`Your profile is live at /profile/${data.profileHandle}`, "success");
      }
      setUsernameInput("");
      // Collapse the add-wallet form — the user has now given us their wallet;
      // leaving the prompt open re-asks for something they just supplied.
      setShowAddWallet(false);
      setShowAdvanced(false);
      await refresh();
      startIndexingPoll();
    } catch (err: any) {
      setUsernameError(err.message || "Failed to resolve");
    } finally {
      setUsernameSaving(false);
    }
  }, [usernameInput, refresh, pushToast, startIndexingPoll]);

  const addWallet = useCallback(async () => {
    // normalizeAddress, NOT toLowerCase — base58 (Candy/Solana) is
    // case-sensitive and lowercasing it stores a mangled address that matches
    // no wallet_moments_cache row.
    const addr = normalizeAddress(walletForm.addr);
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
        throw new Error(apiErrorMessage(data, res.status));
      }
      setWalletForm({ addr: "", nickname: "", collectionId: "nba-top-shot" });
      pushToast(`Added ${truncateAddress(addr)}`, "success");
      // Same as resolveAndAssociate — collapse once the wallet is saved.
      setShowAddWallet(false);
      setShowAdvanced(false);
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

  // Pure aggregation extracted to @/lib/dashboard/aggregate (unit-tested there).
  const totalMoments = useMemo(() => sumMoments(statsByWallet), [statsByWallet]);
  const totalFmv = useMemo(() => sumFmv(statsByWallet), [statsByWallet]);
  // STALE-confidence FMV is excluded from the headline total (the price hasn't
  // refreshed recently and over/under-states the holding). Surface it as a
  // footnote so the number isn't silently lost.
  const staleFmv = useMemo(() => sumStaleFmv(statsByWallet), [statsByWallet]);
  const staleCount = useMemo(() => sumStaleCount(statsByWallet), [statsByWallet]);
  const collectionCount = useMemo(() => countActiveCollections(statsByWallet), [statsByWallet]);

  // At least one wallet's stats could not be loaded, so every headline figure is
  // a PARTIAL sum. An unavailable answer must render as unavailable — never as a
  // number the collector would read as "you own this much".
  // ⚠ `walletsFailed` counts too. When the saved-wallets read fails the list is
  // [], so `refreshStats([])` early-returns and CLEARS statsFailed — leaving
  // every headline figure at a confident 0 with nothing marking it unavailable.
  // The totals are just as unknowable there as when a per-wallet stats call
  // fails; the failure simply happened one route earlier.
  const statsIncomplete = statsFailed.length > 0 || walletsFailed;
  const retryStats = useCallback(() => {
    // ⚠ When the WALLETS read is what failed, `wallets` is empty, so retrying
    // stats alone would call refreshStats([]) — which early-returns and changes
    // nothing. A Retry button that cannot fix the state it is offered for is its
    // own dishonesty, so re-run the whole refresh to re-fetch the list first.
    if (walletsFailed) {
      refresh().catch(() => {});
      return;
    }
    const uniqueAddrs = Array.from(new Set(wallets.map((w) => w.wallet_addr.toLowerCase())));
    refreshStats(uniqueAddrs);
  }, [wallets, refreshStats, walletsFailed, refresh]);

  // Group saved_wallets by physical wallet address — one card per unique
  // wallet, with sub-cards from collection-stats inside.
  const groupedWallets = useMemo(() => groupWalletsByAddress(wallets), [wallets]);
  // The hero's own add-wallet form (SignInBanner) renders exactly when the
  // wallets read succeeded and returned nothing — the same condition the hero
  // branch below uses, so the two cannot drift.
  const heroFormShown = !walletsFailed && wallets.length === 0;

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
                {/* Three states, not two: an address, a read we could not make,
                    and a genuinely absent session. Only the last may say so. */}
                {email ?? (meFailed ? "Account details unavailable" : "Not signed in")}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {/* The first-run tour's last step points at "sniper-nav-link", which
                only existed on collection pages — on the dashboard, where the
                tour runs, the step was centred over nothing (2026-09-02 QA). */}
            <Link
              href="/nba-top-shot/sniper"
              data-tour-anchor="sniper-nav-link"
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
              Sniper
            </Link>
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

        {/* ── Your public profile ──
            A collector who arrived by Top Shot username has one (the handle
            defaults from that name); one who pasted a 0x address does NOT, and
            gets the claim card instead. Until this card none of them could tell: the only
            mention was a toast that fires once, on the call that created it.
            A profile nobody knows the URL of is a profile nobody shares — which
            made every improvement to the page and its social card unreachable
            for the people they were built for. */}
        {bio?.username ? (
          <PublicProfileCard username={bio.username} userId={userId} />
        ) : bioLoaded && wallets.length > 0 ? (
          <ClaimHandleCard />
        ) : null}

        {/* ── Hero: onboarding CTA / HeroMoment / Trophy Case ── */}
        {/* ⚠ `walletsFailed` FIRST. An empty `wallets` is ambiguous — it means
            either "has added none" or "we could not read the list" — and only
            the first of those justifies an onboarding prompt. Asking a collector
            who already added a wallet to add one is a false claim about their
            own account that also tells them to redo finished work. */}
        {walletsFailed ? (
          <div
            role="status"
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              background: "var(--rpc-surface)", border: "1px solid var(--rpc-warning)",
              borderRadius: 10, padding: "14px 16px",
            }}
          >
            <span style={{ fontSize: 12, fontFamily: monoFont, color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
              Couldn&apos;t load your saved wallets. This is a loading problem, not an
              empty account — nothing has been removed.
            </span>
            <button type="button" onClick={() => { refresh().catch(() => {}); }} style={{ ...secondaryBtnStyle, flexShrink: 0 }}>
              Retry
            </button>
          </div>
        ) : heroFormShown ? (
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
          <TrophyCaseSection slabs={slabs} onPickSlot={setPinSlot} onRemove={handleRemoveTrophy} onReorder={handleReorderTrophies} onNoteSaved={handleNoteSaved} />
        ) : slabsFailed ? (
          /* ⚠ THIRD STATE. `filledSlabs.length === 0` is reached BOTH by "has
             pinned nothing" and by "the read failed", and only the first may
             show onboarding. The refresh() comment above already gates the HERO
             fetch on `slabsRes.ok` for this exact reason — but the fallback
             still landed here, so the panel was only half fixed. On first load
             (slabs still [null x6]) a failed read showed a collector with six
             pinned trophies the "pick a hero Moment" prompt. */
          <div
            role="status"
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              background: "var(--rpc-surface)", border: "1px solid var(--rpc-warning)",
              borderRadius: 10, padding: "14px 16px",
            }}
          >
            <span style={{ fontSize: 12, fontFamily: monoFont, color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
              Couldn&apos;t load your trophy case. This is a loading problem, not an
              empty case — nothing has been unpinned.
            </span>
            <button type="button" onClick={() => { refresh().catch(() => {}); }} style={{ ...secondaryBtnStyle, flexShrink: 0 }}>
              Retry
            </button>
          </div>
        ) : (
          <EmptyHeroState wallets={wallets} indexing={indexing} onPickSlot={setPinSlot} />
        )}

        {/* ── Stats Tiles ── */}
        <section data-tour-anchor="portfolio-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
          <StatTile
            label="Total Moments"
            value={totalMoments.toLocaleString()}
            color="var(--rpc-text-primary)"
            unavailable={statsIncomplete}
          />
          <StatTile
            label="Portfolio FMV"
            value={fmtUsd(totalFmv)}
            color="var(--rpc-success)"
            caption={staleCount > 0 ? `+ ${fmtUsd(staleFmv)} across ${staleCount.toLocaleString()} stale-priced moments` : undefined}
            unavailable={statsIncomplete}
          />
          <StatTile
            label="Collections"
            value={String(collectionCount)}
            color="#A855F7"
            unavailable={statsIncomplete}
          />
        </section>

        {statsIncomplete ? (
          <div
            role="status"
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              background: "var(--rpc-surface)", border: "1px solid var(--rpc-warning)",
              borderRadius: 10, padding: "10px 14px",
            }}
          >
            <span style={{ fontSize: 11, fontFamily: monoFont, color: "var(--rpc-text-secondary)", lineHeight: 1.4 }}>
              {/* ⚠ Two different failures land here and they are not the same
                  sentence. statsFailed = "we know your wallets, N of them
                  wouldn't load" (a PARTIAL sum). walletsFailed = "we couldn't
                  read the wallet list at all", where statsFailed is 0 and the
                  older copy would have said "holdings for 0 wallets". */}
              {statsFailed.length > 0 ? (
                <>
                  Couldn&apos;t load holdings for {statsFailed.length}{" "}
                  {statsFailed.length === 1 ? "wallet" : "wallets"}. These totals are incomplete —
                  this is a loading problem, not an empty collection.
                </>
              ) : (
                <>
                  {/* ⚠ Deliberately does NOT repeat the hero notice's opening
                      sentence. Both regions fail together on this path, and two
                      panels leading with the same words reads as a broken page
                      rather than one explained state. */}
                  Totals are unavailable until your saved wallets load — this is a
                  loading problem, not an empty collection.
                </>
              )}
            </span>
            <button type="button" onClick={retryStats} style={{ ...secondaryBtnStyle, flexShrink: 0 }}>
              Retry
            </button>
          </div>
        ) : null}

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
          <TrophyCaseSection slabs={slabs} onPickSlot={setPinSlot} onRemove={handleRemoveTrophy} onReorder={handleReorderTrophies} onNoteSaved={handleNoteSaved} />
        )}

        {/* ── Saved Wallets ── */}
        <section className="rpc-section" data-tour-anchor="saved-wallets-card">
          <div className="rpc-section-title">Saved Wallets</div>

          {/* Once a wallet is saved, collapse the whole onboarding form to a
              single link. Gate on groupedWallets (one entry per PHYSICAL wallet),
              NOT wallets — saved_wallets holds one row per (wallet, collection),
              so one Dapper wallet is 5 rows in `wallets` but 1 here. */}
          {groupedWallets.length > 0 && !showAddWallet ? (
            <div style={{ marginBottom: 14 }}>
              <button onClick={() => setShowAddWallet(true)} style={linkBtnStyle}>
                + Add another wallet
              </button>
            </div>
          ) : null}

          {/* First visit: the hero above already carries the add-wallet form
              (SignInBanner), and this section used to render a SECOND copy of
              it — two "Load my collection" buttons on one screen, reading
              different input state (2026-09-02 onboarding QA #9). Point at the
              hero instead; the form here is one click away for the advanced
              path. */}
          {heroFormShown && !showAddWallet ? (
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 8, lineHeight: 1.5 }}>
              Use the form above to load your first wallet, or{" "}
              <button onClick={() => setShowAddWallet(true)} style={linkBtnStyle}>
                add one here
              </button>
              .
            </div>
          ) : null}

          {(groupedWallets.length === 0 && !heroFormShown) || showAddWallet ? (
          <>
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
            <div style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 11, marginBottom: 10 }}>
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
              {walletError && <div style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 11, marginTop: 8 }}>{walletError}</div>}
            </div>
          )}

          {groupedWallets.length > 0 ? (
            <div style={{ marginBottom: 14 }}>
              <button
                onClick={() => { setShowAddWallet(false); setShowAdvanced(false); setUsernameError(null); }}
                style={linkBtnStyle}
              >
                Cancel
              </button>
            </div>
          ) : null}
          </>
          ) : null}

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
          {activityFailed ? (
            <div role="status" style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
              Couldn&apos;t load friend activity. This is a loading problem, not an
              empty feed — nobody has been unfollowed.
            </div>
          ) : activity.length === 0 ? (
            <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
              Follow other collectors to see their sales here.
              <br />
              Open a collector&rsquo;s profile at <span style={{ color: "var(--rpc-text-secondary)" }}>/profile/&lt;username&gt;</span> and hit{" "}
              <span style={{ color: "var(--rpc-text-secondary)" }}>+ FOLLOW</span>.
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
                    <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "var(--rpc-success)" }}>
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
          pinnedMomentIds={slabs.filter(Boolean).map((sl) => (sl as TrophySlabData).moment_id)}
          // Resolved by the slab's OWN `slot`, never by array position — see
          // occupantOfSlot for why the index form names the wrong trophy.
          replacingName={occupantOfSlot(slabs, pinSlot)?.player_name ?? null}
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
                background: t.tone === "success" ? "rgba(52,211,153,0.10)" : "var(--rpc-surface)",
                border: `1px solid ${t.tone === "success" ? "#34D39966" : "#4F94D466"}`,
                color: t.tone === "success" ? "var(--rpc-success)" : "#4F94D4",
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
//
// Identifier entry ONLY. RPC never asks anyone to connect or sign a wallet
// (Trevor, 2026-08-08) — Dapper Wallet sign-in requires Dapper developer
// approval we do not have, and everything RPC reads is public on-chain data.
// We collect a public identifier and read it view-only.
//
// One field, chain-detected. The Panini/Candy hints render only when their
// collection is PUBLISHED, so an unpublished surface is never advertised.

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
  const paniniLive = !!getPublishedCollection("panini-blockchain");
  const candyLive = !!getPublishedCollection("candy-mlb");

  const accepted = [
    "your Dapper wallet address (0x…)",
    "your Top Shot username",
    paniniLive ? "your Panini username" : null,
    candyLive ? "your Candy wallet address" : null,
  ].filter(Boolean) as string[];

  const placeholder = candyLive
    ? "0x… address, or username"
    : "0x… Dapper address, or Top Shot username";

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
        Track Your Collection
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.5, marginBottom: 16, maxWidth: 620 }}>
        Paste {accepted.slice(0, -1).join(", ")}
        {accepted.length > 1 ? ", or " : ""}
        {accepted[accepted.length - 1]}. RPC reads public blockchain data only —
        we never ask you to connect or sign a wallet.
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <input
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onUsernameSubmit(); }}
          placeholder={placeholder}
          // NOT cosmetic: mobile Safari auto-capitalises the first letter, which
          // corrupts a case-sensitive base58 Candy address and a mixed-case
          // Panini username.
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Wallet address or username"
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
          {saving ? "Loading…" : "Load my collection"}
        </button>
      </div>

      {error && (
        <div style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}

      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5, maxWidth: 620 }}>
        Read-only and unverified — this loads any public collection, including
        one that isn&apos;t yours. To mark a wallet as <em>yours</em>, use the
        verify step once it&apos;s loaded.
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
        <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, color: "var(--rpc-success)", marginTop: 8 }}>
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
    border: `1px solid ${tierColorAlpha(tc, 40)}`,
    flexShrink: 0,
  };
  if (!imageUrl || failed) {
    return (
      <div
        style={{
          ...commonStyle,
          background: `radial-gradient(circle at 30% 30%, ${tierColorAlpha(tc, 33)}, ${tierColorAlpha(tc, 7)} 70%, var(--rpc-surface) 100%)`,
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

// Cross-collection rarity ranking for the Auto-Arrange "Rarity" sort. Highest
// first. Covers every tier in the tier_type enum across all 5 collections;
// unknown/null tiers rank lowest. (Top Shot: COMMON<FANDOM<RARE<LEGENDARY<
// ULTIMATE; UFC: CONTENDER<CHALLENGER<FANDOM.)
// TROPHY_TIER_RANK / tierRank / TrophySortKey / TROPHY_SORTS / trophyComparator
// extracted to @/lib/trophy-comparator (imported below). NOTE: "Acquisition date"
// sort is intentionally omitted — trophy slab data carries no acquisition
// timestamp (only pinned_at = when added to the case), so it can't be honored
// without a new RPC field.

function TrophyCaseSection({
  slabs,
  onPickSlot,
  onRemove,
  onReorder,
  onNoteSaved,
}: {
  slabs: (TrophySlabData | null)[];
  onPickSlot: (slot: number) => void;
  onRemove?: (slot: number) => void;
  /** Reflect a saved caption into slab state so it renders without a refetch. */
  onNoteSaved?: (slot: number, note: string | null) => void;
  // Persist a new order. `orderedIds` = filled slab row ids in desired slot
  // order (index 0 -> slot 1). Resolves to whether the save stuck.
  onReorder?: (orderedIds: number[]) => Promise<boolean>;
}) {
  const filled = useMemo(
    () => slabs.filter((s): s is TrophySlabData => Boolean(s)),
    [slabs]
  );
  const filledCount = filled.length;
  const canArrange = !!onReorder && filledCount >= 2;

  const [sortKey, setSortKey] = useState<TrophySortKey>("rarity");
  const [busy, setBusy] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  // Undo bar state: the id order to restore, plus a label of what was applied.
  const [undo, setUndo] = useState<{ order: number[]; label: string } | null>(null);

  // Auto-dismiss the undo bar after 5s.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 5000);
    return () => clearTimeout(t);
  }, [undo]);

  // Escape exits edit mode (spec: "Exits on Done or pressing Escape").
  useEffect(() => {
    if (!editMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode]);

  const runArrange = useCallback(async () => {
    if (!onReorder || filled.length < 2 || busy) return;
    const prevOrder = filled.map((s) => s.id);
    const newOrder = [...filled].sort(trophyComparator(sortKey)).map((s) => s.id);
    if (newOrder.every((id, i) => id === prevOrder[i])) {
      // Already in this order — surface a transient "no change" via the bar.
      setUndo(null);
      return;
    }
    setBusy(true);
    const ok = await onReorder(newOrder);
    setBusy(false);
    if (ok) {
      const label = TROPHY_SORTS.find((s) => s.key === sortKey)?.label ?? "";
      setUndo({ order: prevOrder, label });
    }
  }, [onReorder, filled, sortKey, busy]);

  const doUndo = useCallback(async () => {
    if (!onReorder || !undo || busy) return;
    setBusy(true);
    await onReorder(undo.order);
    setBusy(false);
    setUndo(null);
  }, [onReorder, undo, busy]);

  /**
   * Move a slab one position left/right.
   *
   * ⚠ This is not a convenience — it is the ONLY reorder available on a phone
   * or from a keyboard. `Edit Layout` is `display: none` under 768px, and HTML5
   * `draggable` does not fire on touch at all, so mobile owners could not
   * reorder their trophy case by any means; a keyboard user could not either,
   * on any viewport. Auto-Arrange was the whole story for both.
   */
  const moveBy = useCallback(
    async (id: number, delta: -1 | 1) => {
      if (!onReorder || busy) return;
      const next = reorderByDelta(filled.map((s) => s.id), id, delta);
      if (!next) return;
      setBusy(true);
      await onReorder(next);
      setBusy(false);
    },
    [onReorder, filled, busy]
  );

  const handleDrop = useCallback(
    async (targetId: number) => {
      if (!onReorder || dragId === null || dragId === targetId) {
        setDragId(null);
        setOverId(null);
        return;
      }
      const next = reorderByTarget(filled.map((s) => s.id), dragId, targetId);
      setDragId(null);
      setOverId(null);
      if (!next) return;
      await onReorder(next);
    },
    [onReorder, dragId, filled]
  );

  const btnBase: React.CSSProperties = {
    fontFamily: condensedFont,
    fontWeight: 700,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    borderRadius: 8,
    padding: "6px 12px",
    cursor: busy ? "wait" : "pointer",
    background: "transparent",
    border: "1px solid var(--rpc-border)",
    color: "var(--rpc-text-primary)",
    whiteSpace: "nowrap",
  };

  // In edit mode we render only the filled slabs (draggable, compacted to the
  // front) followed by inert empty cells — dragging reorders among the filled
  // set and persists, collapsing any gaps. Outside edit mode the grid is the
  // normal fixed 6-slot layout.
  const gridCells = editMode
    ? filled.map((s) => ({ kind: "drag" as const, slab: s }))
    : [0, 1, 2, 3, 4, 5].map((i) => ({ kind: "fixed" as const, slab: slabs[i], slot: i + 1 }));
  const trailingEmpty = editMode ? Math.max(0, 6 - filled.length) : 0;

  return (
    <section className="rpc-section" data-tour-anchor="trophy-case">
      <style>{`
        @media (max-width: 768px) {
          .rpc-trophy-slab-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          /* Edit Layout stays visible on mobile: it now exposes the
             move-left/right controls, which are the only reorder a touch
             device has (HTML5 drag never fires on touch). */
        }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <div className="rpc-section-title" style={{ marginBottom: 0 }}>Trophy Case</div>
        <div style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.15em" }}>
          {filledCount} / 6
        </div>
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 12, letterSpacing: "0.02em", lineHeight: 1.5 }}>
        Pin your 6 best moments across any collection — your permanent flex.
      </div>

      {/* Arrange toolbar — only meaningful with 2+ pinned moments. */}
      {canArrange && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {!editMode && (
            <>
              <label style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
                Sort
              </label>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as TrophySortKey)}
                disabled={busy}
                aria-label="Auto-arrange sort order"
                style={{
                  fontFamily: monoFont,
                  fontSize: 11,
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: "var(--rpc-surface)",
                  border: "1px solid var(--rpc-border)",
                  color: "var(--rpc-text-primary)",
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {TROPHY_SORTS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={runArrange}
                disabled={busy}
                style={{ ...btnBase, borderColor: `${ACCENT_RED}66`, color: ACCENT_RED }}
              >
                {busy ? "Arranging…" : "Auto-Arrange"}
              </button>
            </>
          )}
          <button
            type="button"
            className="rpc-trophy-editlayout"
            onClick={() => { setEditMode((v) => !v); setUndo(null); }}
            disabled={busy}
            style={{
              ...btnBase,
              ...(editMode ? { borderColor: "var(--rpc-success)", color: "var(--rpc-success)" } : null),
            }}
          >
            {editMode ? "Done" : "Edit Layout"}
          </button>
          {editMode && (
            <span style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
              Drag moments to reorder · Esc to finish
            </span>
          )}
        </div>
      )}

      {/* Undo bar — dismissible, auto-clears after 5s. */}
      {undo && !editMode && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
            padding: "8px 12px",
            borderRadius: 8,
            background: "var(--rpc-surface)",
            border: "1px solid var(--rpc-border)",
          }}
        >
          <span style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Arranged by {undo.label}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={doUndo}
              disabled={busy}
              style={{ ...btnBase, padding: "4px 12px", borderColor: `${ACCENT_RED}66`, color: ACCENT_RED }}
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => setUndo(null)}
              aria-label="Dismiss"
              style={{ ...btnBase, padding: "4px 10px", color: "var(--rpc-text-muted)" }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="rpc-trophy-slab-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
        {gridCells.map((cell, i) => {
          if (cell.kind === "drag") {
            const s = cell.slab;
            return (
              <div
                key={"slab-drag-" + s.id}
                draggable
                onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(s.id)); }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overId !== s.id) setOverId(s.id); }}
                onDragLeave={() => { if (overId === s.id) setOverId(null); }}
                onDrop={(e) => { e.preventDefault(); handleDrop(s.id); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                style={{
                  cursor: "grab",
                  opacity: dragId === s.id ? 0.4 : 1,
                  outline: overId === s.id && dragId !== s.id ? `2px dashed ${ACCENT_RED}` : "none",
                  outlineOffset: 2,
                  borderRadius: 10,
                  transition: "opacity 120ms ease",
                }}
              >
                <TrophySlab slab={s} slot={i + 1} mode="owner" />
                <div style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "center" }}>
                  <button
                    type="button"
                    onClick={() => moveBy(s.id, -1)}
                    disabled={busy || i === 0}
                    aria-label={`Move ${s.player_name ?? "trophy"} left`}
                    style={{ ...btnBase, padding: "4px 10px", opacity: i === 0 ? 0.35 : 1 }}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => moveBy(s.id, 1)}
                    disabled={busy || i === filled.length - 1}
                    aria-label={`Move ${s.player_name ?? "trophy"} right`}
                    style={{
                      ...btnBase,
                      padding: "4px 10px",
                      opacity: i === filled.length - 1 ? 0.35 : 1,
                    }}
                  >
                    →
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div key={"slab-" + i} style={{ display: "flex", flexDirection: "column" }}>
              <TrophySlab
                slab={cell.slab}
                slot={cell.slot}
                mode="owner"
                onEmptyClick={onPickSlot}
                onRemove={onRemove}
              />
              {/* Caption editor sits OUTSIDE the slab because the slab's body
                  is one big <Link> to the moment page — an input nested in an
                  anchor navigates away as you type. Only for filled slots: a
                  caption needs a Moment to be about. Hidden in drag mode above,
                  where a text field would fight the drag handle. */}
              {cell.slab && (
                <TrophyNoteEditor
                  slot={cell.slot}
                  note={cell.slab.note}
                  onSaved={onNoteSaved}
                />
              )}
            </div>
          );
        })}
        {Array.from({ length: trailingEmpty }).map((_, k) => (
          <TrophySlab key={"slab-empty-" + k} slab={null} slot={filled.length + k + 1} mode="owner" />
        ))}
      </div>
    </section>
  );
}

// ── Your public profile ──────────────────────────────────────────────────────
//
// The collector's own shareable page, surfaced where they actually are. Their
// handle now defaults from their Dapper username, so the page exists for
// everyone — but until this card the only thing that ever mentioned it was a
// one-shot toast on the call that created it, and a profile whose URL nobody
// knows is a profile nobody shares.
//
// Reuses ShareProfileButtons rather than growing a second share path: that
// component already carries the UTM tagging, the referral `&ref=`, and the
// once-a-day +50 Status award, none of which a hand-rolled copy button here
// would have.

function PublicProfileCard({
  username,
  userId,
}: {
  username: string;
  userId: string | null;
}) {
  const href = `/profile/${encodeURIComponent(username)}`;
  return (
    <section
      className="rpc-section"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 12,
        border: `1px solid ${ACCENT_RED}44`,
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 9,
            letterSpacing: "0.18em",
            color: "var(--rpc-text-muted)",
            textTransform: "uppercase",
          }}
        >
          Your public profile
        </div>
        <Link
          href={href}
          style={{
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.03em",
            color: "var(--rpc-text-primary)",
            textDecoration: "none",
            display: "inline-block",
            marginTop: 3,
            wordBreak: "break-all",
          }}
        >
          rippackscity.com{href}
        </Link>
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 10,
            color: "var(--rpc-text-muted)",
            marginTop: 4,
          }}
        >
          Your trophy case, badges and portfolio — anyone can open this.{" "}
          <Link href="/profile/edit" style={{ color: "var(--rpc-text-secondary)" }}>
            Personalise it
          </Link>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Link
          href={href}
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
            whiteSpace: "nowrap",
          }}
        >
          View
        </Link>
        <ShareProfileButtons username={username} referrerId={userId} compact />
      </div>
    </section>
  );
}

// ── Claim your handle ────────────────────────────────────────────────────────
//
// The comment above PublicProfileCard says every collector has a handle. That
// is only true on the USERNAME path: a collector who pastes a 0x address (the
// path the resolver's own outage copy steers people to) never gives us a Top
// Shot name to derive one from, so `profile_bio.username` stays null, the
// card above never renders, and the trophy case they just built has no URL —
// not even for them. Measured in the 2026-09-02 onboarding walkthrough: the
// dashboard offered no route to /profile/edit beyond a header button whose
// label never mentions a URL. We deliberately do NOT auto-derive a handle from
// the email local-part: claim-username.ts's rules (never suffix, never hand
// someone a consolation name) apply here too — the collector picks it.

function ClaimHandleCard() {
  return (
    <section
      className="rpc-section"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 12,
        border: `1px solid ${ACCENT_RED}44`,
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 9,
            letterSpacing: "0.18em",
            color: "var(--rpc-text-muted)",
            textTransform: "uppercase",
          }}
        >
          Your public profile
        </div>
        <div
          style={{
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.03em",
            color: "var(--rpc-text-primary)",
            marginTop: 3,
          }}
        >
          Claim your handle to get a shareable URL
        </div>
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 10,
            color: "var(--rpc-text-muted)",
            marginTop: 4,
          }}
        >
          rippackscity.com/profile/<span style={{ color: "var(--rpc-text-secondary)" }}>your-name</span> — your
          trophy case and portfolio, ready to post on X or Discord.
        </div>
      </div>
      <Link
        href="/profile/edit"
        className="rpc-btn-primary"
        style={{
          fontFamily: condensedFont,
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          textDecoration: "none",
          padding: "8px 14px",
          borderRadius: 5,
          whiteSpace: "nowrap",
        }}
      >
        Claim handle →
      </Link>
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
                background: "rgba(52,211,153,0.12)",
                border: "1px solid #34D39966",
                color: "var(--rpc-success)",
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
                color: "var(--rpc-warning)",
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
                border: "1px solid var(--rpc-border)",
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
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: fmv > 0 ? "var(--rpc-success)" : "var(--rpc-text-ghost)" }}>{fmv > 0 ? fmtUsd(fmv) : "—"}</div>
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = "/api/profile/top-moments?limit=24" + (ownerKey ? `&ownerKey=${encodeURIComponent(ownerKey)}` : "");
    setLoadFailed(false);
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        // ⚠ A non-2xx and a thrown fetch both arrive with no moments. Rendering
        // that as the empty state tells a collector "No owned moments found." —
        // a claim about THEIR OWN COLLECTION manufactured from our outage. An
        // empty list is only true when we actually got an answer.
        if (!d?.moments) { setLoadFailed(true); setMoments([]); return; }
        setMoments(d.moments as TopMoment[]);
      })
      .catch(() => { if (!cancelled) { setLoadFailed(true); setMoments([]); } });
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
        throw new Error(apiErrorMessage(data, res.status));
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
      ) : loadFailed ? (
        <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-secondary)", padding: 16, textAlign: "center" }}>
          Couldn&apos;t load your moments. This says nothing about what you own — only that the
          read failed. Close and reopen to try again.
        </div>
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
      {pickError && <div style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 11, marginTop: 8 }}>{pickError}</div>}
      <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
        <button onClick={clear} disabled={saving} style={{ ...linkBtnStyle, color: "var(--rpc-warning)" }}>
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
          <div style={{ position: "absolute", top: 6, right: 6, fontSize: 12, color: "var(--rpc-warning)", textShadow: "0 0 4px rgba(0,0,0,0.8)" }} aria-label="Locked">🔒</div>
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
          <span style={{ fontSize: 12, color: "var(--rpc-success)" }}>{m.fmv_usd != null ? fmtUsd(Number(m.fmv_usd)) : "—"}</span>
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
  // The "verify with a linked wallet" FCL account-proof path was REMOVED
  // 2026-08-08 (Trevor): read-only framing or not, it popped a wallet-connect
  // dialog, and Dapper Wallet sign-in needs Dapper developer approval RPC does
  // not have — so it never once succeeded (zero fcl_* rows in
  // saved_wallets.verification_method, 1 nonce ever minted and 0 consumed).
  // The listing challenge below is now the only self-serve verification.

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
      // ⚠ No `res.ok` check here previously. On a non-2xx the envelope still
      // parses, `d.ok` is undefined so the success branch is skipped, and the
      // hint below rendered in a position that reads as a VERIFICATION RESULT —
      // telling a collector their listing was not found when we never managed to
      // look. This is the only self-serve verification path and it awards
      // credits, so "we could not check" and "we checked and found nothing" must
      // not share a message.
      if (!res.ok) {
        setCheckHint("Couldn't check just now — this says nothing about your listing. Try again shortly.");
        return;
      }
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
        <div style={{ marginBottom: 12, fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.14em", textTransform: "uppercase", textAlign: "center" }}>
          — list one of your Moments —
        </div>
      )}

      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
        {/* ⚠ NO CREDITS PROMISE. This said "earning +500 credits", which is the
            unshipped rewards programme used as the incentive to complete a flow
            — and the shop those credits buy from is a hard 404. The award still
            happens server-side (resolve_wallet_challenge_match); it just is not
            dangled. Verification is the reason to do this, and it is a real one. */}
        We picked one of your cheap Moments. List it on Top Shot at the exact price below, then click <strong>I&apos;ve listed it — Done</strong>. We confirm the live listing and verify you instantly. The price is ~100× the Moment&apos;s value (and at least $10), so nobody will buy it — you can delist right after.
      </div>

      {loading && !challenge && !unavailable && (
        <div style={{ textAlign: "center", padding: 24 }}><span className="rpc-spinner" /></div>
      )}

      {unavailable && (
        <div style={{ marginTop: 16, padding: 14, background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, fontFamily: monoFont, fontSize: 12, color: "#FBBF24", lineHeight: 1.6 }}>
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
          <div style={{ fontFamily: condensedFont, fontWeight: 900, fontSize: 38, color: "var(--rpc-success)", lineHeight: 1 }}>
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
              <span style={{ fontFamily: monoFont, fontSize: 11, color: expiresMs <= 0 ? "var(--rpc-danger)" : "var(--rpc-text-secondary)" }}>
                {`Expires in ${formatCountdown(expiresMs)}`}
              </span>
            </div>
          )}

          {done && (
            <div style={{ marginTop: 12, color: "var(--rpc-success)", fontFamily: monoFont, fontSize: 12 }}>
              ✓ Wallet verified. You can delist the Moment now.
            </div>
          )}
          {checkHint && !done && (
            <div style={{ marginTop: 10, color: "#FBBF24", fontFamily: monoFont, fontSize: 11, lineHeight: 1.5 }}>
              {checkHint}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 11, marginTop: 10 }}>{error}</div>}
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
        borderBottom: `2px solid ${active ? "var(--rpc-success)" : "transparent"}`,
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

// `unavailable` renders an em-dash instead of the computed value. Use it whenever
// the underlying read FAILED, so a partial/unknown total can never masquerade as a
// real 0 / $0 — the collector must be able to tell "we couldn't load this" apart
// from "you own nothing".
function StatTile({ label, value, color, caption, unavailable }: { label: string; value: string; color: string; caption?: string; unavailable?: boolean }) {
  return (
    <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: condensedFont, fontWeight: 800, color: unavailable ? "var(--rpc-text-muted)" : color, lineHeight: 1 }}>{unavailable ? "—" : value}</div>
      {unavailable ? (
        <div style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-ghost)", letterSpacing: "0.04em", marginTop: 5, lineHeight: 1.3 }}>Couldn&apos;t load</div>
      ) : caption ? (
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
  border: "1px solid var(--rpc-border)",
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
