"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";

// ── Types (mirrors API response) ─────────────────────────────────────────────

interface MissingPiece {
  playId: string;
  playerName: string;
  tier: string;
  lowestAsk: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
}

interface OwnedPiece {
  playId: string;
  playerName: string;
  tier: string;
  serialNumber: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
}

type SetTier = "complete" | "almost_there" | "bottleneck" | "completable" | "incomplete" | "unpriced";

interface SetProgress {
  setId: string;
  setName: string;
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
}

interface SetsResponse {
  wallet: string;
  resolvedAddress: string;
  totalSets: number;
  completeSets: number;
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

// ── Styles ───────────────────────────────────────────────────────────────────

const displayFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";

const colors = {
  bg: "#080808",
  card: "rgba(255,255,255,0.04)",
  cardBorder: "rgba(255,255,255,0.08)",
  cardHover: "rgba(224,58,47,0.3)",
  red: "#E03A2F",
  text: "#F1F1F1",
  muted: "rgba(255,255,255,0.45)",
  green: "#22c55e",
  barBg: "rgba(255,255,255,0.08)",
};

// ── Component ────────────────────────────────────────────────────────────────

export default function SetsPage({ params }: { params: { collection: string } }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [data, setData] = useState<SetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("completion");
  const [filter, setFilter] = useState<FilterKey>("all");

  // Read wallet from URL params on mount (client-only)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const w = p.get("wallet") || p.get("address") || null;
    if (w && w.trim()) setWallet(w.trim());
  }, []);

  // Fetch sets when wallet is set
  useEffect(() => {
    if (!wallet) return;
    const w = wallet;
    let cancelled = false;
    async function go() {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await fetch(
          "/api/sets?wallet=" + encodeURIComponent(w) + "&skipAsks=1"
        );
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
  }, [wallet]);

  // ── Filtered + sorted sets ──────────────────────────────────────────────
  const displaySets = useMemo(() => {
    if (!data) return [];
    let sets = [...data.sets];

    // Filter
    if (filter === "complete") sets = sets.filter((s) => s.completionPct === 100);
    else if (filter === "in_progress") sets = sets.filter((s) => s.completionPct > 0 && s.completionPct < 100);
    else if (filter === "not_started") sets = sets.filter((s) => s.ownedCount === 0);

    // Sort
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

  const completeSets = data ? data.sets.filter((s) => s.completionPct === 100).length : 0;
  const completePct = data && data.totalSets > 0
    ? Math.round((completeSets / data.totalSets) * 100)
    : 0;

  // ── No wallet state ─────────────────────────────────────────────────────
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
              href="/nba-top-shot/collection"
              style={{ fontFamily: monoFont, fontSize: 12, color: colors.red, textDecoration: "none", border: "1px solid rgba(224,58,47,0.3)", padding: "8px 20px", borderRadius: 4, marginTop: 8, transition: "background 0.15s ease" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(224,58,47,0.08)")}
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

        {/* Page title */}
        <h1 style={{ fontFamily: displayFont, fontWeight: 900, fontSize: 28, color: colors.text, textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 20px", lineHeight: 1 }}>
          SET TRACKER
        </h1>

        {/* ── Loading skeleton ────────────────────────────────────────────── */}
        {loading && (
          <div>
            {/* Skeleton summary bar */}
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              {[1, 2, 3].map((i) => (
                <div key={i} className="rpc-skeleton" style={{ width: 120, height: 52, borderRadius: 8 }} />
              ))}
            </div>
            {/* Skeleton cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(1, 1fr)", gap: 16 }}>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} style={{ background: colors.card, border: "1px solid " + colors.cardBorder, borderRadius: 10, padding: 20 }}>
                  <div className="rpc-skeleton" style={{ width: "60%", height: 18, marginBottom: 14, borderRadius: 4 }} />
                  <div className="rpc-skeleton" style={{ width: "100%", height: 8, marginBottom: 10, borderRadius: 4 }} />
                  <div className="rpc-skeleton" style={{ width: "40%", height: 12, borderRadius: 4 }} />
                </div>
              ))}
            </div>
            <style>{`@media (min-width: 768px) { div[style*="grid-template-columns: repeat(1"] { grid-template-columns: repeat(2, 1fr) !important; } } @media (min-width: 1280px) { div[style*="grid-template-columns: repeat(1"] { grid-template-columns: repeat(3, 1fr) !important; } }`}</style>
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────────────── */}
        {error && !loading && (
          <div style={{ background: "rgba(224,58,47,0.08)", border: "1px solid rgba(224,58,47,0.25)", borderRadius: 8, padding: "16px 20px", marginBottom: 20 }}>
            <div style={{ fontFamily: displayFont, fontWeight: 700, fontSize: 14, color: colors.red, textTransform: "uppercase", marginBottom: 4 }}>ERROR</div>
            <div style={{ fontFamily: monoFont, fontSize: 12, color: colors.muted, lineHeight: 1.5 }}>{error}</div>
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────────────────────── */}
        {data && data.sets.length === 0 && !loading && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "40vh", gap: 12 }}>
            <div style={{ fontFamily: displayFont, fontWeight: 800, fontSize: 18, color: colors.text, textTransform: "uppercase" }}>
              NO SETS FOUND
            </div>
            <div style={{ fontFamily: monoFont, fontSize: 12, color: colors.muted }}>
              No Top Shot moments found in this wallet
            </div>
          </div>
        )}

        {/* ── Data loaded ─────────────────────────────────────────────────── */}
        {data && data.sets.length > 0 && !loading && (
          <>
            {/* Summary bar */}
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              <SummaryCard label="TOTAL SETS" value={String(data.totalSets)} />
              <SummaryCard label="COMPLETE" value={completeSets + " / " + data.totalSets} sub={completePct + "%"} />
            </div>

            {/* Sort pills */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: monoFont, fontSize: 10, color: colors.muted, letterSpacing: "0.1em", textTransform: "uppercase", alignSelf: "center", marginRight: 4 }}>SORT</span>
              <Pill label="COMPLETION %" active={sortBy === "completion"} onClick={() => setSortBy("completion")} />
              <Pill label="COST TO COMPLETE" active={sortBy === "cost"} onClick={() => setSortBy("cost")} />
              <Pill label="NAME A-Z" active={sortBy === "name"} onClick={() => setSortBy("name")} />
            </div>

            {/* Filter pills */}
            <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
              <span style={{ fontFamily: monoFont, fontSize: 10, color: colors.muted, letterSpacing: "0.1em", textTransform: "uppercase", alignSelf: "center", marginRight: 4 }}>FILTER</span>
              <Pill label="ALL" active={filter === "all"} onClick={() => setFilter("all")} />
              <Pill label="COMPLETE" active={filter === "complete"} onClick={() => setFilter("complete")} />
              <Pill label="IN PROGRESS" active={filter === "in_progress"} onClick={() => setFilter("in_progress")} />
              <Pill label="NOT STARTED" active={filter === "not_started"} onClick={() => setFilter("not_started")} />
            </div>

            {/* Set cards grid */}
            <div className="sets-grid">
              {displaySets.map((set) => (
                <SetCard key={set.setId} set={set} />
              ))}
            </div>

            {displaySets.length === 0 && (
              <div style={{ fontFamily: monoFont, fontSize: 12, color: colors.muted, textAlign: "center", padding: "40px 0" }}>
                No sets match this filter
              </div>
            )}

            <style>{`
              .sets-grid {
                display: grid;
                grid-template-columns: repeat(1, 1fr);
                gap: 16px;
              }
              @media (min-width: 768px) {
                .sets-grid { grid-template-columns: repeat(2, 1fr); }
              }
              @media (min-width: 1280px) {
                .sets-grid { grid-template-columns: repeat(3, 1fr); }
              }
            `}</style>
          </>
        )}
      </div>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: colors.card, border: "1px solid " + colors.cardBorder, borderRadius: 8, padding: "12px 18px", minWidth: 100 }}>
      <div style={{ fontFamily: monoFont, fontSize: 9, color: colors.muted, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: displayFont, fontWeight: 800, fontSize: 22, color: colors.text }}>
          {value}
        </span>
        {sub && (
          <span style={{ fontFamily: monoFont, fontSize: 11, color: colors.muted }}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

function Pill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: monoFont,
        fontSize: 10,
        letterSpacing: "0.08em",
        padding: "5px 14px",
        borderRadius: 4,
        border: "1px solid " + (active ? "rgba(224,58,47,0.5)" : "rgba(255,255,255,0.09)"),
        background: active ? "rgba(224,58,47,0.08)" : "rgba(255,255,255,0.03)",
        color: active ? colors.red : colors.muted,
        cursor: "pointer",
        transition: "all 0.15s ease",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function SetCard({ set }: { set: SetProgress }) {
  const isComplete = set.completionPct === 100;
  const pctLabel = set.ownedCount + " / " + set.totalEditions + " · " + set.completionPct + "%";

  // Find cheapest missing moment
  const cheapestMissing = useMemo(() => {
    if (set.missing.length === 0) return null;
    const priced = set.missing.filter((m) => m.lowestAsk !== null && m.lowestAsk > 0);
    if (priced.length === 0) return set.missing[0]; // show first unpriced
    return priced.reduce((a, b) => (a.lowestAsk! < b.lowestAsk! ? a : b));
  }, [set.missing]);

  return (
    <div
      style={{
        background: colors.card,
        border: "1px solid " + colors.cardBorder,
        borderRadius: 10,
        padding: "18px 20px",
        transition: "border-color 0.15s ease",
        cursor: "default",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = colors.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = colors.cardBorder)}
    >
      {/* Set name + complete badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
        <h3 style={{ fontFamily: displayFont, fontWeight: 800, fontSize: 16, color: colors.text, textTransform: "uppercase", letterSpacing: "0.03em", margin: 0, lineHeight: 1.2, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {set.setName}
        </h3>
        {isComplete && (
          <span style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, color: colors.green, background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 4, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0 }}>
            ✓ COMPLETE
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ width: "100%", height: 8, background: colors.barBg, borderRadius: 4, overflow: "hidden" }}>
          <div
            style={{
              width: set.completionPct + "%",
              height: "100%",
              borderRadius: 4,
              background: isComplete ? colors.green : colors.red,
              transition: "width 0.5s ease",
            }}
          />
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 11, color: colors.muted, marginTop: 5 }}>
          {pctLabel}
        </div>
      </div>

      {/* Cost to complete */}
      {set.totalMissingCost !== null && !isComplete && (
        <div style={{ fontFamily: monoFont, fontSize: 11, color: colors.muted, marginBottom: 6 }}>
          Cost to complete: <span style={{ color: colors.text }}>{fmt$(set.totalMissingCost)}</span>
        </div>
      )}

      {/* Cheapest missing moment */}
      {cheapestMissing && !isComplete && (
        <div style={{ fontFamily: monoFont, fontSize: 11, color: colors.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Cheapest: <span style={{ color: "rgba(255,255,255,0.65)" }}>{cheapestMissing.playerName}</span>
          {cheapestMissing.lowestAsk !== null && (
            <span style={{ color: colors.red, marginLeft: 6 }}>{fmt$(cheapestMissing.lowestAsk)}</span>
          )}
        </div>
      )}
    </div>
  );
}
