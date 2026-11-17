"use client";

// components/profile/TrophyPickerModal.tsx
//
// Pin-to-slot picker for the profile trophy case. Replaces the older
// 2-column thumbnail grid with a single-column vertical list optimised for
// mobile readability (especially Pinnacle / Cosmics where thumbnails barely
// differ between editions).
//
// Each row: 56×56 thumbnail · player/character name (bold) · set + tier chip
// + serial · FMV + badge icons. Row height ~72px so taps land cleanly.
//
// Tabs: "Pick from collection" (the list) and "Enter ID manually" (raw moment
// ID lookup, used for gifted moments outside saved wallets).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalA11y } from "@/lib/hooks/useModalA11y";
import LeagueFilter, { type LeagueValue } from "@/components/filters/LeagueFilter";
import SerialFmvBadge, { type SerialFmvData } from "@/components/SerialFmvBadge";
import SerialBadge from "@/components/collection/SerialBadge";
import { publishedCollections } from "@/lib/collections";
import { track } from "@/lib/telemetry/track";
import { getFunnelContext } from "@/lib/track-funnel";
import { describeSlots, fillTargets, togglePick } from "@/lib/trophy/fill-slots";
import { PANINI_LINK_HREF } from "@/components/profile/ChallengeProgressNudge";
import { seriesLabel, isUnmappedSeriesLabel } from "@/lib/analytics/series-labels";
import {
  type TrophySortKey,
  type TrophyTierFilter,
  normalizeTier,
  tierColor,
  fmtUsd,
  displayName,
  presentTiers,
  filterSortMoments,
  emptyPoolCopy,
  paniniEmptyPoolCopy,
} from "@/lib/trophy-picker-format";
import { NEUTRAL_TIER_COLOR, tierColorAlpha } from "@/lib/tier-color";
import { proxyIpfsImageUrl } from "@/lib/ipfs-media";
import { fetchJson } from "@/lib/analytics/fetch-json";

/** Body of `/api/profile/top-moments` as the picker reads it. */
type TopMomentsPage = {
  moments?: unknown[];
  hasMore?: boolean;
  paniniUsernamesLinked?: number;
};

const condensedFont = "var(--font-display)";
const monoFont = "var(--font-mono)";
const RED_FILL = "var(--rpc-red-fill)"; // under white label text (AA, 2026-11-07)

// Chains whose holdings are in wallet_moments_cache, the trophy pool.
const TROPHY_INDEXED_CHAINS = new Set<string>(["flow", "solana"]);

// Collections the pool reads by a LINKED USERNAME rather than a wallet
// (get_user_top_owned_moments' Panini branch over saved_collector_identities,
// 2026-09-28). Panini's dbChain is null, so the chain rule above cannot see it.
const TROPHY_USERNAME_COLLECTIONS = new Set<string>(["panini-blockchain"]);

// Top Shot collection UUID — used to gate the NBA/WNBA league badge so it only
// renders on Top Shot rows. Other collections store NULL in wmc.league.
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

type CollectionFilter = "all" | string; // "all" or collection slug ("nba-top-shot", etc.)

// Mirrors the TopMoment shape from /api/profile/top-moments. Sourced from
// wallet_moments_cache via the get_user_top_owned_moments RPC.
export interface PickerMoment {
  moment_id: string;
  collection_id: string;
  collection_slug: string;
  /** null for a Panini card: its owner is a USERNAME, not an address. */
  wallet_address: string | null;
  player_name: string | null;
  set_name: string | null;
  team_name?: string | null;
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
  badges?: string[] | null;
  metadata?: Record<string, unknown> | null;
  league?: string | null;
  jersey_number?: number | null;
  serial_fmv?: SerialFmvData;
}

/**
 * How many owned Moments the grid loads PER PAGE, highest FMV first.
 *
 * History: this used to be the whole search scope — the box filtered
 * client-side over the loaded rows, so a Moment outside the top N read as "No
 * moments match", a claim about THEIR COLLECTION made from our page cap. Now a
 * typed query (≥ 2 chars) is searched server-side over the whole wallet, every
 * word in any field (2026-11-06/08), and "Load more" pages past the cap with
 * `?offset` (2026-11-08) — 3 of 15 Dame Extra Spice holders had theirs behind
 * the first 96 Dames. It is still the API's per-request ceiling
 * (`/api/profile/top-moments` clamps above it).
 */
export const PICKER_LIMIT = 96;

/**
 * A challenge case pre-fills its player ("Damian Lillard" for Dame Time) and the
 * picker then loads EVERY page of that player, up to this many rows, without a
 * click (2026-11-08). Highest-value-first paging hid the cheap set pieces a
 * challenge is often about: 3 of 15 Dame Extra Spice holders had theirs behind
 * their first 96 Dames. Measured 11-08: 37 collectors hold a Dame, the most is
 * 390 (5 pages; the whole list reads in ~0.3 s warm). Past this the "Load more"
 * button carries on by hand.
 */
export const CHALLENGE_AUTOLOAD_MAX = 480;

/** The server-side search term a typed query produces: trimmed, ≥ 2 chars, else "". */
export function serverQueryFor(query: string): string {
  const q = query.trim();
  return q.length >= 2 ? q : "";
}

// Local aliases keep the in-file usages terse while the definitions live in
// lib/trophy-picker-format.ts (measured by the coverage ratchet).
type SortKey = TrophySortKey;
type TierFilter = TrophyTierFilter;

