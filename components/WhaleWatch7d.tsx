"use client";

// components/WhaleWatch7d.tsx
//
// Top buyer wallets over the last 7d by volume. Collection-filterable via
// dropdown (default: all). Reads /api/market/whale-watch, which proxies the
// get_whale_watch_7d(slug, limit) SECDEF RPC.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

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

interface Whale {
  buyer_address: string;
  collection: string;
  purchases_7d: number;
  volume_7d_usd: number;
  avg_purchase_usd: number;
  distinct_editions: number;
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function truncAddr(addr: string): string {
  if (!addr || addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function WhaleWatch7d() {
  const [slug, setSlug] = useState<string>("");
  const [whales, setWhales] = useState<Whale[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ limit: "10" });
    if (slug) qs.set("slug", slug);
    fetch(`/api/market/whale-watch?${qs.toString()}`, { credentials: "include" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || j.error) {
          setErr(j.error ?? `HTTP ${res.status}`);
          setWhales([]);
        } else {
          setWhales(j.whales ?? []);
          setErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setWhales([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const rows = useMemo(() => whales ?? [], [whales]);

  return (
    <section className="rpc-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div className="rpc-section-title">Whale Watch · 7d</div>
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

      {loading && !whales ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          No top buyers in the last 7d.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
                <th style={thStyle}>Wallet</th>
                {!slug && <th style={thStyle}>Collection</th>}
                <th style={{ ...thStyle, textAlign: "right" }}>Purchases</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Editions</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Volume</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Avg</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.buyer_address}:${r.collection}:${i}`} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={tdStyle}>
                    <Link
                      href={`/analytics/wallets/${r.buyer_address}`}
                      style={{ color: "#fff", textDecoration: "none", borderBottom: "1px dotted rgba(255,255,255,0.4)" }}
                    >
                      {truncAddr(r.buyer_address)}
                    </Link>
                  </td>
                  {!slug && (
                    <td style={{ ...tdStyle, color: "rgba(255,255,255,0.6)" }}>
                      {COLLECTION_LABEL[r.collection] ?? r.collection}
                    </td>
                  )}
                  <td style={{ ...tdStyle, textAlign: "right" }}>{r.purchases_7d}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{r.distinct_editions}</td>
                  <td style={{ ...tdStyle, textAlign: "right", color: "#34D399" }}>{fmtCurrency(r.volume_7d_usd)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{fmtCurrency(r.avg_purchase_usd)}</td>
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
