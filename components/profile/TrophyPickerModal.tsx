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
import LeagueFilter, { type LeagueValue } from "@/components/filters/LeagueFilter";
import SerialFmvBadge, { type SerialFmvData } from "@/components/SerialFmvBadge";
import { publishedCollections } from "@/lib/collections";
import { track } from "@/lib/telemetry/track";
import { seriesLabel, isUnmappedSeriesLabel } from "@/lib/analytics/series-labels";

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
  serial_fmv?: SerialFmvData;
}

type SortKey = "fmv_desc" | "serial_asc" | "tier_rank";
type TierFilter = "ALL" | "ULTIMATE" | "LEGENDARY" | "RARE" | "FANDOM" | "UNCOMMON" | "COMMON";

const TIER_ORDER: TierFilter[] = ["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "UNCOMMON", "COMMON"];

function normalizeTier(tier?: string | null): TierFilter | null {
  if (!tier) return null;
  const t = tier.toLowerCase();
  if (t.includes("ultimate")) return "ULTIMATE";
  if (t.includes("legendary")) return "LEGENDARY";
  if (t.includes("rare")) return "RARE";
  if (t.includes("fandom")) return "FANDOM";
  if (t.includes("uncommon")) return "UNCOMMON";
  if (t.includes("common")) return "COMMON";
  return null;
}

function tierColor(tier: TierFilter | null): string {
  switch (tier) {
    case "ULTIMATE":  return "#EC4899";
    case "LEGENDARY": return "#F59E0B";
    case "RARE":      return "#818CF8";
    case "FANDOM":    return "#34D399";
    case "UNCOMMON":  return "#60A5FA";
    case "COMMON":    return "#9CA3AF";
    default:          return "#6B7280";
  }
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (!n) return "$0";
  if (n >= 1000) return "$" + Math.round(n).toLocaleString();
  return "$" + n.toFixed(2);
}

// Lightweight badge icon set. Renders an icon plus tooltip for the common
// jersey-match / low-serial / rookie premiere chips when they are present
// either in `badges` (array of slugs) or inferable from numeric heuristics.
function inferBadges(m: PickerMoment): { icon: string; label: string }[] {
  const out: { icon: string; label: string }[] = [];
  const explicit = (m.badges ?? []).map((b) => String(b).toLowerCase());

  function has(needles: string[]): boolean {
    return explicit.some((b) => needles.some((n) => b.includes(n)));
  }

  if (has(["jersey_match", "jersey-match", "jerseymatch"])) {
    out.push({ icon: "🏀", label: "Jersey match" });
  }
  if (has(["rookie_premiere", "rookie-premiere", "rookie", "rp"])) {
    out.push({ icon: "🎓", label: "Rookie premiere" });
  }
  // Low serial: explicit badge OR serial in single/double digits.
  if (has(["low_serial", "low-serial"]) || (m.serial_number != null && m.serial_number > 0 && m.serial_number <= 99)) {
    out.push({ icon: "⭐", label: `Low serial #${m.serial_number ?? ""}`.trim() });
  }
  return out;
}

function displayName(m: PickerMoment): string {
  return (
    m.player_name ||
    m.character_name ||
    m.edition_name ||
    m.moment_id
  );
}

function tierRank(tier: TierFilter | null): number {
  if (!tier) return 99;
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? 99 : idx;
}

interface Props {
  slot: number;
  ownerKey: string | null;
  onClose: () => void;
  onPinned: () => void;
}

export default function TrophyPickerModal({ slot, ownerKey, onClose, onPinned }: Props) {
  const [tab, setTab] = useState<"grid" | "manual">("grid");
  const [moments, setMoments] = useState<PickerMoment[] | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [sort, setSort] = useState<SortKey>("fmv_desc");
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const tiersPresent = useMemo<TierFilter[]>(() => {
    if (!moments) return [];
    const set = new Set<TierFilter>();
    for (const m of moments) {
      const t = normalizeTier(m.tier);
      if (t) set.add(t);
    }
    return TIER_ORDER.filter((t) => set.has(t));
  }, [moments]);

  const filteredSorted = useMemo<PickerMoment[]>(() => {
    if (!moments) return [];
    const filtered =
      tierFilter === "ALL"
        ? moments.slice()
        : moments.filter((m) => normalizeTier(m.tier) === tierFilter);
    filtered.sort((a, b) => {
      switch (sort) {
        case "serial_asc": {
          const sa = a.serial_number ?? Number.POSITIVE_INFINITY;
          const sb = b.serial_number ?? Number.POSITIVE_INFINITY;
          if (sa !== sb) return sa - sb;
          return (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0);
        }
        case "tier_rank": {
          const ra = tierRank(normalizeTier(a.tier));
          const rb = tierRank(normalizeTier(b.tier));
          if (ra !== rb) return ra - rb;
          return (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0);
        }
        case "fmv_desc":
        default:
          return (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0);
      }
    });
    return filtered;
  }, [moments, sort, tierFilter]);

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

  const lookupManual = useCallback(async () => {
    const id = manualId.trim();
    if (!id) return;
    setManualError(null);
    try {
      const res = await fetch("/api/profile/top-moments?limit=96", { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        const found = ((d?.moments ?? []) as PickerMoment[]).find(
          (m) => String(m.moment_id) === id
        );
        if (found) {
          setManualPreview(found);
          return;
        }
      }
      setManualPreview({
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Lookup failed";
      setManualError(msg);
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
  onClick,
}: {
  m: PickerMoment;
  disabled: boolean;
  onClick: () => void;
}) {
  const tier = normalizeTier(m.tier);
  const tc = tierColor(tier);
  const badges = inferBadges(m);
  // Mirror the trophy slab: prefix the set name with the series (helper keys
  // Top Shot off "topshot"; our slug is long-form), omitting the anomalous
  // unmapped TS series=1. Non-TS collections fall to "Series N".
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

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: 72,
        padding: "8px 10px",
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
        borderRadius: 8,
        color: "var(--rpc-text-primary)",
        textAlign: "left",
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.borderColor = tc;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--rpc-border)";
      }}
    >
      <div
        style={{
          position: "relative",
          width: 56,
          height: 56,
          flex: "0 0 56px",
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--rpc-surface-raised)",
          border: `1px solid ${tc}55`,
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
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
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
                background: `${tc}1A`,
                border: `1px solid ${tc}55`,
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
          {m.serial_number != null && (
            <span style={{ flex: "0 0 auto", color: "var(--rpc-text-muted)" }}>
              #{m.serial_number}
              {m.mint_count ? `/${m.mint_count}` : ""}
            </span>
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 13,
          }}
        >
          <span style={{ color: "#34D399" }}>{fmtUsd(m.fmv_usd)}</span>
          {m.serial_fmv ? <SerialFmvBadge data={m.serial_fmv} /> : null}
          {badges.length > 0 && (
            <span style={{ display: "flex", gap: 4 }}>
              {badges.map((b, i) => (
                <span
                  key={i}
                  title={b.label}
                  aria-label={b.label}
                  style={{
                    fontSize: 12,
                    lineHeight: 1,
                    background: "var(--rpc-surface-hover)",
                    border: "1px solid var(--rpc-border)",
                    borderRadius: 4,
                    padding: "2px 5px",
                  }}
                >
                  {b.icon}
                </span>
              ))}
            </span>
          )}
        </div>
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
        const c = t === "ALL" ? "#9CA3AF" : tierColor(t);
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            style={{
              background: active ? `${c}26` : "transparent",
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
