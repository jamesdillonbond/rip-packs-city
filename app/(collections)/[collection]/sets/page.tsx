"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getCollection } from "@/lib/collections";
import { getOwnerKey } from "@/lib/owner-key";
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection";
import { slugifyName } from "@/lib/entity-labels";
import MomentMedia from "@/components/MomentMedia";

// ── Types (mirrors API response) ─────────────────────────────────────────────

interface MissingPiece {
  playId: string;
  playerName: string;
  tier: string;
  lowestAsk: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
  fmv?: number | null;
  fmvConfidence?: string | null;
  hasBadge?: boolean;
  badgeSlugs?: string[];
}

interface OwnedPiece {
  playId: string;
  playerName: string;
  tier: string;
  serialNumber: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
  isLocked?: boolean;
}

type SetTier = "complete" | "almost_there" | "bottleneck" | "completable" | "incomplete" | "unpriced";

interface SetProgress {
  setId: string;
  setName: string;
  series?: number | null;
  setTier?: string | null;
  totalEditions: number;
  ownedCount: number;
  missingCount: number;
  listedCount: number;
  completionPct: number;
  totalMissingCost: number | null;
  lowestSingleAsk: number | null;
  bottleneckPrice: number | null;
  bottleneckPlayerName: string | null;
  tier: SetTier;
  owned: OwnedPiece[];
  missing: MissingPiece[];
  asksEnriched: boolean;
  costConfidence?: "high" | "mixed" | "low";
  lockedOwnedCount?: number;
  tradeableOwnedCount?: number;
  tradeableCompletionPct?: number;
}

