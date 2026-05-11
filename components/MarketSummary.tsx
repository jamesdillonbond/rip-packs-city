"use client";

// components/MarketSummary.tsx
//
// Per-collection 24h/7d summary tiles. Reads /api/market/summary, which
// proxies the get_market_summary() SECDEF RPC.
//
// Fires a single market-overview-view telemetry beacon on mount so we can
// later upsell Pro on advanced filters.

import { useEffect, useState } from "react";
import { track } from "@/lib/telemetry/track";

interface CollectionStats {
  sales_24h: number;
  sales_7d: number;
  volume_24h_usd: number;
  volume_7d_usd: number;
  avg_price_7d: number;
  distinct_buyers_7d: number;
  editions_total: number;
  editions_with_fmv: number;
}

type SummaryPayload = Record<string, CollectionStats>;

const COLLECTION_ORDER = [
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "disney_pinnacle",
  "ufc_strike",
];

const COLLECTION_LABEL: Record<string, string> = {
  nba_top_shot: "NBA Top Shot",
  nfl_all_day: "NFL All Day",
  laliga_golazos: "LaLiga Golazos",
  disney_pinnacle: "Disney Pinnacle",
  ufc_strike: "UFC Strike",
};

const COLLECTION_ACCENT: Record<string, string> = {
  nba_top_shot: "#E03A2F",
  nfl_all_day: "#4F94D4",
  laliga_golazos: "#22C55E",
  disney_pinnacle: "#A855F7",
  ufc_strike: "#EF4444",
};

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (Math.abs(n) === 0) return "$0";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export default function MarketSummary() {
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Single telemetry beacon for the entire market overview block (this
    // widget mounts first in the trio, so logging here is enough).
    track("market-overview-view");

    let cancelled = false;
    fetch("/api/market/summary", { credentials: "include" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || j.error) {
          setErr(j.error ?? `HTTP ${res.status}`);
          setSummary({});
        } else {
          setSummary((j.summary ?? {}) as SummaryPayload);
          setErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setSummary({});
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rpc-section">
      <div className="rpc-section-title">Market Summary</div>

      {err && (
        <div style={{ color: "#F87171", fontFamily: "var(--font-mono)", fontSize: 11, marginBottom: 8 }}>
          {err}
        </div>
      )}

      {loading && !summary ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading…</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 10,
          }}
        >
          {COLLECTION_ORDER.map((slug) => {
            const s = summary?.[slug];
            if (!s) return null;
            const accent = COLLECTION_ACCENT[slug] ?? "#fff";
            return (
              <div
                key={slug}
                style={{
                  background: "#0d0d0d",
                  border: `1px solid ${accent}44`,
                  borderLeft: `3px solid ${accent}`,
                  borderRadius: 8,
                  padding: "12px 14px",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: 14,
                    fontWeight: 700,
                    color: accent,
                    letterSpacing: "0.04em",
                    marginBottom: 8,
                    textTransform: "uppercase",
                  }}
                >
                  {COLLECTION_LABEL[slug] ?? slug}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  <Row label="24h Vol" value={fmtCurrency(s.volume_24h_usd)} />
                  <Row label="24h Sales" value={fmtInt(s.sales_24h)} />
                  <Row label="7d Vol" value={fmtCurrency(s.volume_7d_usd)} />
                  <Row label="7d Sales" value={fmtInt(s.sales_7d)} />
                  <Row label="7d Buyers" value={fmtInt(s.distinct_buyers_7d)} />
                  <Row label="7d Avg" value={fmtCurrency(s.avg_price_7d)} />
                  <Row label="Editions" value={fmtInt(s.editions_total)} />
                  <Row label="w/ FMV" value={fmtInt(s.editions_with_fmv)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "rgba(255,255,255,0.5)" }}>{label}</span>
      <span style={{ color: "#fff" }}>{value}</span>
    </div>
  );
}
