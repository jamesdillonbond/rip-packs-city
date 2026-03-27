"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MissingPiece {
  playId: string;
  playerName: string;
  jerseyNumber: string | null;
  tier: string;
  circulationCount: number | null;
  lowestAsk: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
}

interface OwnedPiece {
  playId: string;
  playerName: string;
  jerseyNumber: string | null;
  tier: string;
  serialNumber: number;
  thumbnailUrl: string | null;
  listedPrice: number | null;
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
}

interface SetsResponse {
  wallet: string;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    <div
      style={{
        width: "100%",
        height: 6,
        background: "rgba(255,255,255,0.08)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: pct + "%",
          height: "100%",
          background: complete
            ? "linear-gradient(90deg, #22c55e, #16a34a)"
            : "linear-gradient(90deg, #f97316, #fb923c)",
          borderRadius: 4,
          transition: "width 0.6s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </div>
  );
}

function PieceThumb({
  url,
  alt,
  owned,
}: {
  url: string | null;
  alt: string;
  owned: boolean;
}) {
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 6,
        overflow: "hidden",
        border: owned ? "2px solid #22c55e" : "2px solid rgba(255,255,255,0.12)",
        background: "#1a1a2e",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: owned ? "none" : "grayscale(80%) opacity(0.5)",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "rgba(255,255,255,0.04)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "#444",
          }}
        >
          ?
        </div>
      )}
      {!owned && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.3)",
          }}
        />
      )}
    </div>
  );
}

