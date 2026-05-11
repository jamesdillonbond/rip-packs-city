"use client";

// components/PortfolioChart.tsx
//
// 30-day portfolio FMV history for the signed-in user's primary wallet.
// Reads /api/portfolio/history (owner_key = rpc_owner_key from
// localStorage). Hides itself silently if no owner key is set yet — the
// rest of the dashboard handles the wallet-onboarding case.

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key";

interface HistoryPoint {
  snapshot_date: string;
  total_fmv: number;
  moment_count: number;
  wallet_count: number;
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(iso: string): string {
  // "2026-04-15" → "Apr 15"
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function PortfolioChart() {
  const [ownerKey, setOwnerKey] = useState<string>("");
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setOwnerKey(getOwnerKey());
    const unsubscribe = onOwnerKeyChange((k) => setOwnerKey(k));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!ownerKey) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const qs = new URLSearchParams({ owner_key: ownerKey, days: "30" });
    fetch(`/api/portfolio/history?${qs.toString()}`, { credentials: "include" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || j.error) {
          setErr(j.error ?? `HTTP ${res.status}`);
          setHistory([]);
        } else {
          setHistory((j.history ?? []) as HistoryPoint[]);
          setErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setHistory([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerKey]);

  if (!ownerKey) return null;

  const lastPoint = history && history.length > 0 ? history[history.length - 1] : null;
  const firstPoint = history && history.length > 0 ? history[0] : null;
  const change =
    firstPoint && lastPoint ? lastPoint.total_fmv - firstPoint.total_fmv : 0;
  const changePct =
    firstPoint && firstPoint.total_fmv > 0
      ? ((change / firstPoint.total_fmv) * 100)
      : 0;
  const changeColor = change >= 0 ? "#34D399" : "#F87171";

  return (
    <section className="rpc-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div className="rpc-section-title">Portfolio · 30 days</div>
        {lastPoint && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <span style={{ color: "#fff" }}>{fmtCurrency(lastPoint.total_fmv)}</span>
            <span style={{ color: changeColor }}>
              {change >= 0 ? "+" : ""}
              {fmtCurrency(change)} ({change >= 0 ? "+" : ""}{changePct.toFixed(1)}%)
            </span>
          </div>
        )}
      </div>

      {err && (
        <div style={{ color: "#F87171", fontFamily: "var(--font-mono)", fontSize: 11, marginBottom: 8 }}>
          {err}
        </div>
      )}

      {loading && !history ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading…</div>
      ) : !history || history.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          No snapshots yet. Daily snapshots accumulate after the first cron run at 06:00 UTC.
        </div>
      ) : (
        <div style={{ width: "100%", height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="snapshot_date"
                stroke="rgba(255,255,255,0.4)"
                fontSize={11}
                tickFormatter={shortDate}
                minTickGap={20}
              />
              <YAxis
                stroke="rgba(255,255,255,0.4)"
                fontSize={11}
                tickFormatter={(v) => fmtCurrency(Number(v))}
                width={70}
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(13,13,13,0.95)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "#F1F1F1",
                }}
                labelStyle={{ color: "rgba(255,255,255,0.6)", fontSize: 10 }}
                labelFormatter={(label) => shortDate(String(label))}
                formatter={(value) => fmtCurrency(Number(value))}
              />
              <Line
                type="monotone"
                dataKey="total_fmv"
                stroke="#E03A2F"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