interface SetsResponse {
  wallet: string;
  resolvedAddress: string;
  totalSets: number;
  completeSets: number;
  inProgressSets?: number;
  notStartedSets?: number;
  sets: SetProgress[];
  generatedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type SortKey = "completion" | "cost" | "name";
type FilterKey = "all" | "complete" | "in_progress" | "not_started";

function fmt$(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
  return "$" + n.toFixed(2);
}

const TIER_STRIPE: Record<string, string> = {
  COMMON: "#9ca3af",
  UNCOMMON: "var(--tier-uncommon)",
  FANDOM: "#60a5fa",
  RARE: "#a855f7",
  LEGENDARY: "#fbbf24",
  ULTIMATE: "#ec4899",
  // UFC Strike tier vocabulary
  CHALLENGER: "var(--tier-challenger)",
  CONTENDER: "var(--tier-contender)",
  CHAMPION: "var(--tier-champion)",
};

function tierStripeColor(tier: string | null | undefined): string {
  if (!tier) return TIER_STRIPE.COMMON;
  return TIER_STRIPE[tier.toUpperCase()] ?? TIER_STRIPE.COMMON;
}

// In-memory cache of Top Shot per-set detail (/api/sets?wallet=&set=) keyed by
// `${wallet}:${setId}`. SetCard expand and the modal both fetch the same row;
// without a shared cache they double-request whenever the user expands a card
// then opens it (Set audit B3). Lives for the page lifetime.
const setDetailCache = new Map<string, SetProgress>();

async function fetchSetDetail(wallet: string, setId: string): Promise<SetProgress | null> {
  const key = `${wallet}:${setId}`;
  const cached = setDetailCache.get(key);
  if (cached) return cached;
  try {
    const r = await fetch(`/api/sets?wallet=${encodeURIComponent(wallet)}&set=${encodeURIComponent(setId)}`);
    if (!r.ok) return null;
    const j: SetsResponse = await r.json();
    const s = j?.sets?.[0];
    if (s) {
      setDetailCache.set(key, s);
      return s;
    }
  } catch {
    /* swallow — caller renders the list-level row as fallback */
  }
  return null;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const displayFont = "var(--font-display)";
const monoFont = "var(--font-mono)";

function makeColors(accent: string) {
  return {
    bg: "#080808",
    card: "rgba(255,255,255,0.04)",
    cardBorder: "rgba(255,255,255,0.08)",
    cardHover: `${accent}4D`,
    accent,
    text: "#F1F1F1",
    muted: "rgba(255,255,255,0.45)",
    green: "#22c55e",
    barBg: "rgba(255,255,255,0.08)",
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SetsPage() {
  const params = useParams();
  const collectionSlug = (params?.collection as string) ?? "nba-top-shot";
  const collectionObj = getCollection(collectionSlug);
  const accent = collectionObj?.accent ?? "var(--rpc-red)";
  const colors = makeColors(accent);
  const isAllDay = collectionSlug === "nfl-all-day";
  const isUfc = collectionSlug === "ufc";
  const [wallet, setWallet] = useState<string | null>(null);
  const [data, setData] = useState<SetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("completion");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [openSet, setOpenSet] = useState<SetProgress | null>(null);
  const [openSetDetail, setOpenSetDetail] = useState<SetProgress | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  const autoLoadFired = useRef(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const w = p.get("wallet") || p.get("address") || null;
    if (w && w.trim()) {
      setWallet(w.trim());
      return;
    }
    if (autoLoadFired.current) return;
    const key = getOwnerKey();
    if (key) {
      autoLoadFired.current = true;
      setWallet(key);
      return;
    }
    let cancelled = false;
    fetchSavedWalletForCollection(collectionSlug).then((addr) => {
      if (cancelled || autoLoadFired.current || !addr) return;
      autoLoadFired.current = true;
      setWallet(addr);
    });
    return () => { cancelled = true; };
  }, [collectionSlug]);

  useEffect(() => {
    if (!wallet) return;
    const w = wallet;
    let cancelled = false;
    async function go() {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const isTopShot = collectionSlug === "nba-top-shot";
        const endpoint =
          isAllDay ? "/api/allday-set-progress"
          : isUfc ? "/api/ufc-set-progress"
          : isTopShot ? "/api/sets"
          : `/api/sets-db?collection=${encodeURIComponent(collectionSlug)}&`;
        const url = endpoint.includes("?")
          ? endpoint + "wallet=" + encodeURIComponent(w)
          : endpoint + "?wallet=" + encodeURIComponent(w);
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Request failed (" + res.status + ")");
        }
        const json: SetsResponse = await res.json();
        if (!cancelled) setData(json);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    go();
    return () => { cancelled = true; };
  }, [wallet, collectionSlug, isAllDay, isUfc]);

  // Modal a11y: escape-to-close + focus trap (Set audit V5).
  useEffect(() => {
    if (!openSet) return;
    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // Focus the first interactive element in the modal so screen readers and
    // keyboard users land inside the dialog when it opens.
    const focusFirst = () => {
      const root = modalRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled])'
      );
      (focusables[0] ?? root).focus();
    };
    const raf = requestAnimationFrame(focusFirst);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpenSet(null); return; }
      if (e.key !== "Tab") return;
      const root = modalRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled])'
        )
      ).filter((el) => !el.hasAttribute("aria-hidden"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(raf);
      // Restore focus to whatever opened the modal.
      lastFocusedRef.current?.focus?.();
    };
  }, [openSet]);

  // Top Shot's list response omits per-set owned moments — fetch the detail
  // view so the modal can show them. Other collections carry whatever
  // moment-level detail they have inline on the set object already.
  // Depend on `openSet?.setId` (not the whole object) so the effect doesn't
  // re-fire on unrelated re-renders, and consult the shared cache so we
  // don't duplicate SetCard's expand fetch (Set audit B3).
  const openSetId = openSet?.setId ?? null;
  useEffect(() => {
    if (!openSetId) { setOpenSetDetail(null); return; }
    if (collectionSlug !== "nba-top-shot" || !wallet) { setOpenSetDetail(null); return; }
    let cancelled = false;
    fetchSetDetail(wallet, openSetId).then((s) => {
      if (cancelled) return;
      if (s) setOpenSetDetail(s);
    });
    return () => { cancelled = true; };
  }, [openSetId, collectionSlug, wallet]);

  const displaySets = useMemo(() => {
    if (!data) return [];
    let sets = [...data.sets];

    if (filter === "complete") sets = sets.filter((s) => s.completionPct === 100);
    else if (filter === "in_progress") sets = sets.filter((s) => s.completionPct > 0 && s.completionPct < 100);
    else if (filter === "not_started") sets = sets.filter((s) => s.completionPct === 0);

    sets.sort((a, b) => {
      if (sortBy === "completion") return b.completionPct - a.completionPct;
      if (sortBy === "cost") {
        const ca = a.totalMissingCost ?? Infinity;
        const cb = b.totalMissingCost ?? Infinity;
        return ca - cb;
      }
      return a.setName.localeCompare(b.setName);
    });

    return sets;
  }, [data, sortBy, filter]);

  const totalSets = data?.totalSets ?? 0;
  const completeSets = data?.completeSets ?? 0;
  const inProgressSets = data?.inProgressSets ?? (data ? data.sets.filter((s) => s.completionPct > 0 && s.completionPct < 100).length : 0);
  const notStartedSets = data?.notStartedSets ?? (data ? data.sets.filter((s) => s.completionPct === 0).length : 0);
  const completePct = totalSets > 0 ? Math.min(100, Math.max(0, Math.round((completeSets / totalSets) * 100))) : 0;

  if (wallet === null && !loading) {
    return (
      <div style={{ background: colors.bg, minHeight: "100vh" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "50vh", gap: 16 }}>
            <div style={{ fontFamily: displayFont, fontWeight: 800, fontSize: 20, color: colors.text, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              NO WALLET LOADED
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 13, color: colors.muted, textAlign: "center", maxWidth: 400, lineHeight: 1.6 }}>
              Search a wallet on the Collection tab first
            </div>
            <Link
              href={`/${collectionSlug}/collection`}
              style={{ fontFamily: monoFont, fontSize: 12, color: colors.accent, textDecoration: "none", border: `1px solid ${accent}4D`, padding: "8px 20px", borderRadius: 4, marginTop: 8, transition: "background 0.15s ease" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = `${accent}14`)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              GO TO COLLECTION →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: colors.bg, minHeight: "100vh" }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>

        <h1 style={{ fontFamily: displayFont, fontWeight: 900, fontSize: 28, color: colors.text, textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 20px", lineHeight: 1 }}>
          SET TRACKER
        </h1>

        {loading && (
          <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="rpc-skeleton" style={{ width: 140, height: 64, borderRadius: 8 }} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} style={{ background: colors.card, border: "1px solid " + colors.cardBorder, borderRadius: 10, padding: 20 }}>
                  <div className="rpc-skeleton" style={{ width: "60%", height: 18, marginBottom: 14, borderRadius: 4 }} />
                  <div className="rpc-skeleton" style={{ width: "100%", height: 8, marginBottom: 10, borderRadius: 4 }} />
                  <div className="rpc-skeleton" style={{ width: "40%", height: 12, borderRadius: 4 }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {error && !loading && (
          <div style={{ background: `${accent}14`, border: `1px solid ${accent}40`, borderRadius: 8, padding: "16px 20px", marginBottom: 20 }}>
            <div style={{ fontFamily: displayFont, fontWeight: 700, fontSize: 14, color: colors.accent, textTransform: "uppercase", marginBottom: 4 }}>ERROR</div>
            <div style={{ fontFamily: monoFont, fontSize: 12, color: colors.muted, lineHeight: 1.5 }}>{error}</div>
          </div>
        )}

        {data && data.sets.length === 0 && !loading && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "40vh", gap: 12 }}>
            <div style={{ fontFamily: displayFont, fontWeight: 800, fontSize: 18, color: colors.text, textTransform: "uppercase" }}>
              NO SETS FOUND
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 12, color: colors.muted }}>
              {`No ${collectionObj?.label ?? "this collection"} moments found in this wallet`}
            </div>
          </div>
        )}

        {data && data.sets.length > 0 && !loading && (
          <>
            {isAllDay && (
              <div
                role="note"
                style={{
                  marginBottom: 16,
                  padding: "10px 14px",
                  background: `${accent}14`,
                  border: `1px solid ${accent}40`,
                  borderRadius: 8,
                  fontFamily: monoFont,
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: colors.muted,
                }}
              >
                NFL All Day has ended primary pack sales — completing a set is now a
                secondary-market purchase. Cost-to-complete figures below reflect
                secondary prices only.
              </div>
            )}
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              <SummaryCard label="TOTAL SETS" value={String(totalSets)} accent={accent} />
              <SummaryCard label="COMPLETE" value={String(completeSets)} sub={completePct + "%"} accent={accent} />
              <SummaryCard label="IN PROGRESS" value={String(inProgressSets)} accent={accent} />
              <SummaryCard label="NOT STARTED" value={String(notStartedSets)} accent={accent} />
            </div>

            <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5, marginBottom: 16, maxWidth: 880 }}>
              RPC counts a set complete when you own every play in it. Top Shot&apos;s &ldquo;Completed Sets&rdquo; may include per-set criteria (challenges, badges, parallel collections) this tracker doesn&apos;t model &mdash; gaps are expected.
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: monoFont, fontSize: 10, color: colors.muted, letterSpacing: "0.1em", textTransform: "uppercase", alignSelf: "center", marginRight: 4 }}>SORT</span>
              <Pill label="COMPLETION %" active={sortBy === "completion"} onClick={() => setSortBy("completion")} accent={accent} />
              <Pill label="COST TO COMPLETE" active={sortBy === "cost"} onClick={() => setSortBy("cost")} accent={accent} />
              <Pill label="NAME A-Z" active={sortBy === "name"} onClick={() => setSortBy("name")} accent={accent} />
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
              <span style={{ fontFamily: monoFont, fontSize: 10, color: colors.muted, letterSpacing: "0.1em", textTransform: "uppercase", alignSelf: "center", marginRight: 4 }}>FILTER</span>
              <Pill label="ALL" active={filter === "all"} onClick={() => setFilter("all")} accent={accent} />
              <Pill label="COMPLETE" active={filter === "complete"} onClick={() => setFilter("complete")} accent={accent} />
              <Pill label="IN PROGRESS" active={filter === "in_progress"} onClick={() => setFilter("in_progress")} accent={accent} />
              <Pill label="NOT STARTED" active={filter === "not_started"} onClick={() => setFilter("not_started")} accent={accent} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
              {displaySets.map((set) => (
                <SetCard
                  key={set.setId}
                  set={set}
                  collectionSlug={collectionSlug}
                  wallet={wallet ?? ""}
                  accent={accent}
                  onView={() => setOpenSet(set)}
                />
              ))}
            </div>

            {displaySets.length === 0 && (
              <div style={{ fontFamily: monoFont, fontSize: 12, color: colors.muted, textAlign: "center", padding: "40px 0" }}>
                No sets match this filter
              </div>
            )}
          </>
        )}
      </div>

      {openSet && (() => {
        const modalSet = openSetDetail ?? openSet;
        const mOwned = modalSet.owned ?? [];
        const mMissing = modalSet.missing ?? [];
        return (
        <div
          onClick={() => setOpenSet(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="set-modal-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            style={{ background: colors.bg, border: "1px solid " + colors.cardBorder, borderRadius: 10, padding: "20px 24px", maxWidth: 720, maxHeight: "85vh", width: "100%", overflow: "auto", outline: "none" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <h3 id="set-modal-title" style={{ fontFamily: displayFont, fontWeight: 800, fontSize: 18, color: colors.text, textTransform: "uppercase", letterSpacing: "0.04em", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {openSet.setName}
              </h3>
              <button
                onClick={() => setOpenSet(null)}
                aria-label={`Close ${openSet.setName} details`}
                style={{ fontFamily: monoFont, fontSize: 14, color: colors.muted, background: "transparent", border: "none", cursor: "pointer", padding: 4, flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: colors.muted, marginBottom: 14, letterSpacing: "0.05em", textTransform: "uppercase" }}>
              {openSet.ownedCount} / {openSet.totalEditions} OWNED · {openSet.completionPct}%
            </div>
            <Link
              href={`/${collectionSlug}/set/${slugifyName(openSet.setName)}`}
              style={{ display: "inline-block", fontFamily: monoFont, fontSize: 11, color: accent, textDecoration: "none", border: `1px solid ${accent}4D`, padding: "6px 14px", borderRadius: 4, marginBottom: 14, letterSpacing: "0.08em" }}
            >
              VIEW FULL SET PAGE →
            </Link>
            {mOwned.length === 0 && mMissing.length === 0 ? (
              <div style={{ fontFamily: monoFont, fontSize: 12, color: colors.muted, padding: "20px 0", textAlign: "center" }}>
                {openSet.ownedCount > 0
                  ? "Moment-level detail isn't available for this set yet"
                  : "No moments owned in this set yet"}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {mOwned.length > 0 && (
                  <div>
                    <div style={{ fontFamily: monoFont, fontSize: 9, color: colors.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 8 }}>
                      OWNED ({mOwned.length})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {mOwned.map((piece, idx) => (
                        <ModalRow
                          key={`o-${piece.playId}-${piece.serialNumber ?? idx}`}
                          href={piece.topshotUrl}
                          thumbnailUrl={piece.thumbnailUrl}
                          playerName={piece.playerName}
                          meta={`#${piece.serialNumber ?? "—"} · ${piece.tier}`}
                          colors={colors}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {mMissing.length > 0 && (
                  <div>
                    <div style={{ fontFamily: monoFont, fontSize: 9, color: colors.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 8 }}>
                      MISSING ({mMissing.length})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {mMissing.map((piece, idx) => (
                        <ModalRow
                          key={`m-${piece.playId}-${idx}`}
                          href={piece.topshotUrl}
                          thumbnailUrl={piece.thumbnailUrl}
                          playerName={piece.playerName}
                          meta={`${piece.tier}${piece.lowestAsk != null ? ` · ~${fmt$(piece.lowestAsk)}` : ""}`}
                          colors={colors}
                          muted
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  const c = makeColors(accent);
  return (
    <div style={{ background: c.card, border: "1px solid " + c.cardBorder, borderRadius: 8, padding: "12px 18px", minWidth: 120 }}>
      <div style={{ fontFamily: monoFont, fontSize: 9, color: c.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: displayFont, fontWeight: 800, fontSize: 22, color: c.text }}>
          {value}
        </span>
        {sub && (
          <span style={{ fontFamily: monoFont, fontSize: 11, color: c.muted }}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

function ModalRow({
  href,
  thumbnailUrl,
  playerName,
  meta,
  colors,
  muted,
}: {
  href: string;
  thumbnailUrl: string | null;
  playerName: string;
  meta: string;
  colors: ReturnType<typeof makeColors>;
  muted?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: "flex", alignItems: "center", gap: 12, padding: 8, borderRadius: 6, background: colors.card, border: "1px solid " + colors.cardBorder, textDecoration: "none", opacity: muted ? 0.85 : 1, transition: "border-color 0.15s ease" }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = colors.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = colors.cardBorder)}
    >
      <MomentMedia thumbnailUrl={thumbnailUrl} alt={playerName || "Moment thumbnail"} size={40} rounded={4} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: displayFont, fontWeight: 700, fontSize: 14, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {playerName}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 10, color: colors.muted, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          {meta}
        </div>
      </div>
      <span style={{ fontFamily: monoFont, fontSize: 10, color: colors.accent, letterSpacing: "0.08em", flexShrink: 0 }}>VIEW →</span>
    </a>
  );
}

function Pill({ label, active, onClick, accent }: { label: string; active: boolean; onClick: () => void; accent: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: monoFont,
        fontSize: 10,
        letterSpacing: "0.08em",
        padding: "5px 14px",
        borderRadius: 4,
        border: "1px solid " + (active ? `${accent}80` : "rgba(255,255,255,0.09)"),
        background: active ? `${accent}14` : "rgba(255,255,255,0.03)",
        color: active ? accent : "rgba(255,255,255,0.45)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function SetCard({
  set,
  collectionSlug,
  wallet,
  accent,
  onView,
}: {
  set: SetProgress;
  collectionSlug: string;
  wallet: string;
  accent: string;
  onView: () => void;
}) {
  const c = makeColors(accent);
  const isComplete = set.completionPct === 100;
  const inProgress = set.completionPct > 0 && set.completionPct < 100;
  const stripeColor = tierStripeColor(set.setTier);

  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<SetProgress | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Depend on stable `set.setId` (not the whole `set` object) — the previous
  // dep on the whole object made this effect re-fire on every re-render.
  // Goes through the shared cache so we don't double-fetch what the modal
  // effect already loaded (Set audit B3).
  const setId = set.setId;
  useEffect(() => {
    if (!expanded || detail || loadingDetail || !wallet) return;
    // Only Top Shot exposes a per-set detail endpoint (/api/sets?set=).
    // Other collections already carry their preview data inline on the
    // set object from the list response — render that directly.
    if (collectionSlug !== "nba-top-shot") {
      setDetail(set);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    fetchSetDetail(wallet, setId)
      .then((s) => {
        if (cancelled) return;
        if (s) setDetail(s);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `set` intentionally excluded; setId is the stable identity
  }, [expanded, detail, loadingDetail, wallet, setId, collectionSlug]);

  return (
    <div
      style={{
        position: "relative",
        background: c.card,
        border: "1px solid " + c.cardBorder,
        borderRadius: 10,
        overflow: "hidden",
        transition: "border-color 0.15s ease",
      }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: stripeColor }} />

      <div style={{ padding: "16px 18px 14px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
          <Link
            href={`/${collectionSlug}/set/${slugifyName(set.setName)}`}
            prefetch={false}
            style={{
              fontFamily: displayFont, fontWeight: 800, fontSize: 16, color: c.text,
              textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1.15,
              textDecoration: "none", flex: 1, minWidth: 0, overflow: "hidden",
              textOverflow: "ellipsis", display: "-webkit-box",
              WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            }}
          >
            {set.setName}
          </Link>
          {set.series != null && (
            <span style={{
              fontFamily: monoFont, fontSize: 9, color: c.muted, letterSpacing: "0.08em",
              padding: "2px 8px", borderRadius: 999,
              border: "1px solid " + c.cardBorder, background: "rgba(255,255,255,0.03)",
              flexShrink: 0,
            }}>
              S{set.series}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1, height: 6, background: c.barBg, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: set.completionPct + "%", height: "100%", background: isComplete ? c.green : c.accent }} />
          </div>
          <span style={{ fontFamily: monoFont, fontSize: 11, color: c.text, minWidth: 36, textAlign: "right" }}>
            {set.completionPct}%
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <span style={{ fontFamily: monoFont, fontSize: 11, color: c.muted, letterSpacing: "0.04em" }}>
            {set.ownedCount} / {set.totalEditions} OWNED
          </span>
          <span style={{ fontFamily: displayFont, fontWeight: 700, fontSize: 14, color: c.text }}>
            {fmt$(set.totalMissingCost)}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onView}
            style={{ flex: 1, fontFamily: monoFont, fontSize: 10, padding: "6px 10px", borderRadius: 4, border: "1px solid " + c.cardBorder, background: "transparent", color: c.accent, cursor: "pointer", letterSpacing: "0.08em" }}
          >
            VIEW
          </button>
          {inProgress && (
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{ flex: 1, fontFamily: monoFont, fontSize: 10, padding: "6px 10px", borderRadius: 4, border: "1px solid " + c.cardBorder, background: expanded ? `${accent}14` : "transparent", color: c.muted, cursor: "pointer", letterSpacing: "0.08em" }}
            >
              {expanded ? "COLLAPSE ▲" : "EXPAND ▼"}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: "1px solid " + c.cardBorder, padding: "12px 14px 16px", background: "rgba(0,0,0,0.25)" }}>
          {loadingDetail && !detail && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="rpc-skeleton" style={{ aspectRatio: "1 / 1", borderRadius: 6 }} />
              ))}
            </div>
          )}
          {detail && (
            <DetailGrid set={detail} accent={accent} />
          )}
        </div>
      )}
    </div>
  );
}

function DetailGrid({ set, accent }: { set: SetProgress; accent: string }) {
  const c = makeColors(accent);
  return (
    <>
      {set.owned.length > 0 && (
        <>
          <div style={{ fontFamily: monoFont, fontSize: 9, color: c.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 8 }}>
            OWNED ({set.owned.length})
          </div>
          <div className="rpc-set-detail-grid" style={{ display: "grid", gap: 8, marginBottom: 12 }}>
            {set.owned.map((p, i) => (
              <DetailTile
                key={`o-${p.playId}-${i}`}
                thumbnailUrl={p.thumbnailUrl}
                playerName={p.playerName}
                badge={p.serialNumber != null ? `#${p.serialNumber}` : null}
                href={p.topshotUrl}
                accent={accent}
              />
            ))}
          </div>
        </>
      )}
      {set.missing.length > 0 && (
        <>
          <div style={{ fontFamily: monoFont, fontSize: 9, color: c.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 8 }}>
            MISSING ({set.missing.length})
          </div>
          <div className="rpc-set-detail-grid" style={{ display: "grid", gap: 8 }}>
            {set.missing.map((p, i) => (
              <DetailTile
                key={`m-${p.playId}-${i}`}
                thumbnailUrl={p.thumbnailUrl}
                playerName={p.playerName}
                badge={p.lowestAsk != null ? `~${fmt$(p.lowestAsk)}` : null}
                href={p.topshotUrl}
                accent={accent}
                muted
              />
            ))}
          </div>
        </>
      )}
      <style>{`
        .rpc-set-detail-grid { grid-template-columns: repeat(3, 1fr); }
        @media (min-width: 768px) { .rpc-set-detail-grid { grid-template-columns: repeat(6, 1fr); } }
      `}</style>
    </>
  );
}

function DetailTile({
  thumbnailUrl,
  playerName,
  badge,
  href,
  accent,
  muted,
}: {
  thumbnailUrl: string | null;
  playerName: string;
  badge: string | null;
  href: string;
  accent: string;
  muted?: boolean;
}) {
  const c = makeColors(accent);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "block", textDecoration: "none",
        borderRadius: 6, overflow: "hidden",
        border: "1px solid " + c.cardBorder,
        opacity: muted ? 0.85 : 1,
        background: c.card,
      }}
    >
      <MomentMedia thumbnailUrl={thumbnailUrl} alt={playerName} rounded={0} />
      <div style={{ padding: "6px 8px" }}>
        <div style={{ fontFamily: displayFont, fontWeight: 700, fontSize: 11, color: c.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.2 }}>
          {playerName}
        </div>
        {badge && (
          <div style={{ fontFamily: monoFont, fontSize: 9, color: c.muted, letterSpacing: "0.05em" }}>
            {badge}
          </div>
        )}
      </div>
    </a>
  );
}
