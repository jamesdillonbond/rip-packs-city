"use client";

// components/HotEditions24h.tsx
//
// Top-volume editions over the last 24h. Collection-filterable via dropdown
// (default: all). Reads /api/market/hot-editions, which proxies the
// get_hot_editions_24h(slug, limit) SECDEF RPC.

import { useEffect, useMemo, useState } from "react";

const COLLECTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All Collections" },
  { value: "nba_top_shot", label: "NBA Top Shot" },
  { value: "nfl_all_day", label: "NFL All Day" },
  { value: "laliga_golazos", label: "LaLiga Golazos" },
  { value: "disney_pinnacle", label: "Disney Pinnacle" },
  { value: "ufc_strike", label: "UFC Strike" },
];

const COLLECTION_LABEL: Record<string, string> = {
  nba_top_shot: "Top Shot",
  nfl_all_day: "All Day",
  laliga_golazos: "Golazos",
  disney_pinnacle: "Pinnacle",
  ufc_strike: "Strike",
};

interface HotEdition {
  edition_id: string;
  edition_key: string | null;
  collection: string;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  sales_24h: number;
  volume_24h_usd: number;
  avg_price_24h: number;
  min_price_24h: number;
  max_price_24h: number;
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function HotEditions24h() {
  const [slug, setSlug] = useState<string>("");
  const [editions, setEditions] = useState<HotEdition[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ limit: "10" });
    if (slug) qs.set("slug", slug);
    fetch(`/api/market/hot-editions?${qs.toString()}`, { credentials: "include" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || j.error) {
          setErr(j.error ?? `HTTP ${res.status}`);
          setEditions([]);
        } else {
          setEditions(j.editions ?? []);
          setErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setEditions([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const rows = useMemo(() => editions ?? [], [editions]);

  return (
    <section className="rpc-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div className="rpc-section-title">Hot Editions · 24h</div>
        <select
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          aria-label="Collection filter"
          style={{
            padding: "6px 8px",
            background: "#0d0d0d",
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 6,
            color: "#fff",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          {COLLECTION_OPTIONS.map((opt) => (
            <option key={opt.value || "all"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {err && (
        <div style={{ color: "#F87171", fontFamily: "var(--font-mono)", fontSize: 11, marginBottom: 8 }}>
          {err}
        </div>
      )}

      {loading && !editions ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          No sales in the last 24h.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
                <th style={thStyle}>Player</th>
                <th style={thStyle}>Set</th>
                <th style={thStyle}>Tier</th>
                {!slug && <th style={thStyle}>Collection</th>}
                <th style={{ ...thStyle, textAlign: "right" }}>Sales</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Volume</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Avg</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.edition_id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={tdStyle}>{r.player_name ?? "—"}</td>
                  <td style={{ ...tdStyle, color: "rgba(255,255,255,0.7)" }}>{r.set_name ?? "—"}</td>
                  <td style={tdStyle}>{r.tier ?? "—"}</td>
                  {!slug && (
                    <td style={{ ...tdStyle, color: "rgba(255,255,255,0.6)" }}>
                      {COLLECTION_LABEL[r.collection] ?? r.collection}
                    </td>
                  )}
                  <td style={{ ...tdStyle, textAlign: "right" }}>{r.sales_24h}</td>
                  <td style={{ ...tdStyle, textAlign: "right", color: "#34D399" }}>{fmtCurrency(r.volume_24h_usd)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{fmtCurrency(r.avg_price_24h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  color: "rgba(255,255,255,0.5)",
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 8px",
  color: "#fff",
  whiteSpace: "nowrap",
};