interface Props {
  slot: number;
  ownerKey: string | null;
  onClose: () => void;
  onPinned: () => void;
  /**
   * Moment ids already in the case, so the grid can show which ones are taken.
   *
   * ⚠ Without this a collector could pin the SAME Moment into two slots and see
   * it twice in their own trophy case: the upsert conflicts on
   * `(user_id, slot)`, not `(user_id, moment_id)`, so nothing downstream
   * rejects it. Nothing in the UI said a Moment was already up, either — every
   * row looked equally pinnable.
   */
  pinnedMomentIds?: string[];
  /**
   * Display name of the Moment currently occupying THIS slot, if any.
   *
   * ⚠ Pinning is an OVERWRITE — the upsert conflicts on `(user_id, slot)` — and
   * there is no undo. Until the confirm step existed, a mis-tap on a 72px row
   * silently replaced a trophy the collector had chosen, and the only feedback
   * was a "Trophy pinned" toast that read as success. The confirm step names
   * whose slot is being taken.
   *
   * ⚠ The caller must resolve this by matching the slab's OWN `slot` column, NOT
   * by array position: filled slabs pack to the front of the dashboard's `slabs`
   * array while `slot` is the persisted value, so `slabs[slot - 1]` names the
   * WRONG Moment whenever the case has a gap.
   */
  replacingName?: string | null;
  /**
   * dbChains of the collector's saved wallets ("flow", "solana"), or null when
   * unknown (the wallet read failed / caller cannot tell). Drives the "you
   * haven't added a wallet on this chain" empty copy, which must never be
   * shown on a guess.
   */
  savedChains?: readonly string[] | null;
  /**
   * Which trophy case this pin goes into (2026-11-06). Absent/null = the main
   * case. For a challenge case the server checks the challenge's rules and
   * answers 4xx with a reason when the pick doesn't qualify — shown inline.
   */
  caseId?: string | null;
  /** Pre-fill the search box (e.g. "Damian Lillard" for the Dame Time case). */
  initialQuery?: string;
  /** Heading override, e.g. "Pin to Dame Time". */
  title?: string;
  /**
   * The case's EMPTY slots (2026-11-08, multi-pick). When the tapped `slot` is
   * one of them and there is more than one, the grid selects several Moments
   * at once and pins them into the empty slots in order — tapped slot first.
   * Absent, or a tapped slot that is occupied: the one-at-a-time flow, where
   * the confirm step names the trophy a replace displaces.
   */
  openSlots?: readonly number[] | null;
  /** The challenge this case belongs to — its SLUG goes on the pick events (a case id never leaves). */
  challengeSlug?: string | null;
  /**
   * MAIN-case picker only (2026-11-08 weekend review): a live challenge the owner
   * has not finished. 6 of 22 Dame Time entrants pinned all-Dame sets into the
   * main case instead (10–13 picker opens each). The picker now says which case
   * it is filling and offers the entry instead.
   */
  challengeOffer?: { title: string; onUse: () => void } | null;
}

