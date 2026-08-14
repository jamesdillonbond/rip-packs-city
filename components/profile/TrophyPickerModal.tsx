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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useModalA11y } from "@/lib/hooks/useModalA11y";
import LeagueFilter, { type LeagueValue } from "@/components/filters/LeagueFilter";
import SerialFmvBadge, { type SerialFmvData } from "@/components/SerialFmvBadge";
import SerialBadge from "@/components/collection/SerialBadge";
import { publishedCollections } from "@/lib/collections";
import { track } from "@/lib/telemetry/track";
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
} from "@/lib/trophy-picker-format";
import { NEUTRAL_TIER_COLOR, tierColorAlpha } from "@/lib/tier-color";

const condensedFont = "var(--font-display)";
const monoFont = "var(--font-mono)";
const ACCENT_RED = "var(--rpc-red)";

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
  wallet_address: string;
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
}

export default function TrophyPickerModal({
  slot,
  ownerKey,
  onClose,
  onPinned,
  pinnedMomentIds,
}: Props) {
  const [tab, setTab] = useState<"grid" | "manual">("grid");
  const [moments, setMoments] = useState<PickerMoment[] | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [sort, setSort] = useState<SortKey>("fmv_desc");
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("ALL");
  const [leagueFilter, setLeagueFilter] = useState<LeagueValue>("all");
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter>("all");

  // Manual entry tab
  const [manualId, setManualId] = useState("");
  const [manualPreview, setManualPreview] = useState<PickerMoment | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => {
    track("trophy-modal-open", { slot });
  }, [slot]);

  // Escape-to-close + focus trap + focus restore. The modal is always "open"
  // while mounted (parent controls mount), so isOpen is a constant true.
  const contentRef = useModalA11y<HTMLDivElement>(true, onClose);

  useEffect(() => {
    let cancelled = false;
    setMoments(null);
    const params = new URLSearchParams({ limit: "96" });
    if (ownerKey) params.set("ownerKey", ownerKey);
    if (leagueFilter !== "all") params.set("league", leagueFilter);
    if (collectionFilter !== "all") params.set("collection", collectionFilter);
    fetch(`/api/profile/top-moments?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setMoments((d?.moments as PickerMoment[]) ?? []);
      })
      .catch(() => {
        if (!cancelled) setMoments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerKey, leagueFilter, collectionFilter]);

  // Keyed on moment_id alone, matching the uniqueness a collector actually
  // perceives ("that Moment is already up"), not the composite the grid uses
  // for React keys.
  const pinnedIds = useMemo(
    () => new Set((pinnedMomentIds ?? []).filter(Boolean)),
    [pinnedMomentIds]
  );

  const tiersPresent = useMemo<TierFilter[]>(() => presentTiers(moments), [moments]);

  const filteredSorted = useMemo<PickerMoment[]>(
    () => filterSortMoments(moments, sort, tierFilter, query),
    [moments, sort, tierFilter, query]
  );

  const pin = useCallback(
    async (m: PickerMoment) => {
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
            playerName: m.player_name ?? m.character_name ?? null,
            setName: m.set_name ?? m.edition_name ?? null,
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to pin";
        setPickError(msg);
      } finally {
        setSaving(false);
      }
    },
    [slot, onPinned]
  );

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
      role="dialog"
      aria-modal
      aria-label={`Pin to slot ${slot}`}
      onClick={onClose}
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
        onClick={(e) => e.stopPropagation()}
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
            Pin to slot {slot}
          </div>
          <button
            onClick={onClose}
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

        {tab === "grid" && (
          <>
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

            {moments == null ? (
              <div style={{ textAlign: "center", padding: 24 }}>
                <span className="rpc-spinner" />
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
                {moments.length === 0
                  ? "No owned moments found yet — try the manual tab if you know the moment ID."
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
                    onClick={() => pin(m)}
                  />
                ))}
              </div>
            )}
            {pickError && (
              <div
                style={{
                  color: "#F87171",
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
                {manualPreview.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={manualPreview.image_url}
                    alt=""
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
                    {displayName(manualPreview)}
                  </div>
                  <div
                    style={{
                      fontFamily: monoFont,
                      fontSize: 11,
                      color: "var(--rpc-text-secondary)",
                      marginTop: 4,
                    }}
                  >
                    {manualPreview.set_name ?? "—"}
                    {manualPreview.serial_number ? ` #${manualPreview.serial_number}` : ""}
                    {manualPreview.mint_count ? `/${manualPreview.mint_count}` : ""}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontFamily: condensedFont,
                      fontWeight: 800,
                      color: "#34D399",
                    }}
                  >
                    {manualPreview.fmv_usd != null
                      ? fmtUsd(Number(manualPreview.fmv_usd))
                      : "FMV unknown"}
                  </div>
                </div>
                <button onClick={() => pin(manualPreview)} disabled={saving} style={primaryBtnStyle}>
                  {saving ? "Pinning…" : "Pin"}
                </button>
              </div>
            )}
            {manualError && (
              <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11 }}>
                {manualError}
              </div>
            )}
            {pickError && (
              <div style={{ color: "#F87171", fontFamily: monoFont, fontSize: 11 }}>
                {pickError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MomentRow({
  m,
  disabled,
  alreadyPinned,
  onClick,
}: {
  m: PickerMoment;
  disabled: boolean;
  /** Already in another slot — shown as taken, and not clickable. */
  alreadyPinned?: boolean;
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
      title={alreadyPinned ? "Already in your trophy case" : undefined}
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 12,
        width: "100%",
        minHeight: 72,
        padding: "8px 10px",
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
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
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--rpc-border)";
      }}
    >
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
            src={m.image_url}
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
            aria-label="Locked"
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              fontSize: 11,
              color: "#F59E0B",
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
        <span style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 14, color: "#34D399" }}>
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
    ...publishedCollections().map((c) => ({
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
  background: ACCENT_RED,
  border: "none",
  color: "#fff", // brand-exception: white text on the red (ACCENT_RED) primary-button fill
  padding: "8px 18px",
  borderRadius: 6,
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
};
