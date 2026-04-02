"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  type PinnacleSniperDeal,
  type PinnacleVariant,
  type PinnacleFranchise,
  PINNACLE_VARIANT_COLORS,
} from "@/lib/pinnacle/pinnacleTypes";

// ── Types ───────────────────────────────────────────────────────────────────

interface FeedResult {
  count: number;
  flowtyTotal: number;
  fmvCoverage: number;
  lastRefreshed: string;
  deals: PinnacleSniperDeal[];
}

type SortOption = "price_asc" | "price_desc" | "discount";

// ── Constants ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 30;
const ACCENT = "#A855F7";

const FRANCHISE_TABS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "Disney", label: "Disney" },
  { value: "Pixar", label: "Pixar" },
  { value: "Star Wars", label: "Star Wars" },
];

const VARIANT_OPTIONS: PinnacleVariant[] = [
  "Standard",
  "Brushed Silver",
  "Silver Sparkle",
  "Radiant Chrome",
  "Luxe Marble",
  "Golden",
  "Digital Display",
  "Color Splash",
  "Colored Enamel",
  "Embellished Enamel",
  "Apex",
  "Quartis",
  "Quinova",
  "Xenith",
  "Limited Edition",
  "Limited Event Edition",
  "Legendary Edition",
  "Open Event Edition",
  "Starter Edition",
];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "price_asc", label: "Cheapest First" },
  { value: "price_desc", label: "Most Expensive" },
  { value: "discount", label: "Best Discount" },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function VariantPill({ variant }: { variant: PinnacleVariant }) {
  const color = PINNACLE_VARIANT_COLORS[variant] ?? "#6B7280";
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-xs"
      style={{
        background: `${color}18`,
        border: `1px solid ${color}44`,
        color,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.05em",
      }}
    >
      {variant}
    </span>
  );
}

function ChaserBadge() {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-xs"
      style={{
        background: "rgba(251,191,36,0.15)",
        border: "1px solid rgba(251,191,36,0.4)",
        color: "#FBBF24",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.1em",
        fontWeight: 700,
      }}
    >
      CHASER
    </span>
  );
}

function LockIcon() {
  return (
    <span
      title="Pin is locked (maturity date in the future)"
      style={{ color: "var(--rpc-text-ghost)", fontSize: 14, cursor: "help" }}
    >
      🔒
    </span>
  );
}