function SetCard({
  set,
  onClick,
  expanded,
}: {
  set: SetProgress;
  onClick: () => void;
  expanded: boolean;
}) {
  const complete = set.completionPct === 100;

  return (
    <div
      style={{
        background: expanded
          ? "rgba(255,255,255,0.06)"
          : "rgba(255,255,255,0.03)",
        border: complete
          ? "1px solid rgba(34,197,94,0.35)"
          : expanded
          ? "1px solid rgba(249,115,22,0.4)"
          : "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        overflow: "hidden",
        transition: "all 0.2s ease",
        cursor: "pointer",
      }}
      onClick={onClick}
    >
      {/* Card header */}
      <div
        style={{
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        {/* Completion badge */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: complete
              ? "rgba(34,197,94,0.15)"
              : "rgba(249,115,22,0.1)",
            border: complete
              ? "1px solid rgba(34,197,94,0.3)"
              : "1px solid rgba(249,115,22,0.2)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: complete ? "#22c55e" : "#f97316",
              lineHeight: 1,
            }}
          >
            {set.completionPct}
          </span>
          <span
            style={{ fontSize: 9, color: complete ? "#22c55e" : "#f97316", opacity: 0.8 }}
          >
            %
          </span>
        </div>

        {/* Set info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#f1f5f9",
              letterSpacing: "0.01em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginBottom: 3,
            }}
          >
            {set.setName}
          </div>
          <div style={{ marginBottom: 6 }}>
            <ProgressBar pct={set.completionPct} complete={complete} />
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>
              <span style={{ color: "#22c55e", fontWeight: 600 }}>
                {set.ownedCount}
              </span>
              /{set.totalEditions} owned
            </span>
            {!complete && (
              <>
                <span style={{ color: "rgba(255,255,255,0.15)", fontSize: 11 }}>·</span>
                <span style={{ fontSize: 11, color: "#94a3b8" }}>
                  {set.missingCount} missing
                </span>
              </>
            )}
          </div>
        </div>

        {/* Cost info */}
        {!complete && (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            {set.totalMissingCost !== null ? (
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#fb923c",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {fmt$(set.totalMissingCost)}
                </div>
                <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>
                  to complete
                </div>
              </div>
            ) : set.lowestSingleAsk !== null ? (
              <div>
                <div style={{ fontSize: 11, color: "#64748b" }}>lowest</div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#60a5fa",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {fmt$(set.lowestSingleAsk)}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {complete && (
          <div
            style={{
              background: "rgba(34,197,94,0.15)",
              border: "1px solid rgba(34,197,94,0.3)",
              borderRadius: 20,
              padding: "3px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "#22c55e",
              flexShrink: 0,
            }}
          >
            ✓ COMPLETE
          </div>
        )}

        {/* Chevron */}
        <div
          style={{
            color: "#475569",
            fontSize: 12,
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
          }}
        >
          ▼
        </div>
      </div>

      {/* Expanded checklist */}
      {expanded && (
        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.06)",
            padding: "12px 16px 16px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Missing pieces section */}
          {set.missing.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: "#f97316",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                Missing — {set.missingCount} pieces
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {set.missing.map((piece) => (
                  <a
                    key={piece.playId}
                    href={piece.topshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      background: "rgba(249,115,22,0.04)",
                      border: "1px solid rgba(249,115,22,0.1)",
                      borderRadius: 8,
                      textDecoration: "none",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "rgba(249,115,22,0.09)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "rgba(249,115,22,0.04)")
                    }
                  >
                    <PieceThumb
                      url={piece.thumbnailUrl}
                      alt={piece.playerName}
                      owned={false}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#e2e8f0",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {piece.playerName}
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2 }}>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            color: tierColor(piece.tier),
                            background:
                              tierColor(piece.tier) + "22",
                            padding: "1px 5px",
                            borderRadius: 4,
                            letterSpacing: "0.05em",
                          }}
                        >
                          {tierLabel(piece.tier)}
                        </span>
                        {piece.circulationCount && (
                          <span style={{ fontSize: 10, color: "#64748b" }}>
                            /{piece.circulationCount}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      {piece.lowestAsk !== null ? (
                        <div>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: "#fb923c",
                              letterSpacing: "-0.01em",
                            }}
                          >
                            {fmt$(piece.lowestAsk)}
                          </div>
                          <div style={{ fontSize: 9, color: "#64748b" }}>low ask</div>
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: "#475569" }}>No listing</div>
                      )}
                    </div>
                    <div style={{ color: "#475569", fontSize: 11, flexShrink: 0 }}>↗</div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Owned pieces section */}
          {set.owned.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: "#22c55e",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                Owned — {set.ownedCount} pieces
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                  gap: 6,
                }}
              >
                {set.owned.map((piece) => (
                  <a
                    key={piece.playId}
                    href={piece.topshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 9px",
                      background: "rgba(34,197,94,0.04)",
                      border: "1px solid rgba(34,197,94,0.12)",
                      borderRadius: 8,
                      textDecoration: "none",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "rgba(34,197,94,0.08)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "rgba(34,197,94,0.04)")
                    }
                  >
                    <PieceThumb
                      url={piece.thumbnailUrl}
                      alt={piece.playerName}
                      owned={true}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#d1fae5",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {piece.playerName.split(" ").slice(-1)[0]}
                      </div>
                      <div style={{ fontSize: 10, color: "#4ade80", opacity: 0.7 }}>
                        #{piece.serialNumber}
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
  const [wallet, setWallet] = useState("");
  const [inputVal, setInputVal] = useState("");
  const [data, setData] = useState<SetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSet, setExpandedSet] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"completion" | "cost" | "name" | "missing">(
    "completion"
  );
  const [filterText, setFilterText] = useState("");
  const [hideComplete, setHideComplete] = useState(false);

  // Load wallet from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const w = params.get("wallet");
    if (w) {
      setInputVal(w);
      setWallet(w);
    }
  }, []);

  const fetchSets = useCallback(async (w: string) => {
    if (!w.trim()) return;
    setLoading(true);
    setError(null);
    setData(null);
    setExpandedSet(null);

    // Update URL
    const url = new URL(window.location.href);
    url.searchParams.set("wallet", w.trim());
    window.history.pushState({}, "", url.toString());

    try {
      const res = await fetch(
        "/api/sets?wallet=" + encodeURIComponent(w.trim())
      );
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

  // Sort + filter
  const displaySets = useMemo(() => {
    if (!data) return [];
    let sets = [...data.sets];

    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      sets = sets.filter((s) => s.setName.toLowerCase().includes(q));
    }

    if (hideComplete) {
      sets = sets.filter((s) => s.completionPct < 100);
    }

    sets.sort((a, b) => {
      if (sortBy === "completion") return b.completionPct - a.completionPct;
      if (sortBy === "cost") {
        if (a.totalMissingCost !== null && b.totalMissingCost !== null)
          return a.totalMissingCost - b.totalMissingCost;
        if (a.totalMissingCost !== null) return -1;
        if (b.totalMissingCost !== null) return 1;
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
    const cheapestSet = [...data.sets]
      .filter((s) => s.totalMissingCost !== null && s.missingCount > 0)
      .sort((a, b) => (a.totalMissingCost ?? 0) - (b.totalMissingCost ?? 0))[0];
    return { totalOwned, totalEditions, cheapestSet };
  }, [data]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a14",
        fontFamily:
          "'DM Mono', 'Fira Code', 'Courier New', monospace",
        color: "#e2e8f0",
      }}
    >
      {/* Nav */}
      <nav
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          gap: 16,
          background: "rgba(10,10,20,0.95)",
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <a
          href="/"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#f97316",
            textDecoration: "none",
            letterSpacing: "0.05em",
          }}
        >
          RIP PACKS CITY
        </a>
        <span style={{ color: "rgba(255,255,255,0.15)" }}>|</span>
        {[
          { label: "Wallet", href: "/wallet" },
          { label: "Packs", href: "/packs" },
          { label: "Sets", href: "/sets" },
          { label: "Sniper", href: "/sniper" },
          { label: "Badges", href: "/badges" },
          { label: "Profile", href: "/profile" },
        ].map((link) => (
          <a
            key={link.href}
            href={link.href}
            style={{
              fontSize: 12,
              color:
                link.href === "/sets" ? "#f97316" : "#94a3b8",
              textDecoration: "none",
              letterSpacing: "0.03em",
              fontWeight: link.href === "/sets" ? 600 : 400,
            }}
          >
            {link.label}
          </a>
        ))}
      </nav>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "20px 16px 60px" }}>
        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "#f1f5f9",
              letterSpacing: "-0.02em",
              margin: 0,
              marginBottom: 4,
            }}
          >
            Set Tracker
          </h1>
          <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
            Track set completion & find cheapest missing pieces
          </p>
        </div>

        {/* Search bar */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 20,
          }}
        >
          <input
            type="text"
            placeholder="Flow address or Top Shot username..."
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              color: "#f1f5f9",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={handleSearch}
            disabled={loading || !inputVal.trim()}
            style={{
              background: loading ? "rgba(249,115,22,0.3)" : "#f97316",
              border: "none",
              borderRadius: 8,
              padding: "10px 18px",
              fontSize: 12,
              fontWeight: 700,
              color: loading ? "rgba(255,255,255,0.5)" : "#fff",
              cursor: loading ? "not-allowed" : "pointer",
              letterSpacing: "0.05em",
              fontFamily: "inherit",
              transition: "all 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            {loading ? "LOADING..." : "SEARCH"}
          </button>
        </div>

        {/* Loading state */}
        {loading && (
          <div
            style={{
              textAlign: "center",
              padding: "48px 16px",
              color: "#64748b",
              fontSize: 12,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                border: "2px solid rgba(249,115,22,0.2)",
                borderTop: "2px solid #f97316",
                borderRadius: "50%",
                margin: "0 auto 12px",
                animation: "spin 0.8s linear infinite",
              }}
            />
            Fetching wallet & marketplace data...
            <br />
            <span style={{ fontSize: 10, color: "#475569" }}>
              This may take 15–30s for large wallets
            </span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div
            style={{
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 10,
              padding: "14px 16px",
              fontSize: 12,
              color: "#fca5a5",
              marginBottom: 16,
            }}
          >
            ⚠ {error}
          </div>
        )}

        {/* Summary stats */}
        {data && !loading && summaryStats && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
              marginBottom: 16,
            }}
          >
            {[
              {
                label: "Sets Tracked",
                value: data.totalSets,
                color: "#f1f5f9",
              },
              {
                label: "Complete",
                value: data.completeSets,
                color: "#22c55e",
              },
              {
                label: "Total Owned",
                value: summaryStats.totalOwned + "/" + summaryStats.totalEditions,
                color: "#60a5fa",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: stat.color,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {stat.value}
                </div>
                <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Cheapest to complete callout */}
        {summaryStats?.cheapestSet && (
          <div
            style={{
              background: "rgba(249,115,22,0.06)",
              border: "1px solid rgba(249,115,22,0.2)",
              borderRadius: 10,
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
              cursor: "pointer",
            }}
            onClick={() =>
              setExpandedSet(
                expandedSet === summaryStats.cheapestSet!.setId
                  ? null
                  : summaryStats.cheapestSet!.setId
              )
            }
          >
            <div style={{ fontSize: 18 }}>🎯</div>
            <div>
              <div style={{ fontSize: 11, color: "#f97316", fontWeight: 600 }}>
                Closest to completing cheaply
              </div>
              <div style={{ fontSize: 12, color: "#e2e8f0" }}>
                {summaryStats.cheapestSet.setName} —{" "}
                <span style={{ color: "#fb923c", fontWeight: 700 }}>
                  {fmt$(summaryStats.cheapestSet.totalMissingCost)}
                </span>{" "}
                for {summaryStats.cheapestSet.missingCount} missing pieces
              </div>
            </div>
          </div>
        )}

        {/* Controls */}
        {data && !loading && (
          <div
            style={{
              display: "flex",
              gap: 8,
              marginBottom: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {/* Search filter */}
            <input
              type="text"
              placeholder="Filter sets..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 11,
                color: "#e2e8f0",
                outline: "none",
                fontFamily: "inherit",
                width: 140,
              }}
            />

            {/* Sort buttons */}
            <div style={{ display: "flex", gap: 4 }}>
              {(
                [
                  { key: "completion", label: "% Done" },
                  { key: "cost", label: "Cheapest" },
                  { key: "missing", label: "Fewest Missing" },
                  { key: "name", label: "Name" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSortBy(opt.key)}
                  style={{
                    background:
                      sortBy === opt.key
                        ? "rgba(249,115,22,0.2)"
                        : "rgba(255,255,255,0.04)",
                    border:
                      sortBy === opt.key
                        ? "1px solid rgba(249,115,22,0.4)"
                        : "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 6,
                    padding: "5px 9px",
                    fontSize: 10,
                    color: sortBy === opt.key ? "#fb923c" : "#94a3b8",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    letterSpacing: "0.03em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Hide complete toggle */}
            <button
              onClick={() => setHideComplete((v) => !v)}
              style={{
                background: hideComplete
                  ? "rgba(34,197,94,0.15)"
                  : "rgba(255,255,255,0.04)",
                border: hideComplete
                  ? "1px solid rgba(34,197,94,0.3)"
                  : "1px solid rgba(255,255,255,0.08)",
                borderRadius: 6,
                padding: "5px 9px",
                fontSize: 10,
                color: hideComplete ? "#22c55e" : "#94a3b8",
                cursor: "pointer",
                fontFamily: "inherit",
                letterSpacing: "0.03em",
              }}
            >
              {hideComplete ? "✓ Hide Complete" : "Hide Complete"}
            </button>

            <span style={{ fontSize: 10, color: "#475569", marginLeft: "auto" }}>
              {displaySets.length} sets
            </span>
          </div>
        )}

        {/* Sets list */}
        {data && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {displaySets.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "40px 16px",
                  fontSize: 12,
                  color: "#475569",
                }}
              >
                No sets match your filters
              </div>
            ) : (
              displaySets.map((set) => (
                <SetCard
                  key={set.setId}
                  set={set}
                  expanded={expandedSet === set.setId}
                  onClick={() =>
                    setExpandedSet(
                      expandedSet === set.setId ? null : set.setId
                    )
                  }
                />
              ))
            )}
          </div>
        )}

        {/* Empty state */}
        {!data && !loading && !error && (
          <div
            style={{
              textAlign: "center",
              padding: "60px 16px",
              color: "#334155",
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>🏀</div>
            <div style={{ fontSize: 13 }}>
              Enter a wallet to see set completion
            </div>
          </div>
        )}
      </div>
    </div>
  );
}