export default function TrophyPickerModal({
  slot,
  ownerKey,
  onClose,
  onPinned,
  pinnedMomentIds,
  replacingName,
  savedChains,
  caseId = null,
  initialQuery = "",
  title,
  openSlots = null,
  challengeSlug = null,
  challengeOffer = null,
}: Props) {
  const [tab, setTab] = useState<"grid" | "manual">("grid");
  const [moments, setMoments] = useState<PickerMoment[] | null>(null);
  /**
   * ⚠ A THIRD state beside `null` (loading) and `[]` (you own none). Without it
   * a failed read is indistinguishable from an empty collection, and the empty
   * copy is both a claim about the reader's own holdings AND actionable — it
   * points them at the manual tab to type an id for a Moment we did not load.
   */
  const [momentsLoadFailed, setMomentsLoadFailed] = useState(false);
  /** Linked Panini usernames, read with a Panini-filtered list; null = unknown. */
  const [paniniLinked, setPaniniLinked] = useState<number | null>(null);
  // "Load more" (2026-11-08). The grid shows PICKER_LIMIT rows at a time, highest
  // value first; a collector with 300 Dames never saw a cheap one. `hasMore`
  // comes from the route (a FULL page back); `nextOffset` is the RAW offset of
  // the next page (the route's Panini opt-out can shorten a page, so it is not
  // moments.length). `loadGen` drops a page that lands after the filters moved.
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const loadGen = useRef(0);
  const [pickError, setPickError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The grid's confirm step. A row click SELECTS; only the confirm button pins.
  // The manual tab has always worked this way (look up → preview → Pin); the
  // grid pinned on the first tap, which on a phone is a 72px target in a dense
  // scrolling list, and the pin overwrites the slot with no undo.
  const [pending, setPending] = useState<PickerMoment | null>(null);

  // Multi-pick (2026-11-08). `targets` is fixed for the modal's life; `filled`
  // grows as pins land, so a partial failure leaves the remaining empty slots
  // (and the remaining picks) exactly where they were.
  const targets = useMemo(() => fillTargets(slot, openSlots), [slot, openSlots]);
  const multi = targets.length > 1;
  const [filled, setFilled] = useState<number[]>([]);
  const remaining = useMemo(() => targets.filter((s) => !filled.includes(s)), [targets, filled]);
  const [picked, setPicked] = useState<PickerMoment[]>([]);
  const [pinnedHere, setPinnedHere] = useState<string[]>([]);
  // Anything pinned in this session means the case behind the modal is stale:
  // closing then goes through onPinned (the parent refreshes), never bare onClose.
  const pinnedAny = useRef(false);
  const close = useCallback(() => {
    if (pinnedAny.current) onPinned();
    else onClose();
  }, [onPinned, onClose]);

  const [sort, setSort] = useState<SortKey>("fmv_desc");
  const [query, setQuery] = useState(initialQuery);
  // The SERVER-side search term (2026-11-06). The grid is the 96 highest-value
  // rows, and the free-text box used to search inside THAT slice only — Trevor,
  // holding 15,706 Moments, typed "Damian Lillard" and got the six Dames inside
  // his top 96 with a 10 px line admitting it. A typed name now goes to the
  // route as `q` (debounced 300 ms, ≥ 2 chars) so the RPC filters the WHOLE
  // wallet before its fmv cap. `serverQuery` is what the CURRENT list was
  // fetched with; while the debounce is pending the client filter below keeps
  // narrowing the previous list, so the grid never shows rows that do not match.
  const [serverQuery, setServerQuery] = useState(serverQueryFor(initialQuery));
  useEffect(() => {
    const next = serverQueryFor(query);
    if (next === serverQuery) return;
    const t = setTimeout(() => setServerQuery(next), 300);
    return () => clearTimeout(t);
  }, [query, serverQuery]);
  const [tierFilter, setTierFilter] = useState<TierFilter>("ALL");
  const [leagueFilter, setLeagueFilter] = useState<LeagueValue>("all");
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter>("all");

  // Manual entry tab
  const [manualId, setManualId] = useState("");
  const [manualPreview, setManualPreview] = useState<PickerMoment | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  const offered = !!challengeOffer;
  useEffect(() => {
    // 2026-11-08: which CASE. Juiceshack opened the picker 19 times on 11-07 —
    // the main case, then the Dame Time case, slot by slot — and the events could
    // not say which was which. `case` is "main" or "extra" (an id never leaves).
    track("trophy-modal-open", {
      slot,
      case: caseId ? "extra" : "main",
      challenge: initialQuery ? true : false,
      ...(challengeSlug ? { challenge_slug: challengeSlug } : {}),
      ...(offered ? { challenge_offered: true } : {}),
    });
  }, [slot, caseId, initialQuery, challengeSlug, offered]);

  // Escape-to-close + focus trap + focus restore. The modal is always "open"
  // while mounted (parent controls mount), so isOpen is a constant true.
  const contentRef = useModalA11y<HTMLDivElement>(true, close);

  // panini=1: the trophy case is the one picker that can pin a Panini card
  // (the route leaves them out for the hero/avatar pickers).
  const pageParams = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(PICKER_LIMIT), panini: "1" });
      if (ownerKey) params.set("ownerKey", ownerKey);
      if (leagueFilter !== "all") params.set("league", leagueFilter);
      if (collectionFilter !== "all") params.set("collection", collectionFilter);
      if (serverQuery) params.set("q", serverQuery);
      if (offset > 0) params.set("offset", String(offset));
      return params;
    },
    [ownerKey, leagueFilter, collectionFilter, serverQuery]
  );

  // 2026-11-10: on a CHALLENGE case, pull purchases made since the wallet's last
  // walk into the cache (verified on-chain) and reload the list if any landed —
  // spitehouse stopped Dame Time at 5 of 6 holding a sixth this list could not
  // show. Once per open; a failed sync keeps the list as it is.
  const [syncGen, setSyncGen] = useState(0);
  const syncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!caseId || !challengeSlug || syncedFor.current === caseId) return;
    // No cancel on cleanup: the once-per-case guard would then drop the reload
    // under StrictMode's double effect, and a setState after unmount is a no-op.
    syncedFor.current = caseId;
    fetchJson<{ ok?: boolean; added?: number }>("/api/profile/trophy-cases/sync-buys", {
      method: "POST",
      cache: "no-store",
    }).then(({ ok, json }) => {
      if (ok && typeof json?.added === "number" && json.added > 0) setSyncGen((n) => n + 1);
    });
  }, [caseId, challengeSlug]);

  useEffect(() => {
    let cancelled = false;
    const gen = ++loadGen.current;
    setMoments(null);
    setMomentsLoadFailed(false);
    setPaniniLinked(null);
    setHasMore(false);
    setNextOffset(0);
    setLoadingMore(false);
    setLoadMoreFailed(false);
    const params = pageParams(0);
    // `fetchJson` never rejects: a non-2xx, a network throw and an unparsable
    // body all arrive as `ok: false`.
    fetchJson<TopMomentsPage>(`/api/profile/top-moments?${params.toString()}`, { cache: "no-store" })
      .then(({ ok, json: d }) => {
        if (cancelled || gen !== loadGen.current) return;
        // ⚠ `ok: false` means WE COULD NOT READ, and it must not reach
        // `setMoments` as a plain `[]`. An empty grid renders "No owned moments
        // found yet" — a claim about the collector's OWN collection manufactured
        // from our outage, and it sends them to the manual tab to type an id for
        // a Moment we simply failed to fetch. Same class this file's header
        // already documents for the search-scope cap.
        if (!ok || d == null) {
          setMomentsLoadFailed(true);
          setMoments([]);
          return;
        }
        const page = (d.moments as PickerMoment[]) ?? [];
        setMoments(page);
        // A route without `hasMore` (deploy skew) falls back to "a full page".
        setHasMore(typeof d.hasMore === "boolean" ? d.hasMore : page.length >= PICKER_LIMIT);
        setNextOffset(PICKER_LIMIT);
        setPaniniLinked(typeof d.paniniUsernamesLinked === "number" ? d.paniniUsernamesLinked : null);
      });
    return () => {
      cancelled = true;
    };
  }, [pageParams, syncGen]);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    const gen = loadGen.current;
    const offset = nextOffset;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    fetchJson<TopMomentsPage>(`/api/profile/top-moments?${pageParams(offset).toString()}`, { cache: "no-store" })
      .then(({ ok, json: d }) => {
        if (gen !== loadGen.current) return;
        setLoadingMore(false);
        // ⚠ A failed page is NOT the end of the list: keep the button, say it
        // failed, and leave what is already loaded alone.
        if (!ok || d == null) {
          setLoadMoreFailed(true);
          return;
        }
        const page = (d.moments as PickerMoment[]) ?? [];
        setMoments((prev) => {
          const base = prev ?? [];
          const seen = new Set(base.map((m) => `${m.collection_id}-${m.moment_id}`));
          return base.concat(page.filter((m) => !seen.has(`${m.collection_id}-${m.moment_id}`)));
        });
        setHasMore(typeof d.hasMore === "boolean" ? d.hasMore : page.length >= PICKER_LIMIT);
        setNextOffset(offset + PICKER_LIMIT);
      });
  }, [loadingMore, nextOffset, pageParams]);

  // Challenge auto-load: while the box still holds the challenge's own player
  // (the pre-fill), follow `hasMore` page by page up to CHALLENGE_AUTOLOAD_MAX.
  // A typed edit stops it (the query no longer matches); a failed page stops it
  // (the button and its error take over — no retry loop).
  const challengeQuery = serverQueryFor(initialQuery);
  const autoLoading =
    challengeQuery !== "" &&
    serverQuery === challengeQuery &&
    moments != null &&
    !momentsLoadFailed &&
    hasMore &&
    !loadMoreFailed &&
    nextOffset < CHALLENGE_AUTOLOAD_MAX;
  useEffect(() => {
    if (autoLoading && !loadingMore) loadMore();
  }, [autoLoading, loadingMore, loadMore]);

  // Keyed on moment_id alone, matching the uniqueness a collector actually
  // perceives ("that Moment is already up"), not the composite the grid uses
  // for React keys.
  const pinnedIds = useMemo(
    () => new Set([...(pinnedMomentIds ?? []), ...pinnedHere].filter(Boolean)),
    [pinnedMomentIds, pinnedHere]
  );

  // The route says more rows exist past what is loaded — the grid, and
  // therefore the client-side filter, is a slice rather than the whole list.
  const atCap = hasMore;
  const loadedCount = moments?.length ?? 0;

  const selectedCollection =
    collectionFilter === "all" ? null : publishedCollections().find((c) => c.id === collectionFilter) ?? null;
  const selectedChain = selectedCollection?.dbChain ?? null;
  const selectedLabel = selectedCollection?.shortLabel ?? "";

  const tiersPresent = useMemo<TierFilter[]>(() => presentTiers(moments), [moments]);

  // When the list was fetched FOR this query, the server already matched it
  // (on more fields than the client filter knows — edition name, say), so the
  // client filter must not re-narrow it. Between keystrokes the previous list
  // is narrowed client-side until the debounced refetch lands.
  // ⚠ Only a NON-EMPTY server query covers the text: a 1-character query maps
  // to "" just like an idle box, so "K" used to filter nothing (2026-11-07 review).
  const clientQuery = serverQuery !== "" && serverQueryFor(query) === serverQuery ? "" : query;
  const filteredSorted = useMemo<PickerMoment[]>(
    () => filterSortMoments(moments, sort, tierFilter, clientQuery),
    [moments, sort, tierFilter, clientQuery]
  );

  // One pin into one slot. Returns null on success, else the reason — the
  // server's own words when it gave them (a challenge rule, say).
  const postPin = useCallback(
    async (m: PickerMoment, targetSlot: number): Promise<string | null> => {
      try {
        const res = await fetch("/api/profile/trophy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slot: targetSlot,
            momentId: m.moment_id,
            collectionId: m.collection_id,
            editionId: m.edition_key,
            playerName: m.player_name ?? m.character_name ?? null,
            setName: m.set_name ?? m.edition_name ?? null,
            serialNumber: m.serial_number,
            circulationCount: m.mint_count,
            tier: m.tier,
            thumbnailUrl: m.image_url,
            fmv: m.fmv_usd,
            // Session + campaign attribution for the server-logged trophy_pinned event.
            funnel: getFunnelContext(),
            ...(caseId ? { caseId } : {}),
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return data.error || `HTTP ${res.status}`;
        }
        return null;
      } catch (err: unknown) {
        return err instanceof Error ? err.message : "Failed to pin";
      }
    },
    [caseId]
  );

  const pin = useCallback(
    async (m: PickerMoment) => {
      setSaving(true);
      setPickError(null);
      const err = await postPin(m, slot);
      setSaving(false);
      if (err) setPickError(err);
      else onPinned();
    },
    [postPin, slot, onPinned]
  );

  // Pin every pick, in order, into the remaining empty slots. Sequential, so a
  // failure stops at a known point: what landed stays landed (and leaves the
  // list as already-in-case), the rest stay selected, and the reason is shown.
  const pinMany = useCallback(async () => {
    const queue = picked.slice(0, remaining.length);
    if (queue.length === 0) return;
    setSaving(true);
    setPickError(null);
    const landedSlots: number[] = [];
    const landedIds: string[] = [];
    let failure: string | null = null;
    for (let i = 0; i < queue.length; i++) {
      const err = await postPin(queue[i], remaining[i]);
      if (err) {
        failure = `${queue[i].player_name ?? queue[i].character_name ?? "That pick"}: ${err}`;
        break;
      }
      landedSlots.push(remaining[i]);
      landedIds.push(queue[i].moment_id);
    }
    if (landedIds.length > 0) pinnedAny.current = true;
    track("trophy-multi-pin", {
      picked: queue.length,
      landed: landedIds.length,
      case: caseId ? "extra" : "main",
      ...(challengeSlug ? { challenge_slug: challengeSlug } : {}),
    });
    setSaving(false);
    if (!failure) {
      onPinned();
      return;
    }
    setFilled((f) => [...f, ...landedSlots]);
    setPinnedHere((p) => [...p, ...landedIds]);
    setPicked((p) => p.filter((m) => !landedIds.includes(m.moment_id)));
    setPickError(
      landedIds.length > 0 ? `Pinned ${landedIds.length} of ${queue.length}. ${failure}` : failure
    );
  }, [picked, remaining, postPin, caseId, challengeSlug, onPinned]);

  // Resolve the pasted id against the real moment resolver (get_moment_detail
  // via /api/moment/<id>) rather than searching your top-96. On a miss we show
  // an error and leave manualPreview null so there's nothing to pin — the old
  // path fabricated a blank PickerMoment that could still be pinned into a junk
  // trophy with no metadata.
  const lookupManual = useCallback(async () => {
    const id = manualId.trim();
    if (!id) return;
    setManualError(null);
    setManualPreview(null);
    try {
      const res = await fetch(`/api/moment/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) {
        // A lookup FAILURE is not a verdict about the ID. The route answers 404
        // for a genuine miss and 503 when it could not look at all, so reporting
        // both as "no such moment" states a fact about the catalogue that was
        // manufactured from a database outage.
        setManualError(
          res.status >= 500
            ? "Couldn't look that up right now — try again in a moment."
            : "Couldn't find a moment with that ID."
        );
        return;
      }
      const d = await res.json();
      if (!d || d.ok === false || !d.resolved) {
        setManualError("Couldn't find a moment with that ID.");
        return;
      }
      const r = d.resolved ?? {};
      const e = d.edition ?? {};
      const ss = d.serial_specific ?? {};
      const f = d.fmv ?? {};
      setManualPreview({
        moment_id: String(ss.nft_id ?? id),
        collection_id: r.collection_id ?? "",
        collection_slug: r.collection_slug ?? e.collection_slug ?? "",
        wallet_address: ss.owner_address ?? "",
        player_name: e.player_name ?? null,
        set_name: e.set_name ?? null,
        team_name: e.team_name ?? null,
        tier: e.tier ?? null,
        serial_number: ss.serial_number ?? r.serial_number ?? null,
        mint_count: e.circulation_count ?? null,
        fmv_usd: f.fmv_usd ?? null,
        image_url: e.thumbnail_url ?? null,
        is_locked: false,
        series_number: e.series ?? null,
        edition_key: e.external_id ?? null,
        character_name: e.character_name ?? null,
        edition_name: e.name ?? null,
        league: null,
        jersey_number: null,
      });
    } catch {
      setManualError("Lookup failed. Try again.");
    }
  }, [manualId]);

  return (
    <div
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label={multi ? `Fill ${describeSlots(remaining)}` : `Pin to slot ${slot}`}
        className="bg-[var(--rpc-surface)] border border-[color:var(--rpc-border)] rounded-xl shadow-2xl"
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          overflow: "auto",
          padding: 20,
          color: "var(--rpc-text-primary)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontFamily: condensedFont,
              fontWeight: 800,
              fontSize: 16,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {multi
              ? `${title ?? (caseId ? "Trophy case" : "Main trophy case")} · ${remaining.length} empty slot${remaining.length === 1 ? "" : "s"}`
              : title
              ? `${title} · slot ${slot}`
              : `Pin to slot ${slot}`}
          </div>
          <button
            onClick={close}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--rpc-text-primary)",
              fontSize: 18,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 12, borderBottom: "1px solid var(--rpc-border)" }}>
          <TabBtn active={tab === "grid"} onClick={() => setTab("grid")}>
            Pick from collection
          </TabBtn>
          <TabBtn active={tab === "manual"} onClick={() => setTab("manual")}>
            Enter ID manually
          </TabBtn>
        </div>

        {tab === "grid" && pending && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
            <button
              onClick={() => {
                setPending(null);
                setPickError(null);
              }}
              style={{
                alignSelf: "flex-start",
                background: "transparent",
                border: "none",
                color: "var(--rpc-text-muted)",
                fontFamily: monoFont,
                fontSize: 11,
                letterSpacing: "0.08em",
                cursor: "pointer",
                padding: 0,
              }}
            >
              ← Back to your Moments
            </button>

            <PickPreview m={pending}>
              {/* ⚠ The verb names the consequence. An overwrite and a first
                  pin are different acts, and labelling both "Pin" hides the
                  destructive one behind the harmless one's wording. */}
              <button onClick={() => pin(pending)} disabled={saving} style={primaryBtnStyle}>
                {saving ? "Pinning…" : replacingName ? "Replace trophy" : "Pin trophy"}
              </button>
            </PickPreview>

            {/* ⚠ The one thing the old one-tap flow could never say. Pinning
                REPLACES whatever is in this slot and there is no undo, so the
                collector is told whose trophy they are about to displace —
                before the write, not in a toast after it. */}
            {replacingName ? (
              <div
                style={{
                  fontFamily: monoFont,
                  fontSize: 11,
                  color: "var(--rpc-warning-text)",
                  letterSpacing: "0.03em",
                }}
              >
                This replaces {replacingName} in slot {slot}.
              </div>
            ) : (
              <div
                style={{
                  fontFamily: monoFont,
                  fontSize: 11,
                  color: "var(--rpc-text-muted)",
                  letterSpacing: "0.03em",
                }}
              >
                Slot {slot} is empty.
              </div>
            )}

            {pickError && (
              <div style={{ color: "var(--rpc-danger-text)", fontFamily: monoFont, fontSize: 11 }}>{pickError}</div>
            )}
          </div>
        )}

        {tab === "grid" && !pending && multi && (
          <div
            data-testid="multi-pick-bar"
            style={{
              position: "sticky",
              top: -20,
              zIndex: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
              padding: "10px 12px",
              margin: "0 0 10px",
              borderRadius: 8,
              border: "1px solid var(--rpc-border)",
              background: "var(--rpc-surface-raised)",
            }}
          >
            <div role="status" style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.4 }}>
              {picked.length === 0
                ? `Tap up to ${remaining.length} — they fill your empty slots in order.`
                : `${picked.length} of ${remaining.length} picked → ${describeSlots(remaining.slice(0, picked.length))}`}
            </div>
            {picked.length > 0 && (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked([]);
                    setPickError(null);
                  }}
                  disabled={saving}
                  style={{ ...primaryBtnStyle, background: "transparent", border: "1px solid var(--rpc-border)", color: "var(--rpc-text-primary)" }}
                >
                  Clear
                </button>
                <button type="button" onClick={() => void pinMany()} disabled={saving} style={primaryBtnStyle}>
                  {saving ? "Pinning…" : `Pin ${picked.length}`}
                </button>
              </div>
            )}
            {pickError && (
              <div role="alert" style={{ flexBasis: "100%", color: "var(--rpc-danger-text)", fontFamily: monoFont, fontSize: 11 }}>
                {pickError}
              </div>
            )}
          </div>
        )}

        {tab === "grid" && !pending && (
          <>
            {challengeOffer && !caseId && (
              <div
                data-testid="picker-challenge-offer"
                role="note"
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  padding: "10px 12px",
                  margin: "0 0 10px",
                  borderRadius: 8,
                  border: "1px solid var(--rpc-red-border)",
                  fontFamily: monoFont,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: "var(--rpc-text-secondary)",
                }}
              >
                <span>
                  This is your <strong>main</strong> trophy case. Building your {challengeOffer.title} entry? It has its own case.
                </span>
                <button
                  type="button"
                  onClick={challengeOffer.onUse}
                  style={{
                    fontFamily: condensedFont,
                    fontWeight: 700,
                    fontSize: 11,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    borderRadius: 8,
                    padding: "6px 12px",
                    cursor: "pointer",
                    background: "var(--rpc-red-fill)",
                    border: "1px solid var(--rpc-red-fill)",
                    color: "#fff", // brand-exception: white label on the --rpc-red-fill button (4.68:1)
                    whiteSpace: "nowrap",
                  }}
                >
                  Use my {challengeOffer.title} case
                </button>
              </div>
            )}
            {/* 2026-11-08: "How do I show off my Panini cards?" — a challenge
                that takes Panini says where the username goes, only when the
                route has READ that none is linked (null = unknown: say nothing). */}
            {initialQuery && paniniLinked === 0 && (
              <div data-rpc-picker-panini-hint style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.5, margin: "0 0 8px" }}>
                Panini cards count too —{" "}
                {/* A full navigation on purpose: the picker is a modal over the dashboard,
                    and the hash must scroll to the field after the tab switch. */}
                <a href={PANINI_LINK_HREF} style={{ color: "var(--rpc-red-text)", textDecoration: "none" }}>
                  add your Panini username
                </a>{" "}
                and they show up here.
              </div>
            )}
            <CollectionPicker
              value={collectionFilter}
              onChange={(c) => {
                setCollectionFilter(c);
                // Reset league filter when leaving Top Shot — only TS has NBA/WNBA values.
                if (c !== "all" && c !== "nba-top-shot" && leagueFilter !== "all") {
                  setLeagueFilter("all");
                }
              }}
            />
            {(collectionFilter === "all" || collectionFilter === "nba-top-shot") && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, marginBottom: 4 }}>
                <span
                  style={{
                    fontFamily: monoFont,
                    fontSize: 9,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "var(--rpc-text-muted)",
                  }}
                >
                  League
                </span>
                <LeagueFilter value={leagueFilter} onChange={setLeagueFilter} />
              </div>
            )}
            <FilterChips
              tierFilter={tierFilter}
              onChange={setTierFilter}
              tiersPresent={tiersPresent}
            />
            <SortBar sort={sort} onChange={setSort} />

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by player, set, or team…"
              aria-label="Search your moments"
              style={{
                width: "100%",
                marginTop: 10,
                padding: "9px 12px",
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: 6,
                color: "var(--rpc-text-primary)",
                fontFamily: monoFont,
                fontSize: 13,
              }}
            />

            {/* ⚠ Disclosed, not silently truncated. We cannot tell "owns exactly
                96" from "owns 500 and we loaded 96", so the copy states what IS
                true either way — these are the highest-value ones — rather than
                asserting a truncation we have not measured. */}
            {serverQuery ? (
              <div
                role="status"
                style={{
                  fontFamily: monoFont,
                  fontSize: 10,
                  color: "var(--rpc-text-muted)",
                  marginTop: 6,
                  letterSpacing: "0.04em",
                }}
              >
                {autoLoading
                  ? `Loading every “${serverQuery}” Moment you hold… ${loadedCount} so far.`
                  : atCap
                  ? `Searching everything you hold for “${serverQuery}” — showing the ${loadedCount} highest-value matches. Add a set or team name to narrow it, or load more below.`
                  : `Searching everything you hold for “${serverQuery}”.`}
              </div>
            ) : atCap ? (
              <div
                style={{
                  fontFamily: monoFont,
                  fontSize: 10,
                  color: "var(--rpc-text-muted)",
                  marginTop: 6,
                  letterSpacing: "0.04em",
                }}
              >
                Showing your {loadedCount} highest-value Moments. Type a player,
                set or team to search everything you hold, or load more below.
              </div>
            ) : null}

            {moments == null ? (
              <div style={{ textAlign: "center", padding: 24 }}>
                <span className="rpc-spinner" />
              </div>
            ) : momentsLoadFailed ? (
              /* ⚠ BEFORE the empty state. "No owned moments found yet" is a
                 claim about the reader's own collection, and the manual-tab
                 suggestion beside it makes it ACTIONABLE — they go and type an
                 id for something we merely failed to load. */
              <div
                role="status"
                style={{
                  fontFamily: monoFont,
                  fontSize: 12,
                  color: "var(--rpc-text-secondary)",
                  padding: 16,
                  textAlign: "center",
                }}
              >
                Couldn&rsquo;t load your Moments. This is a problem on our side and says nothing
                about what you own — try again in a moment.
              </div>
            ) : filteredSorted.length === 0 ? (
              <div
                style={{
                  fontFamily: monoFont,
                  fontSize: 12,
                  color: "var(--rpc-text-secondary)",
                  padding: 16,
                  textAlign: "center",
                }}
              >
                {/* ⚠ ORDER MATTERS. A list fetched FOR a name is empty because
                    nothing MATCHED, not because the collector owns nothing —
                    "No owned moments found yet" there is a false claim about
                    their holdings. The name check comes before the pool check. */}
                {/* 2026-11-07 review: the name copy only when the server answered
                    the name with NOTHING. When it returned Moments and the tier
                    filter (or a pending keystroke) hid them, "nothing you hold
                    matches" was a false statement about the holdings. */}
                {serverQuery && moments.length === 0
                  ? `Nothing you hold matches “${serverQuery}”. Only priced Moments are listed — use the manual tab if you know its ID.`
                  : serverQuery
                    ? "No moments match the current filter."
                  : moments.length === 0
                    ? /* "None" is either "owns nothing here" or "no wallet saved on
                         this chain" — the helper says which only when it KNOWS. */
                      collectionFilter === "panini-blockchain"
                      ? paniniEmptyPoolCopy(paniniLinked)
                      : emptyPoolCopy(selectedChain, selectedLabel, savedChains ?? null)
                    : atCap
                      ? `Nothing in your top ${loadedCount} by value matches. Type at least two characters to search everything you hold, or load more below.`
                      : "No moments match the current filter."}
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  maxHeight: 540,
                  overflowY: "auto",
                  paddingRight: 4,
                  marginTop: 10,
                }}
              >
                {filteredSorted.map((m) => (
                  <MomentRow
                    key={`${m.collection_id}-${m.moment_id}`}
                    m={m}
                    disabled={saving}
                    alreadyPinned={pinnedIds.has(m.moment_id)}
                    pickedAs={
                      multi
                        ? (() => {
                            const i = picked.findIndex(
                              (p) => p.moment_id === m.moment_id && p.collection_id === m.collection_id
                            );
                            return i >= 0 ? remaining[i] ?? null : null;
                          })()
                        : null
                    }
                    onClick={() => {
                      setPickError(null);
                      if (multi) {
                        setPicked((p) =>
                          togglePick(p, m, remaining.length, (x) => `${x.collection_id}-${x.moment_id}`)
                        );
                      } else {
                        setPending(m);
                      }
                    }}
                  />
                ))}
              </div>
            )}
            {moments != null && !momentsLoadFailed && hasMore && (
              <div style={{ textAlign: "center", marginTop: 10 }}>
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{
                    fontFamily: monoFont,
                    fontSize: 12,
                    letterSpacing: "0.04em",
                    padding: "10px 18px",
                    minHeight: 44,
                    borderRadius: 8,
                    border: "1px solid var(--rpc-border)",
                    background: "transparent",
                    color: "var(--rpc-text-primary)",
                    cursor: loadingMore ? "default" : "pointer",
                    opacity: loadingMore ? 0.6 : 1,
                  }}
                >
                  {loadingMore ? "Loading…" : `Load ${PICKER_LIMIT} more`}
                </button>
                {loadMoreFailed && (
                  <div
                    role="status"
                    style={{
                      color: "var(--rpc-danger-text)",
                      fontFamily: monoFont,
                      fontSize: 11,
                      marginTop: 6,
                    }}
                  >
                    Couldn&rsquo;t load more. This is a problem on our side — try again.
                  </div>
                )}
              </div>
            )}
            {/* Multi-pick shows its error in the sticky bar, beside the button. */}
            {pickError && !multi && (
              <div
                style={{
                  color: "var(--rpc-danger-text)",
                  fontFamily: monoFont,
                  fontSize: 11,
                  marginTop: 8,
                }}
              >
                {pickError}
              </div>
            )}
          </>
        )}

        {tab === "manual" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)" }}>
              Paste a moment ID to pin a trophy directly. Useful for moments outside your saved
              wallets (gifts, friends&apos; moments you&apos;re holding).
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder="Moment ID"
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  background: "var(--rpc-surface-raised)",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: 6,
                  color: "var(--rpc-text-primary)",
                  fontFamily: monoFont,
                  fontSize: 13,
                }}
              />
              <button onClick={lookupManual} style={primaryBtnStyle}>
                Look up
              </button>
            </div>
            {manualPreview && (
              <PickPreview m={manualPreview}>
                <button onClick={() => pin(manualPreview)} disabled={saving} style={primaryBtnStyle}>
                  {saving ? "Pinning…" : "Pin"}
                </button>
              </PickPreview>
            )}
            {manualError && (
              <div style={{ color: "var(--rpc-danger-text)", fontFamily: monoFont, fontSize: 11 }}>
                {manualError}
              </div>
            )}
            {pickError && (
              <div style={{ color: "var(--rpc-danger-text)", fontFamily: monoFont, fontSize: 11 }}>
                {pickError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The "this is what you picked" card, shared by BOTH tabs.
 *
 * One renderer on purpose: the manual tab has shown a preview since it was
 * written, and the grid's confirm step shows the same thing. Two copies would
 * drift the first time either gained a field, and the two paths write the
 * identical row — a collector who pins by ID and one who pins by tap should be
 * looking at the same card before they commit.
 *
 * The action button is a child rather than a prop so the caller owns its label
 * ("Pin" vs "Pin to slot 3") and its disabled state.
 */
function PickPreview({ m, children }: { m: PickerMoment; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}
    >
      {m.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={proxyIpfsImageUrl(m.image_url, 320) ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6 }}
        />
      ) : (
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 6,
            background: "var(--rpc-surface-raised)",
            border: "1px solid var(--rpc-border)",
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 14,
            color: "var(--rpc-text-primary)",
          }}
        >
          {displayName(m)}
        </div>
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 11,
            color: "var(--rpc-text-secondary)",
            marginTop: 4,
          }}
        >
          {m.set_name ?? "—"}
          {m.serial_number ? ` #${m.serial_number}` : ""}
          {m.mint_count ? `/${m.mint_count}` : ""}
        </div>
        {/* "FMV unknown" rather than a dash or a zero: an unpriced Moment is a
            real state on this platform, and $0 would read as a valuation. */}
        <div
          style={{
            marginTop: 6,
            fontFamily: condensedFont,
            fontWeight: 800,
            color: "var(--rpc-success-text)",
          }}
        >
          {m.fmv_usd != null ? fmtUsd(Number(m.fmv_usd)) : "FMV unknown"}
        </div>
      </div>
      {children}
    </div>
  );
}

function MomentRow({
  m,
  disabled,
  alreadyPinned,
  pickedAs = null,
  onClick,
}: {
  m: PickerMoment;
  disabled: boolean;
  /** Already in another slot — shown as taken, and not clickable. */
  alreadyPinned?: boolean;
  /** Multi-pick: the slot this pick will land in, or null when not picked. */
  pickedAs?: number | null;
  onClick: () => void;
}) {
  const tier = normalizeTier(m.tier);
  const tc = tierColor(tier);
  // Prefix the set name with the series (helper keys Top Shot off "topshot";
  // our slug is long-form), omitting the anomalous unmapped TS series=1.
  const seriesToken =
    m.collection_slug === "nba_top_shot" || m.collection_slug === "topshot"
      ? "topshot"
      : m.collection_slug;
  const sLabel = seriesLabel(seriesToken, m.series_number);
  const baseSet = m.set_name ?? m.edition_name ?? null;
  const setLabel = baseSet
    ? m.series_number != null && !isUnmappedSeriesLabel(sLabel)
      ? sLabel + " · " + baseSet
      : baseSet
    : "—";

  // An already-pinned Moment is inert AND dimmed. Disabling without dimming
  // reads as a broken button; dimming without disabling still lets a fast click
  // through, and the upsert conflicts on (user_id, slot) so nothing downstream
  // would reject the duplicate.
  const inert = disabled || !!alreadyPinned;

  return (
    <button
      onClick={alreadyPinned ? undefined : onClick}
      disabled={inert}
      aria-pressed={pickedAs != null ? true : undefined}
      title={alreadyPinned ? "Already in your trophy case" : undefined}
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 12,
        width: "100%",
        minHeight: 72,
        padding: "8px 10px",
        background: "var(--rpc-surface-raised)",
        border: pickedAs != null ? "1px solid var(--rpc-red-border)" : "1px solid var(--rpc-border)",
        boxShadow: pickedAs != null ? "0 0 0 1px var(--rpc-red-border)" : undefined,
        borderRadius: 8,
        color: "var(--rpc-text-primary)",
        textAlign: "left",
        cursor: alreadyPinned ? "not-allowed" : disabled ? "wait" : "pointer",
        opacity: inert ? 0.45 : 1,
        position: "relative",
      }}
      onMouseEnter={(e) => {
        if (!inert) (e.currentTarget as HTMLButtonElement).style.borderColor = tc;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          pickedAs != null ? "var(--rpc-red-border)" : "var(--rpc-border)";
      }}
    >
      {pickedAs != null && (
        <span
          data-testid="picked-slot"
          style={{
            position: "absolute",
            top: 6,
            right: 8,
            fontFamily: monoFont,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: "var(--rpc-red-text)",
            border: "1px solid var(--rpc-red-border)",
            borderRadius: 999,
            padding: "1px 7px",
            background: "var(--rpc-black)",
          }}
        >
          SLOT {pickedAs}
        </span>
      )}
      {alreadyPinned && (
        <span
          style={{
            position: "absolute",
            top: 6,
            right: 8,
            fontFamily: monoFont,
            fontSize: 8,
            letterSpacing: "0.12em",
            color: "var(--rpc-text-secondary)",
            border: "1px solid var(--rpc-border)",
            borderRadius: 999,
            padding: "1px 6px",
            background: "var(--rpc-black)",
          }}
        >
          PINNED
        </span>
      )}
      {/* Thumbnail — pinned to the top so it aligns with the player name */}
      <div
        style={{
          position: "relative",
          width: 56,
          height: 56,
          flex: "0 0 56px",
          alignSelf: "flex-start",
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--rpc-surface-raised)",
          border: `1px solid ${tierColorAlpha(tc, 33)}`,
        }}
      >
        {m.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxyIpfsImageUrl(m.image_url, 320) ?? undefined}
            alt={displayName(m)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: tc,
              fontSize: 22,
              fontFamily: condensedFont,
              fontWeight: 900,
            }}
          >
            ●
          </div>
        )}
        {m.is_locked && (
          <div
            aria-label="Locked on Top Shot — can still be pinned"
            title="Locked on Top Shot — can still be pinned"
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              fontSize: 11,
              color: "var(--rpc-warning-text)",
              textShadow: "0 0 4px rgba(0,0,0,0.85)",
            }}
          >
            🔒
          </div>
        )}
      </div>

      {/* Middle — name, team, set · tier · league */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div
          style={{
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 14,
            color: "var(--rpc-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: "0.02em",
          }}
        >
          {displayName(m)}
        </div>
        {m.team_name && (
          <div
            style={{
              fontFamily: monoFont,
              fontSize: 9,
              color: "var(--rpc-text-muted)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {m.team_name}
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: monoFont,
            fontSize: 11,
            color: "var(--rpc-text-secondary)",
            minWidth: 0,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: "0 1 auto",
            }}
          >
            {setLabel}
          </span>
          {tier && (
            <span
              style={{
                flex: "0 0 auto",
                fontFamily: condensedFont,
                fontWeight: 800,
                fontSize: 9,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: tc,
                background: tierColorAlpha(tc, 10),
                border: `1px solid ${tierColorAlpha(tc, 33)}`,
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {tier}
            </span>
          )}
          {m.collection_id === TOPSHOT_COLLECTION_ID && (m.league === "NBA" || m.league === "WNBA") && (
            <span
              style={{
                flex: "0 0 auto",
                fontFamily: monoFont,
                fontSize: 9,
                letterSpacing: "0.1em",
                color: "var(--rpc-text-secondary)",
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {m.league}
            </span>
          )}
        </div>
      </div>

      {/* Right — price column: FMV lines up down the list, then serial + the
          canonical special-serial badges (#1 / jersey / perfect). */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: 3,
          textAlign: "right",
          minWidth: 76,
        }}
      >
        <span style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "var(--rpc-success-text)" }}>
          {fmtUsd(m.fmv_usd)}
        </span>
        {m.serial_number != null && (
          <span style={{ fontFamily: monoFont, fontSize: 10, color: "var(--rpc-text-muted)" }}>
            #{m.serial_number}
            {m.mint_count ? `/${m.mint_count}` : ""}
          </span>
        )}
        <span style={{ display: "flex", justifyContent: "flex-end" }}>
          <SerialBadge
            serial={m.serial_number ?? undefined}
            mintSize={m.mint_count ?? undefined}
            jerseyNumber={m.jersey_number ?? null}
            collection={m.collection_slug}
          />
        </span>
        {m.serial_fmv ? <SerialFmvBadge data={m.serial_fmv} /> : null}
      </div>
    </button>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
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

function CollectionPicker({
  value,
  onChange,
}: {
  value: CollectionFilter;
  onChange: (v: CollectionFilter) => void;
}) {
  const items: { key: CollectionFilter; label: string; icon: string; accent: string }[] = [
    { key: "all", label: "All", icon: "★", accent: "#9CA3AF" },
    // Every chain the trophy pool is indexed for. The pool is
    // wallet_moments_cache; Candy MLB (Solana) is in it — 25,375 holdings
    // across 456 wallets on 2026-09-27, all edition-matched — so it is a chip
    // too. A chain NOT in that cache (Panini, unindexed) would filter to an
    // empty list every time, which reads as "you own none" when the truth is
    // "not indexed here", so it stays out until its holdings are.
    // Panini (2026-09-28) is read by the collector's LINKED username instead.
    ...publishedCollections().filter((c) => (c.dbChain != null && TROPHY_INDEXED_CHAINS.has(c.dbChain)) || TROPHY_USERNAME_COLLECTIONS.has(c.id)).map((c) => ({
      key: c.id,
      label: c.shortLabel,
      icon: c.icon,
      accent: c.accent,
    })),
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        marginTop: 4,
        marginBottom: 8,
        paddingBottom: 8,
        borderBottom: "1px solid var(--rpc-border)",
      }}
    >
      {items.map((it) => {
        const active = value === it.key;
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            title={it.label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: active ? `${it.accent}26` : "transparent",
              border: `1px solid ${active ? it.accent : "var(--rpc-border)"}`,
              color: active ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
              fontFamily: condensedFont,
              fontWeight: 800,
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              padding: "5px 10px",
              borderRadius: 999,
              cursor: "pointer",
            }}
          >
            <span aria-hidden>{it.icon}</span>
            <span>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function FilterChips({
  tierFilter,
  onChange,
  tiersPresent,
}: {
  tierFilter: TierFilter;
  onChange: (t: TierFilter) => void;
  tiersPresent: TierFilter[];
}) {
  const items: TierFilter[] = ["ALL", ...tiersPresent];
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        marginTop: 4,
      }}
    >
      {items.map((t) => {
        const active = tierFilter === t;
        const c = t === "ALL" ? NEUTRAL_TIER_COLOR : tierColor(t);
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            style={{
              background: active ? tierColorAlpha(c, 15) : "transparent",
              border: `1px solid ${active ? c : "var(--rpc-border)"}`,
              color: active ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
              fontFamily: condensedFont,
              fontWeight: 800,
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              padding: "5px 10px",
              borderRadius: 999,
              cursor: "pointer",
            }}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

function SortBar({ sort, onChange }: { sort: SortKey; onChange: (s: SortKey) => void }) {
  const options: { key: SortKey; label: string }[] = [
    { key: "fmv_desc", label: "FMV ↓" },
    { key: "serial_asc", label: "Serial ↑" },
    { key: "tier_rank", label: "Tier" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 8,
      }}
    >
      <span
        style={{
          fontFamily: monoFont,
          fontSize: 9,
          color: "var(--rpc-text-muted)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
        }}
      >
        Sort
      </span>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => {
          const active = sort === o.key;
          return (
            <button
              key={o.key}
              onClick={() => onChange(o.key)}
              style={{
                background: active ? "var(--rpc-surface-raised)" : "transparent",
                border: `1px solid ${active ? "var(--rpc-border)" : "var(--rpc-border)"}`,
                color: active ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
                fontFamily: monoFont,
                fontSize: 10,
                letterSpacing: "0.06em",
                padding: "4px 8px",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  background: RED_FILL,
  border: "none",
  color: "#fff", // brand-exception: white label on the --rpc-red-fill button (4.68:1; the raw red read 4.36:1)
  padding: "8px 18px",
  borderRadius: 6,
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
};