function FranchiseIcon({ franchise }: { franchise: PinnacleFranchise }) {
  switch (franchise) {
    case "Disney": return <span title="Disney">🏰</span>;
    case "Pixar": return <span title="Pixar">🎬</span>;
    case "Star Wars": return <span title="Star Wars">⚔️</span>;
    default: return <span title="Unknown">📌</span>;
  }
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function PinnacleSniperPage() {
  const [data, setData] = useState<FeedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [paused, setPaused] = useState(false);

  // Filters
  const [franchiseTab, setFranchiseTab] = useState("all");
  const [variantFilter, setVariantFilter] = useState("all");
  const [maxPrice, setMaxPrice] = useState(0);
  const [sortBy, setSortBy] = useState<SortOption>("price_asc");
  const [chaserOnly, setChaserOnly] = useState(false);
  const [search, setSearch] = useState("");

  const countdownRef = useRef<NodeJS.Timeout | null>(null);

  const buildFeedUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (variantFilter !== "all") params.set("variant", variantFilter);
    if (franchiseTab !== "all") params.set("franchise", franchiseTab);
    if (maxPrice > 0) params.set("maxPrice", String(maxPrice));
    if (chaserOnly) params.set("chaserOnly", "true");
    params.set("sortBy", sortBy);
    return `/api/pinnacle-sniper-feed?${params}`;
  }, [variantFilter, franchiseTab, maxPrice, chaserOnly, sortBy]);

  const fetchFeed = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(buildFeedUrl(), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: FeedResult = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [buildFeedUrl]);

  useEffect(() => {
    fetchFeed();
    setCountdown(REFRESH_INTERVAL);
  }, [fetchFeed]);

  useEffect(() => {
    if (paused) return;
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { fetchFeed(); return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current!);
  }, [paused, fetchFeed]);

  // Client-side search filter
  const visibleDeals = (data?.deals ?? []).filter((d) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      d.characterName.toLowerCase().includes(q) ||
      d.setName.toLowerCase().includes(q) ||
      d.editionType.toLowerCase().includes(q)
    );
  });

  const stats = {
    total: visibleDeals.length,
    locked: visibleDeals.filter((d) => d.isLocked).length,
    chasers: visibleDeals.filter((d) => d.isChaser).length,
    special: visibleDeals.filter((d) => d.isSpecialSerial).length,
    withFmv: visibleDeals.filter((d) => d.confidence !== "NO_DATA").length,
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      {/* ── Header ── */}
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)", padding: "16px" }}>
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="rpc-heading flex items-center gap-2" style={{ fontSize: "var(--text-xl)" }}>
                <span style={{ fontSize: "var(--text-2xl)" }}>✨</span> PINNACLE SNIPER
              </h1>
              <p className="rpc-label" style={{ marginTop: 2 }}>
                LIVE DISNEY PINNACLE PIN DEALS FROM FLOWTY
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="rpc-chip" style={
                (data?.flowtyTotal ?? 0) > 0
                  ? { background: "rgba(59,130,246,0.08)", borderColor: "rgba(59,130,246,0.3)", color: "var(--rpc-info)" }
                  : { background: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.2)", color: "var(--rpc-danger)" }
              }>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${(data?.flowtyTotal ?? 0) > 0 ? "bg-blue-400 animate-pulse" : "bg-red-400/50"}`} style={{ marginRight: 4 }} />
                FLOWTY {(data?.flowtyTotal ?? 0) > 0 ? `(${data?.flowtyTotal})` : "OFFLINE"}
              </span>
              <button
                onClick={() => setPaused((p) => !p)}
                className="rpc-chip"
              >
                {paused ? "▶ RESUME" : `⏸ ${countdown}s`}
              </button>
              <button
                onClick={() => { fetchFeed(); setCountdown(REFRESH_INTERVAL); }}
                disabled={loading}
                className="rpc-btn-ghost"
                style={{ opacity: loading ? 0.5 : 1, borderColor: `${ACCENT}40`, color: ACCENT }}
              >
                {loading ? "↻" : "↻ REFRESH"}
              </button>
            </div>
          </div>

          {/* ── Franchise pills ── */}
          <div className="flex items-center gap-1 mb-4 flex-wrap">
            {FRANCHISE_TABS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFranchiseTab(f.value)}
                className={`rpc-chip ${franchiseTab === f.value ? "active" : ""}`}
                style={franchiseTab === f.value
                  ? { textTransform: "uppercase", background: `${ACCENT}1A`, borderColor: `${ACCENT}66`, color: ACCENT }
                  : { textTransform: "uppercase" }
                }
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* ── Filters row ── */}
          <div className="flex flex-wrap items-center gap-3" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
            <label className="flex items-center gap-1.5" style={{ color: "var(--rpc-text-muted)" }}>
              <span>VARIANT</span>
              <select
                value={variantFilter}
                onChange={(e) => setVariantFilter(e.target.value)}
                style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 10px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
              >
                <option value="all">All Variants</option>
                {VARIANT_OPTIONS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>

            <input
              type="text"
              placeholder="Search character, set..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", width: 200, outline: "none" }}
            />

            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
              <span>MAX $</span>
              <input
                type="number"
                min={0} step={1}
                value={maxPrice || ""}
                onChange={(e) => setMaxPrice(Number(e.target.value))}
                placeholder="any"
                style={{ width: 72, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
              />
            </label>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
              <input
                type="checkbox"
                checked={chaserOnly}
                onChange={(e) => setChaserOnly(e.target.checked)}
              />
              CHASERS ONLY
            </label>
          </div>
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface-raised)", padding: "8px 16px" }}>
        <div className="rpc-mono flex items-center gap-6 flex-wrap" style={{ maxWidth: "var(--max-width)", margin: "0 auto", color: "var(--rpc-text-muted)" }}>
          <span><span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{stats.total}</span> pins</span>
          {stats.chasers > 0 && (
            <span><span style={{ color: "#FBBF24", fontWeight: 600 }}>{stats.chasers}</span> chasers</span>
          )}
          {stats.special > 0 && (
            <span><span style={{ color: "#c084fc", fontWeight: 600 }}>{stats.special}</span> special serials</span>
          )}
          {stats.locked > 0 && (
            <span><span style={{ color: "var(--rpc-text-ghost)", fontWeight: 600 }}>{stats.locked}</span> locked</span>
          )}
          <span><span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{stats.withFmv}</span> with FMV</span>
          {data?.lastRefreshed && (
            <span className="ml-auto">
              updated {new Date(data.lastRefreshed).toLocaleTimeString([], {
                hour: "2-digit", minute: "2-digit", second: "2-digit",
              })}
            </span>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{ maxWidth: "var(--max-width)", margin: "0 auto", padding: "16px" }}>
        {error && (
          <div className="rpc-hud" style={{ marginBottom: 16, borderColor: "var(--rpc-danger)", color: "var(--rpc-danger)", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)" }}>
            FEED ERROR: {error}
          </div>
        )}

        {loading && !data && (
          <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            {[100, 85, 70, 55, 40].map((w, i) => (
              <div key={i} className="rpc-skeleton" style={{ width: `${w}%`, height: 14, opacity: 1 - i * 0.15 }} />
            ))}
            <p className="rpc-label" style={{ marginTop: 12 }}>SCANNING THE MARKETPLACE...</p>
          </div>
        )}

        {!loading && visibleDeals.length === 0 && data && (
          <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
            <span style={{ fontSize: 40, opacity: 0.3 }}>📌</span>
            <p className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>NO PINS FOUND</p>
            <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)" }}>No deals match your filters. Try widening your search.</p>
            <button
              onClick={() => {
                setFranchiseTab("all"); setVariantFilter("all"); setMaxPrice(0);
                setChaserOnly(false); setSearch("");
              }}
              className="rpc-btn-ghost" style={{ marginTop: 8, borderColor: `${ACCENT}66`, color: ACCENT }}
            >
              CLEAR FILTERS
            </button>
          </div>
        )}

        {visibleDeals.length > 0 && (
          <div className="rpc-card" style={{ overflow: "auto", borderRadius: "var(--radius-md)" }}>
            <table style={{ width: "100%", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)" }}>
                  <th className="rpc-label" style={{ textAlign: "left", padding: "10px 12px", width: 32 }} />
                  <th className="rpc-label" style={{ textAlign: "left", padding: "10px 12px" }}>Pin</th>
                  <th className="rpc-label" style={{ textAlign: "left", padding: "10px 12px" }}>Variant</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Serial</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Ask</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Adj. FMV</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Discount</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleDeals.map((deal) => (
                  <tr
                    key={`${deal.flowId}-${deal.listingResourceID}`}
                    style={{ borderBottom: "1px solid var(--rpc-border)", transition: "background var(--transition-fast)", background: "transparent" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--rpc-surface-hover)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    {/* Franchise icon */}
                    <td style={{ padding: "8px 12px", fontSize: 16 }}>
                      <FranchiseIcon franchise={deal.franchise} />
                    </td>

                    {/* Pin info */}
                    <td style={{ padding: "8px 12px" }}>
                      <div className="flex items-center gap-2">
                        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)", lineHeight: 1.2 }}>
                          {deal.characterName}
                        </div>
                        {deal.isChaser && <ChaserBadge />}
                        {deal.isLocked && <LockIcon />}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap" style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>
                        <span style={{ color: "var(--rpc-text-muted)" }}>{deal.setName || "—"}</span>
                        {deal.editionType && (
                          <>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>{deal.editionType}</span>
                          </>
                        )}
                        {deal.seriesYear > 0 && (
                          <>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>{deal.seriesYear}</span>
                          </>
                        )}
                      </div>
                    </td>

                    {/* Variant */}
                    <td style={{ padding: "8px 12px" }}>
                      <VariantPill variant={deal.variant} />
                    </td>

                    {/* Serial */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      {deal.serial !== null ? (
                        <div className="flex flex-col items-end">
                          <span style={{ color: "var(--rpc-text-primary)" }}>#{deal.serial}</span>
                          {deal.mintCount > 0 && (
                            <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
                              /{deal.mintCount}
                            </span>
                          )}
                          {deal.isSpecialSerial && deal.serialSignal && (
                            <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.15)", borderColor: "rgba(168,85,247,0.3)", color: "#c084fc", marginTop: 2 }}>
                              {deal.serialSignal}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: "var(--rpc-text-ghost)" }}>—</span>
                      )}
                    </td>

                    {/* Ask price */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>
                        ${fmt(deal.askPrice)}
                      </span>
                    </td>

                    {/* Adjusted FMV */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      {deal.confidence !== "NO_DATA" ? (
                        <span style={{ color: "var(--rpc-text-secondary)" }}>
                          ${fmt(deal.adjustedFmv)}
                        </span>
                      ) : (
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", fontStyle: "italic" }}>
                          FMV pending
                        </span>
                      )}
                    </td>

                    {/* Discount */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      {deal.confidence !== "NO_DATA" && deal.discount !== 0 ? (
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs ${
                            deal.discount >= 50 ? "bg-red-500/20 text-red-300 border border-red-500/40"
                            : deal.discount >= 30 ? "bg-orange-500/20 text-orange-300 border border-orange-500/40"
                            : deal.discount >= 15 ? "bg-yellow-500/20 text-yellow-300 border border-yellow-500/40"
                            : deal.discount >= 5 ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                            : "border"
                          }`}
                        >
                          {deal.discount > 0 ? "−" : "+"}{Math.abs(deal.discount)}%
                        </span>
                      ) : (
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", fontStyle: "italic" }}>
                          —
                        </span>
                      )}
                    </td>

                    {/* Action */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <a
                        href={deal.buyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rpc-chip"
                        style={{
                          background: "rgba(59,130,246,0.15)",
                          borderColor: "rgba(59,130,246,0.4)",
                          color: "var(--rpc-info)",
                          textDecoration: "none",
                          padding: "4px 12px",
                        }}
                      >
                        FLOWTY →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
