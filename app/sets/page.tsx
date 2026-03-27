"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  completionPct: number;
  totalMissingCost: number | null;
  lowestSingleAsk: number | null;
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

// ─── Constants ────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  LEGENDARY: "#f59e0b",
  RARE: "#8b5cf6",
  FANDOM: "#3b82f6",
  COMMON: "#6b7280",
  ULTIMATE: "#ef4444",
};

const TIER_LABELS: Record<string, string> = {
  LEGENDARY: "LEG",
  RARE: "RARE",
  FANDOM: "FAN",
  COMMON: "CMN",
  ULTIMATE: "ULT",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
  return "$" + n.toFixed(2);
}

function tierColor(tier: string): string {
  return TIER_COLORS[tier?.toUpperCase()] ?? "#6b7280";
}

function tierLabel(tier: string): string {
  return TIER_LABELS[tier?.toUpperCase()] ?? tier?.slice(0, 3).toUpperCase();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressBar({ pct, complete }: { pct: number; complete: boolean }) {
  return (
    <div style={{ width: "100%", height: 5, background: "rgba(255,255,255,0.07)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{
        width: pct + "%", height: "100%", borderRadius: 4,
        background: complete
          ? "linear-gradient(90deg,#22c55e,#16a34a)"
          : "linear-gradient(90deg,#f97316,#fb923c)",
        transition: "width 0.6s cubic-bezier(.4,0,.2,1)",
      }} />
    </div>
  );
}

function PricesButton({
  setId, wallet, enriched, loading, onLoaded
}: {
  setId: string;
  wallet: string;
  enriched: boolean;
  loading: boolean;
  onLoaded: (setId: string, missing: MissingPiece[]) => void;
}) {
  if (enriched) return null;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(
        "/api/sets?wallet=" + encodeURIComponent(wallet) +
        "&set=" + encodeURIComponent(setId)
      );
      if (!res.ok) return;
      const data: SetsResponse = await res.json();
      const updated = data.sets.find((s) => s.setId === setId);
      if (updated) onLoaded(setId, updated.missing);
    } catch {
      // silent
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      style={{
        background: loading ? "rgba(96,165,250,0.1)" : "rgba(96,165,250,0.12)",
        border: "1px solid rgba(96,165,250,0.25)",
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: 10,
        fontWeight: 600,
        color: loading ? "#475569" : "#60a5fa",
        cursor: loading ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        letterSpacing: "0.05em",
        flexShrink: 0,
        transition: "all 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {loading ? "loading…" : "LOAD PRICES"}
    </button>
  );
}

function SetCard({
  set,
  wallet,
  expanded,
  onClick,
  onPricesLoaded,
}: {
  set: SetProgress;
  wallet: string;
  expanded: boolean;
  onClick: () => void;
  onPricesLoaded: (setId: string, missing: MissingPiece[]) => void;
}) {
  const [pricesLoading, setPricesLoading] = useState(false);
  const complete = set.completionPct === 100;

  const handleLoadPrices = async (setId: string, missing: MissingPiece[]) => {
    setPricesLoading(false);
    onPricesLoaded(setId, missing);
  };

  const handlePricesClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPricesLoading(true);
    try {
      const res = await fetch(
        "/api/sets?wallet=" + encodeURIComponent(wallet) +
        "&set=" + encodeURIComponent(set.setId)
      );
      if (!res.ok) return;
      const data: SetsResponse = await res.json();
      const updated = data.sets.find((s) => s.setId === set.setId);
      if (updated) handleLoadPrices(set.setId, updated.missing);
    } catch {
      setPricesLoading(false);
    }
  };

  return (
    <div
      style={{
        background: expanded ? "rgba(255,255,255,0.055)" : "rgba(255,255,255,0.025)",
        border: complete
          ? "1px solid rgba(34,197,94,0.3)"
          : expanded
            ? "1px solid rgba(249,115,22,0.35)"
            : "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10,
        overflow: "hidden",
        transition: "all 0.15s ease",
        cursor: "pointer",
      }}
      onClick={onClick}
    >
      {/* Header */}
      <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        {/* % badge */}
        <div style={{
          width: 44, height: 44, borderRadius: 8, flexShrink: 0,
          background: complete ? "rgba(34,197,94,0.12)" : "rgba(249,115,22,0.08)",
          border: complete ? "1px solid rgba(34,197,94,0.25)" : "1px solid rgba(249,115,22,0.15)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: complete ? "#22c55e" : "#f97316", lineHeight: 1 }}>
            {set.completionPct}
          </span>
          <span style={{ fontSize: 8, color: complete ? "#22c55e" : "#f97316", opacity: 0.7 }}>%</span>
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: "#f1f5f9",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4,
          }}>
            {set.setName}
          </div>
          <ProgressBar pct={set.completionPct} complete={complete} />
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: "#94a3b8" }}>
              <span style={{ color: "#22c55e", fontWeight: 600 }}>{set.ownedCount}</span>
              /{set.totalEditions}
            </span>
            {!complete && (
              <>
                <span style={{ color: "rgba(255,255,255,0.12)", fontSize: 10 }}>·</span>
                <span style={{ fontSize: 10, color: "#64748b" }}>{set.missingCount} missing</span>
              </>
            )}
          </div>
        </div>

        {/* Right side — cost or complete badge */}
        {complete ? (
          <div style={{
            background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.25)",
            borderRadius: 16, padding: "2px 8px", fontSize: 10, fontWeight: 700,
            color: "#22c55e", flexShrink: 0,
          }}>✓ DONE</div>
        ) : !set.asksEnriched ? (
          <div onClick={handlePricesClick} style={{ flexShrink: 0 }} >
            <div style={{
              background: pricesLoading ? "rgba(96,165,250,0.05)" : "rgba(96,165,250,0.1)",
              border: "1px solid rgba(96,165,250,0.2)",
              borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 600,
              color: pricesLoading ? "#475569" : "#60a5fa",
              cursor: pricesLoading ? "not-allowed" : "pointer",
              letterSpacing: "0.05em", whiteSpace: "nowrap",
            }}>
              {pricesLoading ? "loading…" : "LOAD PRICES"}
            </div>
          </div>
        ) : set.lowestSingleAsk !== null ? (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            {set.totalMissingCost !== null ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#fb923c", letterSpacing: "-0.01em" }}>
                  {fmt$(set.totalMissingCost)}
                </div>
                <div style={{ fontSize: 9, color: "#64748b" }}>to complete</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 11, color: "#64748b" }}>from</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#60a5fa", letterSpacing: "-0.01em" }}>
                  {fmt$(set.lowestSingleAsk)}
                </div>
              </>
            )}
          </div>
        ) : null}

        {/* Chevron */}
        <div style={{
          color: "#475569", fontSize: 10, flexShrink: 0,
          transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 0.2s",
        }}>▼</div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{ borderTop: "1px solid rgba(255,255,255,0.05)", padding: "10px 14px 14px" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Missing */}
          {set.missing.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                color: "#f97316", textTransform: "uppercase", marginBottom: 6,
              }}>
                Missing — {set.missingCount} pieces
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {set.missing.map((piece) => (
                  <a
                    key={piece.playId}
                    href={piece.topshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                      background: "rgba(249,115,22,0.04)", border: "1px solid rgba(249,115,22,0.08)",
                      borderRadius: 7, textDecoration: "none", transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(249,115,22,0.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(249,115,22,0.04)")}
                  >
                    {/* Dim placeholder thumbnail */}
                    <div style={{
                      width: 32, height: 32, borderRadius: 5, flexShrink: 0,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <span style={{ fontSize: 9, color: "#334155" }}>?</span>
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 11, fontWeight: 600, color: "#e2e8f0",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {piece.playerName === "—" ? (
                          <span style={{ color: "#475569", fontStyle: "italic" }}>Unknown player</span>
                        ) : piece.playerName}
                      </div>
                      <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 1 }}>
                        <span style={{
                          fontSize: 8, fontWeight: 700, letterSpacing: "0.05em",
                          color: tierColor(piece.tier),
                          background: tierColor(piece.tier) + "20",
                          padding: "1px 4px", borderRadius: 3,
                        }}>{tierLabel(piece.tier)}</span>
                      </div>
                    </div>

                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      {!set.asksEnriched ? (
                        <span style={{ fontSize: 10, color: "#334155", fontStyle: "italic" }}>—</span>
                      ) : piece.lowestAsk !== null ? (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#fb923c", letterSpacing: "-0.01em" }}>
                            {fmt$(piece.lowestAsk)}
                          </div>
                          <div style={{ fontSize: 8, color: "#64748b" }}>low ask</div>
                        </>
                      ) : (
                        <span style={{ fontSize: 10, color: "#475569" }}>No listing</span>
                      )}
                    </div>
                    <span style={{ color: "#334155", fontSize: 10, flexShrink: 0 }}>↗</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Owned */}
          {set.owned.length > 0 && (
            <div>
              <div style={{
                fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                color: "#22c55e", textTransform: "uppercase", marginBottom: 6,
              }}>
                Owned — {set.ownedCount} pieces
              </div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                gap: 4,
              }}>
                {set.owned.map((piece) => (
                  <a
                    key={piece.playId}
                    href={piece.topshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "flex", alignItems: "center", gap: 7, padding: "6px 8px",
                      background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.1)",
                      borderRadius: 7, textDecoration: "none", transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(34,197,94,0.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(34,197,94,0.04)")}
                  >
                    {/* Thumbnail */}
                    <div style={{
                      width: 30, height: 30, borderRadius: 5, flexShrink: 0, overflow: "hidden",
                      border: "1px solid rgba(34,197,94,0.2)", background: "#0f0f1a",
                    }}>
                      {piece.thumbnailUrl ? (
                        <img src={piece.thumbnailUrl} alt={piece.playerName}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <div style={{
                          width: "100%", height: "100%",
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          <span style={{ fontSize: 8, color: "#334155" }}>✓</span>
                        </div>
                      )}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 10, fontWeight: 600, color: "#d1fae5",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {piece.playerName.split(" ").slice(-1)[0]}
                      </div>
                      <div style={{ fontSize: 9, color: "#4ade80", opacity: 0.7 }}>
                        #{piece.serialNumber ?? "?"}
                      </div>
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SetsPage() {
  const [inputVal, setInputVal] = useState("");
  const [wallet, setWallet] = useState("");
  const [data, setData] = useState<SetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSet, setExpandedSet] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"completion" | "cost" | "missing" | "name">("completion");
  const [filterText, setFilterText] = useState("");
  const [hideComplete, setHideComplete] = useState(false);

  // Load wallet from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const w = params.get("wallet");
    if (w) { setInputVal(w); setWallet(w); }
  }, []);

  const fetchSets = useCallback(async (w: string) => {
    if (!w.trim()) return;
    setLoading(true);
    setError(null);
    setData(null);
    setExpandedSet(null);

    const url = new URL(window.location.href);
    url.searchParams.set("wallet", w.trim());
    window.history.pushState({}, "", url.toString());

    try {
      // Always skipAsks=1 for fast initial load (Vercel 10s limit safe)
      const res = await fetch("/api/sets?wallet=" + encodeURIComponent(w.trim()) + "&skipAsks=1");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Request failed (" + res.status + ")");
      }
      const json: SetsResponse = await res.json();
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (wallet) fetchSets(wallet);
  }, [wallet, fetchSets]);

  const handleSearch = () => {
    if (inputVal.trim()) setWallet(inputVal.trim());
  };

  // Update prices for a specific set after lazy load
  const handlePricesLoaded = useCallback((setId: string, missing: MissingPiece[]) => {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sets: prev.sets.map((s) =>
          s.setId === setId
            ? { ...s, missing, asksEnriched: true }
            : s
        ),
      };
    });
  }, []);

  const displaySets = useMemo(() => {
    if (!data) return [];
    let sets = [...data.sets];

    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      sets = sets.filter((s) => s.setName.toLowerCase().includes(q));
    }
    if (hideComplete) sets = sets.filter((s) => s.completionPct < 100);

    sets.sort((a, b) => {
      if (sortBy === "completion") return b.completionPct - a.completionPct;
      if (sortBy === "cost") {
        if (a.lowestSingleAsk !== null && b.lowestSingleAsk !== null)
          return a.lowestSingleAsk - b.lowestSingleAsk;
        if (a.lowestSingleAsk !== null) return -1;
        if (b.lowestSingleAsk !== null) return 1;
        return 0;
      }
      if (sortBy === "missing") return a.missingCount - b.missingCount;
      return a.setName.localeCompare(b.setName);
    });

    return sets;
  }, [data, sortBy, filterText, hideComplete]);

  const summaryStats = useMemo(() => {
    if (!data) return null;
    const totalOwned = data.sets.reduce((s, x) => s + x.ownedCount, 0);
    const totalEditions = data.sets.reduce((s, x) => s + x.totalEditions, 0);
    return { totalOwned, totalEditions };
  }, [data]);

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a14",
      fontFamily: "'DM Mono','Fira Code','Courier New',monospace",
      color: "#e2e8f0",
    }}>
      {/* Nav */}
      <nav style={{
        padding: "11px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)",
        display: "flex", alignItems: "center", gap: 14,
        background: "rgba(10,10,20,0.97)", position: "sticky", top: 0, zIndex: 50,
      }}>
        <a href="/" style={{ fontSize: 12, fontWeight: 700, color: "#f97316", textDecoration: "none", letterSpacing: "0.05em" }}>
          RIP PACKS CITY
        </a>
        <span style={{ color: "rgba(255,255,255,0.12)" }}>|</span>
        {[
          { label: "Wallet", href: "/wallet" },
          { label: "Packs", href: "/packs" },
          { label: "Sets", href: "/sets" },
          { label: "Sniper", href: "/sniper" },
          { label: "Badges", href: "/badges" },
          { label: "Profile", href: "/profile" },
        ].map((link) => (
          <a key={link.href} href={link.href} style={{
            fontSize: 11, textDecoration: "none", letterSpacing: "0.03em",
            color: link.href === "/sets" ? "#f97316" : "#94a3b8",
            fontWeight: link.href === "/sets" ? 600 : 400,
          }}>
            {link.label}
          </a>
        ))}
      </nav>

      <div style={{ maxWidth: 660, margin: "0 auto", padding: "18px 14px 60px" }}>
        {/* Header */}
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em", margin: "0 0 3px" }}>
            Set Tracker
          </h1>
          <p style={{ fontSize: 11, color: "#64748b", margin: 0 }}>
            Track completion & find cheapest missing pieces
          </p>
        </div>

        {/* Search */}
        <div style={{ display: "flex", gap: 7, marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Flow address or Top Shot username..."
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{
              flex: 1, background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7,
              padding: "9px 12px", fontSize: 12, color: "#f1f5f9",
              outline: "none", fontFamily: "inherit",
            }}
          />
          <button
            onClick={handleSearch}
            disabled={loading || !inputVal.trim()}
            style={{
              background: loading ? "rgba(249,115,22,0.25)" : "#f97316",
              border: "none", borderRadius: 7, padding: "9px 16px",
              fontSize: 11, fontWeight: 700,
              color: loading ? "rgba(255,255,255,0.4)" : "#fff",
              cursor: loading ? "not-allowed" : "pointer",
              letterSpacing: "0.05em", fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            {loading ? "LOADING..." : "SEARCH"}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "#475569", fontSize: 11 }}>
            <div style={{
              width: 28, height: 28,
              border: "2px solid rgba(249,115,22,0.15)",
              borderTop: "2px solid #f97316",
              borderRadius: "50%", margin: "0 auto 10px",
              animation: "spin 0.7s linear infinite",
            }} />
            Fetching wallet data...
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)",
            borderRadius: 8, padding: "12px 14px", fontSize: 11, color: "#fca5a5", marginBottom: 12,
          }}>
            ⚠ {error}
          </div>
        )}

        {/* Summary stats */}
        {data && !loading && summaryStats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 12 }}>
            {[
              { label: "Sets", value: data.totalSets, color: "#f1f5f9" },
              { label: "Complete", value: data.completeSets, color: "#22c55e" },
              { label: "Owned", value: summaryStats.totalOwned + "/" + summaryStats.totalEditions, color: "#60a5fa" },
            ].map((s) => (
              <div key={s.label} style={{
                background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 8, padding: "10px 12px", textAlign: "center",
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: s.color, letterSpacing: "-0.02em" }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 9, color: "#475569", marginTop: 1 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Prices hint */}
        {data && !loading && (
          <div style={{
            background: "rgba(96,165,250,0.05)", border: "1px solid rgba(96,165,250,0.12)",
            borderRadius: 7, padding: "7px 12px", fontSize: 10, color: "#60a5fa",
            marginBottom: 12, display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ opacity: 0.6 }}>💡</span>
            Expand a set and tap <strong>LOAD PRICES</strong> to fetch live marketplace asks for missing pieces.
          </div>
        )}

        {/* Controls */}
        {data && !loading && (
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              placeholder="Filter sets..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 5, padding: "5px 9px", fontSize: 10, color: "#e2e8f0",
                outline: "none", fontFamily: "inherit", width: 120,
              }}
            />
            <div style={{ display: "flex", gap: 3 }}>
              {([
                { key: "completion", label: "% Done" },
                { key: "missing", label: "Fewest Missing" },
                { key: "name", label: "Name" },
              ] as const).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSortBy(opt.key)}
                  style={{
                    background: sortBy === opt.key ? "rgba(249,115,22,0.15)" : "rgba(255,255,255,0.03)",
                    border: sortBy === opt.key ? "1px solid rgba(249,115,22,0.35)" : "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 5, padding: "4px 8px", fontSize: 9,
                    color: sortBy === opt.key ? "#fb923c" : "#64748b",
                    cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.03em", whiteSpace: "nowrap",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setHideComplete((v) => !v)}
              style={{
                background: hideComplete ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.03)",
                border: hideComplete ? "1px solid rgba(34,197,94,0.25)" : "1px solid rgba(255,255,255,0.07)",
                borderRadius: 5, padding: "4px 8px", fontSize: 9,
                color: hideComplete ? "#22c55e" : "#64748b",
                cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.03em",
              }}
            >
              {hideComplete ? "✓ Hide Complete" : "Hide Complete"}
            </button>
            <span style={{ fontSize: 9, color: "#334155", marginLeft: "auto" }}>
              {displaySets.length} sets
            </span>
          </div>
        )}

        {/* Sets list */}
        {data && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {displaySets.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0", fontSize: 11, color: "#334155" }}>
                No sets match your filters
              </div>
            ) : (
              displaySets.map((set) => (
                <SetCard
                  key={set.setId}
                  set={set}
                  wallet={wallet}
                  expanded={expandedSet === set.setId}
                  onClick={() => setExpandedSet(expandedSet === set.setId ? null : set.setId)}
                  onPricesLoaded={handlePricesLoaded}
                />
              ))
            )}
          </div>
        )}

        {/* Empty state */}
        {!data && !loading && !error && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#1e293b" }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>🏀</div>
            <div style={{ fontSize: 11 }}>Enter a wallet to see set completion</div>
          </div>
        )}
      </div>
    </div>
  );
}