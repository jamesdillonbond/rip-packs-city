"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

type SetTier = "complete" | "almost_there" | "bottleneck" | "completable" | "incomplete" | "unpriced";

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

function fmt$(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
  return "$" + n.toFixed(2);
}

const TIER_COLORS: Record<string, string> = {
  LEGENDARY: "#f59e0b", RARE: "#8b5cf6",
  FANDOM: "#3b82f6", COMMON: "#6b7280", ULTIMATE: "#ef4444",
};
const TIER_LABELS: Record<string, string> = {
  LEGENDARY: "LEG", RARE: "RARE", FANDOM: "FAN", COMMON: "CMN", ULTIMATE: "ULT",
};
function tierColor(tier: string) { return TIER_COLORS[tier?.toUpperCase()] ?? "#6b7280"; }
function tierLabel(tier: string) { return TIER_LABELS[tier?.toUpperCase()] ?? tier?.slice(0, 3).toUpperCase(); }

function TierBadge({ set }: { set: SetProgress }) {
  if (!set.asksEnriched) return null;
  const configs = {
    almost_there: { label: "ALMOST THERE", color: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.25)" },
    bottleneck:   { label: "BOTTLENECK",   color: "#f59e0b", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)" },
    completable:  { label: "COMPLETE FOR", color: "#60a5fa", bg: "rgba(96,165,250,0.08)", border: "rgba(96,165,250,0.2)" },
  } as const;
  type TierKey = keyof typeof configs;
  const cfg = configs[set.tier as TierKey];
  if (!cfg) return null;
  let value = "";
  if (set.tier === "almost_there" && set.totalMissingCost !== null) value = fmt$(set.totalMissingCost);
  else if (set.tier === "bottleneck" && set.bottleneckPlayerName) value = set.bottleneckPlayerName.split(" ").slice(-1)[0];
  else if (set.tier === "completable" && set.totalMissingCost !== null) value = fmt$(set.totalMissingCost);
  return (
    <div style={{ background: cfg.bg, border: "1px solid " + cfg.border, borderRadius: 5, padding: "2px 7px", fontSize: 9, fontWeight: 700, color: cfg.color, letterSpacing: "0.06em", whiteSpace: "nowrap", flexShrink: 0 }}>
      {cfg.label}{value ? " · " + value : ""}
    </div>
  );
}

function ListedIndicator({ set }: { set: SetProgress }) {
  if (!set.asksEnriched || set.missingCount === 0) return null;
  if (set.listedCount === set.missingCount) return null;
  return <span style={{ fontSize: 9, color: "#475569" }}>{set.listedCount}/{set.missingCount} listed</span>;
}

function ProgressBar({ pct, complete }: { pct: number; complete: boolean }) {
  return (
    <div style={{ width: "100%", height: 4, background: "rgba(255,255,255,0.07)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ width: pct + "%", height: "100%", borderRadius: 4, background: complete ? "linear-gradient(90deg,#22c55e,#16a34a)" : "linear-gradient(90deg,#f97316,#fb923c)", transition: "width 0.6s cubic-bezier(.4,0,.2,1)" }} />
    </div>
  );
}

function BestOpportunityBanner({ sets, onSetClick }: { sets: SetProgress[]; onSetClick: (id: string) => void }) {
  const best = useMemo(() => {
    const at = sets.filter((s) => s.tier === "almost_there" && s.totalMissingCost !== null).sort((a, b) => (a.totalMissingCost ?? 0) - (b.totalMissingCost ?? 0))[0];
    if (at) return { set: at, type: "almost_there" as const };
    const cp = sets.filter((s) => s.tier === "completable" && s.totalMissingCost !== null).sort((a, b) => (a.totalMissingCost ?? 0) - (b.totalMissingCost ?? 0))[0];
    if (cp) return { set: cp, type: "completable" as const };
    return null;
  }, [sets]);

  const bottleneck = useMemo(() =>
    sets.filter((s) => s.tier === "bottleneck" && s.bottleneckPrice !== null).sort((a, b) => b.completionPct - a.completionPct)[0] ?? null,
    [sets]
  );

  if (!best && !bottleneck) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
      {best && (
        <div onClick={() => onSetClick(best.set.setId)}
          style={{ background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(34,197,94,0.1)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(34,197,94,0.06)")}
        >
          <span style={{ fontSize: 16, flexShrink: 0 }}>🎯</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#22c55e", letterSpacing: "0.05em" }}>
              {best.type === "almost_there" ? "BEST OPPORTUNITY — ALMOST THERE" : "CHEAPEST TO COMPLETE"}
            </div>
            <div style={{ fontSize: 12, color: "#e2e8f0", marginTop: 1 }}>
              <span style={{ fontWeight: 600 }}>{best.set.setName}</span>{" — "}
              <span style={{ color: "#22c55e", fontWeight: 700 }}>{fmt$(best.set.totalMissingCost)}</span>
              {" for "}<span style={{ color: "#94a3b8" }}>{best.set.missingCount} {best.set.missingCount === 1 ? "piece" : "pieces"}</span>
            </div>
          </div>
          <div style={{ fontSize: 10, color: "#475569", flexShrink: 0 }}>view ↓</div>
        </div>
      )}
      {bottleneck && (
        <div onClick={() => onSetClick(bottleneck.setId)}
          style={{ background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(245,158,11,0.09)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(245,158,11,0.05)")}
        >
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚡</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b", letterSpacing: "0.05em" }}>BOTTLENECK IDENTIFIED — {bottleneck.completionPct}% COMPLETE</div>
            <div style={{ fontSize: 12, color: "#e2e8f0", marginTop: 1 }}>
              <span style={{ fontWeight: 600 }}>{bottleneck.setName}</span>{" — blocking: "}
              <span style={{ color: "#fbbf24", fontWeight: 600 }}>{bottleneck.bottleneckPlayerName}</span>
              {" at "}<span style={{ color: "#f59e0b", fontWeight: 700 }}>{fmt$(bottleneck.bottleneckPrice)}</span>
            </div>
          </div>
          <div style={{ fontSize: 10, color: "#475569", flexShrink: 0 }}>view ↓</div>
        </div>
      )}
    </div>
  );
}

function SetCard({ set, wallet, expanded, onClick, onPricesLoaded, cardRef }: {
  set: SetProgress; wallet: string; expanded: boolean; onClick: () => void;
  onPricesLoaded: (setId: string, updated: SetProgress) => void;
  cardRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [pricesLoading, setPricesLoading] = useState(false);
  const complete = set.tier === "complete";

  const handlePricesClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPricesLoading(true);
    try {
      const res = await fetch("/api/sets?wallet=" + encodeURIComponent(wallet) + "&set=" + encodeURIComponent(set.setId));
      if (!res.ok) return;
      const data: SetsResponse = await res.json();
      const updated = data.sets.find((s) => s.setId === set.setId);
      if (updated) onPricesLoaded(set.setId, updated);
    } catch { /* silent */ }
    finally { setPricesLoading(false); }
  };

  const borderColor = complete ? "rgba(34,197,94,0.3)"
    : set.tier === "almost_there" ? "rgba(34,197,94,0.2)"
    : set.tier === "bottleneck" ? "rgba(245,158,11,0.2)"
    : expanded ? "rgba(249,115,22,0.3)"
    : "rgba(255,255,255,0.07)";

  return (
    <div ref={cardRef as React.RefObject<HTMLDivElement>}
      style={{ background: expanded ? "rgba(255,255,255,0.055)" : "rgba(255,255,255,0.025)", border: "1px solid " + borderColor, borderRadius: 10, overflow: "hidden", transition: "all 0.15s ease", cursor: "pointer" }}
      onClick={onClick}
    >
      <div style={{ padding: "11px 13px", display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ width: 42, height: 42, borderRadius: 8, flexShrink: 0, background: complete ? "rgba(34,197,94,0.12)" : "rgba(249,115,22,0.07)", border: complete ? "1px solid rgba(34,197,94,0.2)" : "1px solid rgba(249,115,22,0.12)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: complete ? "#22c55e" : "#f97316", lineHeight: 1 }}>{set.completionPct}</span>
          <span style={{ fontSize: 8, color: complete ? "#22c55e" : "#f97316", opacity: 0.6 }}>%</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#f1f5f9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 3 }}>{set.setName}</div>
          <ProgressBar pct={set.completionPct} complete={complete} />
          <div style={{ display: "flex", gap: 7, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: "#94a3b8" }}><span style={{ color: "#22c55e", fontWeight: 600 }}>{set.ownedCount}</span>/{set.totalEditions}</span>
            {!complete && <span style={{ fontSize: 10, color: "#64748b" }}>{set.missingCount} missing</span>}
            <ListedIndicator set={set} />
            <TierBadge set={set} />
          </div>
        </div>
        {complete ? (
          <div style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 14, padding: "2px 8px", fontSize: 9, fontWeight: 700, color: "#22c55e", flexShrink: 0 }}>✓ DONE</div>
        ) : !set.asksEnriched ? (
          <div onClick={handlePricesClick} style={{ flexShrink: 0 }}>
            <div style={{ background: pricesLoading ? "rgba(96,165,250,0.05)" : "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.18)", borderRadius: 5, padding: "3px 8px", fontSize: 9, fontWeight: 600, color: pricesLoading ? "#475569" : "#60a5fa", cursor: pricesLoading ? "not-allowed" : "pointer", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
              {pricesLoading ? "loading…" : "LOAD PRICES"}
            </div>
          </div>
        ) : set.tier === "almost_there" && set.totalMissingCost !== null ? (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#22c55e", letterSpacing: "-0.01em" }}>{fmt$(set.totalMissingCost)}</div>
            <div style={{ fontSize: 8, color: "#64748b" }}>to complete</div>
          </div>
        ) : set.tier === "bottleneck" && set.bottleneckPrice !== null ? (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#f59e0b", letterSpacing: "-0.01em" }}>{fmt$(set.bottleneckPrice)}</div>
            <div style={{ fontSize: 8, color: "#64748b" }}>bottleneck</div>
          </div>
        ) : set.totalMissingCost !== null ? (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#60a5fa", letterSpacing: "-0.01em" }}>{fmt$(set.totalMissingCost)}</div>
            <div style={{ fontSize: 8, color: "#64748b" }}>to complete</div>
          </div>
        ) : set.lowestSingleAsk !== null ? (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 11, color: "#64748b" }}>from</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#fb923c" }}>{fmt$(set.lowestSingleAsk)}</div>
          </div>
        ) : null}
        <div style={{ color: "#475569", fontSize: 10, flexShrink: 0, transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▼</div>
      </div>

      {expanded && (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", padding: "10px 13px 13px" }} onClick={(e) => e.stopPropagation()}>
          {set.asksEnriched && set.tier === "bottleneck" && set.bottleneckPlayerName && (
            <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 7, padding: "8px 10px", marginBottom: 10, fontSize: 11, color: "#fbbf24" }}>
              ⚡ <strong>{set.bottleneckPlayerName}</strong> is your bottleneck at <strong>{fmt$(set.bottleneckPrice)}</strong>. The rest average{" "}
              {fmt$(set.missing.filter((m) => m.lowestAsk !== null && m.playerName !== set.bottleneckPlayerName).reduce((sum, m, _, arr) => arr.length > 0 ? sum + (m.lowestAsk ?? 0) / arr.length : 0, 0))}{" "}each.
            </div>
          )}
          {set.asksEnriched && set.listedCount < set.missingCount && set.listedCount > 0 && (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 7, padding: "6px 10px", marginBottom: 10, fontSize: 10, color: "#64748b" }}>
              ℹ {set.listedCount} of {set.missingCount} missing pieces are currently listed. Total completion cost unavailable until all pieces have listings.
            </div>
          )}
          {set.asksEnriched && set.tier === "almost_there" && set.missing.every((m) => m.lowestAsk !== null) && (
            <div style={{ marginBottom: 10, display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={() => set.missing.forEach((m) => window.open(m.topshotUrl, "_blank"))} style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 6, padding: "5px 12px", fontSize: 10, fontWeight: 700, color: "#22c55e", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em" }}>
                OPEN ALL {set.missing.length} LISTINGS ↗
              </button>
              <span style={{ fontSize: 10, color: "#475569" }}>Complete for {fmt$(set.totalMissingCost)}</span>
            </div>
          )}
          {set.missing.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: "#f97316", textTransform: "uppercase", marginBottom: 5 }}>Missing — {set.missingCount} pieces</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {set.missing.map((piece) => {
                  const isBottleneck = set.bottleneckPlayerName === piece.playerName && set.tier === "bottleneck";
                  return (
                    <a key={piece.playId} href={piece.topshotUrl} target="_blank" rel="noopener noreferrer"
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: isBottleneck ? "rgba(245,158,11,0.07)" : "rgba(249,115,22,0.04)", border: isBottleneck ? "1px solid rgba(245,158,11,0.2)" : "1px solid rgba(249,115,22,0.08)", borderRadius: 7, textDecoration: "none" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = isBottleneck ? "rgba(245,158,11,0.12)" : "rgba(249,115,22,0.08)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = isBottleneck ? "rgba(245,158,11,0.07)" : "rgba(249,115,22,0.04)")}
                    >
                      <div style={{ width: 32, height: 32, borderRadius: 5, flexShrink: 0, overflow: "hidden", border: "1px solid " + (isBottleneck ? "rgba(245,158,11,0.3)" : "rgba(255,255,255,0.08)"), background: piece.thumbnailUrl ? "#0f0f1a" : tierColor(piece.tier) + "22", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {piece.thumbnailUrl ? (
                          <img src={piece.thumbnailUrl} alt={piece.playerName} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.6 }} />
                        ) : isBottleneck ? (
                          <span style={{ fontSize: 14 }}>⚡</span>
                        ) : (
                          <span style={{ fontSize: 8, fontWeight: 700, color: tierColor(piece.tier) }}>{tierLabel(piece.tier)}</span>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: isBottleneck ? "#fbbf24" : "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {piece.playerName === "—" || piece.playerName === "Unknown" ? <span style={{ color: "#475569", fontStyle: "italic" }}>Unknown player</span> : piece.playerName}
                          {isBottleneck && <span style={{ fontSize: 9, color: "#f59e0b", marginLeft: 5, fontWeight: 400 }}>bottleneck</span>}
                        </div>
                        <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 1 }}>
                          <span style={{ fontSize: 8, fontWeight: 700, color: tierColor(piece.tier), background: tierColor(piece.tier) + "20", padding: "1px 4px", borderRadius: 3 }}>{tierLabel(piece.tier)}</span>
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        {!set.asksEnriched ? <span style={{ fontSize: 10, color: "#334155", fontStyle: "italic" }}>—</span>
                          : piece.lowestAsk !== null ? (
                            <><div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "-0.01em", color: isBottleneck ? "#f59e0b" : "#fb923c" }}>{fmt$(piece.lowestAsk)}</div><div style={{ fontSize: 8, color: "#64748b" }}>low ask</div></>
                          ) : <span style={{ fontSize: 10, color: "#475569" }}>No listing</span>}
                      </div>
                      <span style={{ color: "#334155", fontSize: 10, flexShrink: 0 }}>↗</span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}
          {set.owned.length > 0 && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: "#22c55e", textTransform: "uppercase", marginBottom: 5 }}>Owned — {set.ownedCount} pieces</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 4 }}>
                {set.owned.map((piece) => (
                  <a key={piece.playId} href={piece.topshotUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 7px", background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.1)", borderRadius: 6, textDecoration: "none" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(34,197,94,0.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(34,197,94,0.04)")}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 4, flexShrink: 0, overflow: "hidden", border: "1px solid rgba(34,197,94,0.15)", background: "#0f0f1a" }}>
                      {piece.thumbnailUrl ? <img src={piece.thumbnailUrl} alt={piece.playerName} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 7, color: "#334155" }}>✓</span></div>}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 9, fontWeight: 600, color: "#d1fae5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{piece.playerName.split(" ").slice(-1)[0]}</div>
                      <div style={{ fontSize: 8, color: "#4ade80", opacity: 0.6 }}>#{piece.serialNumber ?? "?"}</div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SetsPage() {
  const [inputVal, setInputVal] = useState("");
  const [wallet, setWallet] = useState("");
  const [data, setData] = useState<SetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSet, setExpandedSet] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"intelligence" | "completion" | "missing" | "name">("intelligence");
  const [filterText, setFilterText] = useState("");
  const [hideComplete, setHideComplete] = useState(false);

  const cardRefs = useRef<Map<string, React.RefObject<HTMLDivElement | null>>>(new Map());
  const getCardRef = (setId: string) => {
    if (!cardRefs.current.has(setId)) cardRefs.current.set(setId, { current: null });
    return cardRefs.current.get(setId)!;
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const w = params.get("wallet");
    const s = params.get("set");
    const f = params.get("filter"); // ← deep-link from collection page: pre-populate filter
    if (w) { setInputVal(w); setWallet(w); }
    if (s) setExpandedSet(s);
    if (f) setFilterText(f);
  }, []);

  const fetchSets = useCallback(async (w: string) => {
    if (!w.trim()) return;
    setLoading(true); setError(null); setData(null); setExpandedSet(null);
    const url = new URL(window.location.href);
    url.searchParams.set("wallet", w.trim());
    window.history.pushState({}, "", url.toString());
    try {
      const res = await fetch("/api/sets?wallet=" + encodeURIComponent(w.trim()) + "&skipAsks=1");
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error ?? "Request failed (" + res.status + ")"); }
      setData(await res.json());
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (wallet) fetchSets(wallet); }, [wallet, fetchSets]);

  const handleSearch = () => { if (inputVal.trim()) setWallet(inputVal.trim()); };

  const handleSetClick = useCallback((setId: string) => {
    setExpandedSet(setId);
    setTimeout(() => {
      const ref = cardRefs.current.get(setId);
      ref?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, []);

  const handleCardClick = useCallback((setId: string) => {
    setExpandedSet((prev) => (prev === setId ? null : setId));
  }, []);

  const handlePricesLoaded = useCallback((setId: string, updated: SetProgress) => {
    setData((prev) => { if (!prev) return prev; return { ...prev, sets: prev.sets.map((s) => s.setId === setId ? updated : s) }; });
  }, []);

  const tierOrder: Record<SetTier, number> = { almost_there: 0, bottleneck: 1, completable: 2, incomplete: 3, unpriced: 4, complete: 5 };

  const displaySets = useMemo(() => {
    if (!data) return [];
    let sets = [...data.sets];
    if (filterText.trim()) { const q = filterText.toLowerCase(); sets = sets.filter((s) => s.setName.toLowerCase().includes(q)); }
    if (hideComplete) sets = sets.filter((s) => s.tier !== "complete");
    sets.sort((a, b) => {
      if (sortBy === "intelligence") { const tA = tierOrder[a.tier], tB = tierOrder[b.tier]; if (tA !== tB) return tA - tB; return b.completionPct - a.completionPct; }
      if (sortBy === "completion") return b.completionPct - a.completionPct;
      if (sortBy === "missing") return a.missingCount - b.missingCount;
      return a.setName.localeCompare(b.setName);
    });
    return sets;
  }, [data, sortBy, filterText, hideComplete]);

  const enrichedSets = useMemo(() => data?.sets.filter((s) => s.asksEnriched) ?? [], [data]);
  const summaryStats = useMemo(() => {
    if (!data) return null;
    return { almostThere: data.sets.filter((s) => s.tier === "almost_there").length, bottlenecks: data.sets.filter((s) => s.tier === "bottleneck").length };
  }, [data]);

  // Derive a "filtered for specific set" banner when a filter param was passed
  const isFilteredView = filterText.trim().length > 0 && data !== null;

  return (
    <div style={{ fontFamily: "'DM Mono','Fira Code','Courier New',monospace", color: "#e2e8f0" }}>
      <div style={{ maxWidth: 660, margin: "0 auto", padding: "18px 14px 60px" }}>
        <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em", margin: "0 0 3px" }}>Set Tracker</h1>
            <p style={{ fontSize: 11, color: "#64748b", margin: 0 }}>Track completion · identify bottlenecks · find cheapest path to complete</p>
          </div>
          {/* Clear filter banner when deep-linked from collection page */}
          {isFilteredView && (
            <button
              onClick={() => setFilterText("")}
              style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 6, padding: "5px 10px", fontSize: 10, color: "#fb923c", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}
            >
              ✕ Clear filter
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 7, marginBottom: 16 }}>
          <input type="text" placeholder="Flow address or Top Shot username..." value={inputVal}
            onChange={(e) => setInputVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "9px 12px", fontSize: 12, color: "#f1f5f9", outline: "none", fontFamily: "inherit" }} />
          <button onClick={handleSearch} disabled={loading || !inputVal.trim()}
            style={{ background: loading ? "rgba(249,115,22,0.25)" : "#f97316", border: "none", borderRadius: 7, padding: "9px 16px", fontSize: 11, fontWeight: 700, color: loading ? "rgba(255,255,255,0.4)" : "#fff", cursor: loading ? "not-allowed" : "pointer", letterSpacing: "0.05em", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {loading ? "LOADING..." : "SEARCH"}
          </button>
        </div>

        {loading && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "#475569", fontSize: 11 }}>
            <div style={{ width: 28, height: 28, border: "2px solid rgba(249,115,22,0.15)", borderTop: "2px solid #f97316", borderRadius: "50%", margin: "0 auto 10px", animation: "spin 0.7s linear infinite" }} />
            Fetching wallet data...
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {error && <div style={{ background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "12px 14px", fontSize: 11, color: "#fca5a5", marginBottom: 12 }}>⚠ {error}</div>}

        {data && !loading && summaryStats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 12 }}>
            {[
              { label: "Sets", value: data.totalSets, color: "#f1f5f9" },
              { label: "Complete", value: data.completeSets, color: "#22c55e" },
              { label: "Almost There", value: summaryStats.almostThere, color: "#22c55e" },
              { label: "Bottlenecks", value: summaryStats.bottlenecks, color: "#f59e0b" },
            ].map((s) => (
              <div key={s.label} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 7, padding: "9px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: s.color, letterSpacing: "-0.02em" }}>{s.value}</div>
                <div style={{ fontSize: 8, color: "#475569", marginTop: 1 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {enrichedSets.length > 0 && !isFilteredView && <BestOpportunityBanner sets={enrichedSets} onSetClick={handleSetClick} />}

        {data && !loading && enrichedSets.length === 0 && (
          <div style={{ background: "rgba(96,165,250,0.04)", border: "1px solid rgba(96,165,250,0.1)", borderRadius: 7, padding: "7px 12px", fontSize: 10, color: "#60a5fa", marginBottom: 12 }}>
            💡 Expand a set and tap <strong>LOAD PRICES</strong> to reveal bottlenecks and completion costs.
          </div>
        )}

        {data && !loading && (
          <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input type="text" placeholder="Filter sets..." value={filterText} onChange={(e) => setFilterText(e.target.value)}
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 5, padding: "5px 9px", fontSize: 10, color: "#e2e8f0", outline: "none", fontFamily: "inherit", width: 110 }} />
            <div style={{ display: "flex", gap: 3 }}>
              {([{ key: "intelligence", label: "Smart Sort" }, { key: "completion", label: "% Done" }, { key: "missing", label: "Fewest Missing" }, { key: "name", label: "Name" }] as const).map((opt) => (
                <button key={opt.key} onClick={() => setSortBy(opt.key)}
                  style={{ background: sortBy === opt.key ? "rgba(249,115,22,0.12)" : "rgba(255,255,255,0.03)", border: sortBy === opt.key ? "1px solid rgba(249,115,22,0.3)" : "1px solid rgba(255,255,255,0.07)", borderRadius: 5, padding: "4px 7px", fontSize: 9, color: sortBy === opt.key ? "#fb923c" : "#64748b", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.03em", whiteSpace: "nowrap" }}>
                  {opt.label}
                </button>
              ))}
            </div>
            <button onClick={() => setHideComplete((v) => !v)}
              style={{ background: hideComplete ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.03)", border: hideComplete ? "1px solid rgba(34,197,94,0.2)" : "1px solid rgba(255,255,255,0.07)", borderRadius: 5, padding: "4px 7px", fontSize: 9, color: hideComplete ? "#22c55e" : "#64748b", cursor: "pointer", fontFamily: "inherit" }}>
              {hideComplete ? "✓ Hide Complete" : "Hide Complete"}
            </button>
            <span style={{ fontSize: 9, color: "#334155", marginLeft: "auto" }}>{displaySets.length} sets</span>
          </div>
        )}

        {data && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {displaySets.length === 0
              ? <div style={{ textAlign: "center", padding: "40px 0", fontSize: 11, color: "#334155" }}>
                  {isFilteredView ? (
                    <>No sets match "{filterText}" — <button onClick={() => setFilterText("")} style={{ background: "none", border: "none", color: "#60a5fa", cursor: "pointer", fontSize: 11, fontFamily: "inherit", textDecoration: "underline" }}>clear filter</button></>
                  ) : "No sets match your filters"}
                </div>
              : displaySets.map((set) => (
                <SetCard key={set.setId} set={set} wallet={wallet} expanded={expandedSet === set.setId}
                  onClick={() => handleCardClick(set.setId)} onPricesLoaded={handlePricesLoaded} cardRef={getCardRef(set.setId)} />
              ))}
          </div>
        )}

        {!data && !loading && !error && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#1e293b" }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>🏀</div>
            <div style={{ fontSize: 11 }}>Enter a wallet to track set completion</div>
          </div>
        )}
      </div>
    </div>
  );
}