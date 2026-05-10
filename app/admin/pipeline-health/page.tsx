"use client";

// app/admin/pipeline-health/page.tsx
//
// Trevor-only cron drift surface. Reads /api/admin/pipeline-health and
// renders a sorted-by-severity table of every known pipeline. Big red
// banner appears when any pipeline is red. Same RPC_ADMIN_TOKEN sessionStorage
// pattern as the other admin tools.

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "rpc_admin_token";

interface Row {
  pipeline: string;
  runs_6h: number;
  fails_6h: number;
  last_run: string | null;
  expected_min: number | null;
  minutes_since: number | null;
  drift: "green" | "yellow" | "red";
  expected_but_missing: boolean;
}

interface Payload {
  generated_at: string;
  summary: { red: number; yellow: number; green: number; expected_but_missing: number };
  rows: Row[];
}

const DRIFT_FG: Record<Row["drift"], string> = {
  green: "#34D399",
  yellow: "#F59E0B",
  red: "#EF4444",
};

const DRIFT_BG: Record<Row["drift"], string> = {
  green: "rgba(52,211,153,0.10)",
  yellow: "rgba(245,158,11,0.10)",
  red: "rgba(239,68,68,0.12)",
};

function fmtCadence(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / (60 * 24))}d`;
}

function fmtMinutesSince(min: number | null): string {
  if (min == null) return "never";
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(min / (60 * 24));
  return `${d}d`;
}

export default function PipelineHealthPage() {
  const [token, setToken] = useState<string>("");
  const [tokenInput, setTokenInput] = useState<string>("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const cached = sessionStorage.getItem(TOKEN_KEY);
    if (cached) setToken(cached);
  }, []);

  const fetchData = useCallback(async (t: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/pipeline-health", {
        headers: { Authorization: `Bearer ${t}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
        setError("Invalid token. Re-enter to continue.");
        setData(null);
        return;
      }
      if (!res.ok) {
        const txt = await res.text();
        setError(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
        return;
      }
      const json = (await res.json()) as Payload;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) fetchData(token);
  }, [token, fetchData]);

  function onSubmitToken(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    sessionStorage.setItem(TOKEN_KEY, tokenInput.trim());
    setToken(tokenInput.trim());
    setTokenInput("");
  }

  if (!token) {
    return (
      <main style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", padding: 40 }}>
        <h1 className="rpc-heading" style={{ fontSize: 24, marginBottom: 18 }}>
          Pipeline Health — admin
        </h1>
        <form onSubmit={onSubmitToken} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="password"
            placeholder="RPC_ADMIN_TOKEN"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{
              flex: 1,
              maxWidth: 360,
              padding: "8px 10px",
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: 4,
              color: "var(--rpc-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          />
          <button
            type="submit"
            style={{
              padding: "8px 16px",
              background: "var(--rpc-red)",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Authenticate
          </button>
        </form>
        {error && <div style={{ marginTop: 16, color: "#ef4444", fontFamily: "var(--font-mono)", fontSize: 12 }}>{error}</div>}
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", padding: "24px 24px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <h1 className="rpc-heading" style={{ fontSize: 24, margin: 0 }}>
          Pipeline Health
        </h1>
        <button
          onClick={() => fetchData(token)}
          style={{
            padding: "6px 12px",
            background: "transparent",
            color: "var(--rpc-text-secondary)",
            border: "1px solid var(--rpc-border)",
            borderRadius: 4,
            fontFamily: "var(--font-display)",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {loading && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading…</div>}
      {error && <div style={{ color: "#ef4444", fontFamily: "var(--font-mono)", fontSize: 12 }}>{error}</div>}

      {data && data.summary.red > 0 && (
        <div
          style={{
            marginBottom: 18,
            padding: "14px 18px",
            background: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.45)",
            borderRadius: 6,
            color: "#FCA5A5",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          ⚠ {data.summary.red} pipeline{data.summary.red === 1 ? "" : "s"} red
          {data.summary.expected_but_missing > 0 ? ` · ${data.summary.expected_but_missing} expected but missing` : ""}
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 10,
              marginBottom: 18,
            }}
          >
            <Stat label="Red" value={String(data.summary.red)} accent={DRIFT_FG.red} />
            <Stat label="Yellow" value={String(data.summary.yellow)} accent={DRIFT_FG.yellow} />
            <Stat label="Green" value={String(data.summary.green)} accent={DRIFT_FG.green} />
            <Stat label="Expected but missing" value={String(data.summary.expected_but_missing)} />
          </div>

          <div style={{ overflowX: "auto", border: "1px solid var(--rpc-border)", borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--rpc-surface-raised)", textAlign: "left" }}>
                  <Th>Status</Th>
                  <Th>Pipeline</Th>
                  <Th>Last run</Th>
                  <Th>Expected cadence</Th>
                  <Th>Runs (6h)</Th>
                  <Th>Fails (6h)</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={r.pipeline}
                    style={{
                      borderTop: "1px solid var(--rpc-border)",
                      background: DRIFT_BG[r.drift],
                    }}
                  >
                    <Td>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 10,
                          letterSpacing: "0.10em",
                          color: DRIFT_FG[r.drift],
                          background: "rgba(0,0,0,0.4)",
                          border: `1px solid ${DRIFT_FG[r.drift]}55`,
                          fontWeight: 700,
                          textTransform: "uppercase",
                        }}
                      >
                        {r.drift}
                      </span>
                      {r.expected_but_missing && (
                        <span style={{ marginLeft: 6, fontSize: 9, color: DRIFT_FG.red }}>missing</span>
                      )}
                    </Td>
                    <Td style={{ fontWeight: 700 }}>{r.pipeline}</Td>
                    <Td style={{ color: "var(--rpc-text-secondary)" }}>{fmtMinutesSince(r.minutes_since)} ago</Td>
                    <Td style={{ color: "var(--rpc-text-muted)" }}>{fmtCadence(r.expected_min)}</Td>
                    <Td>{r.runs_6h}</Td>
                    <Td style={{ color: r.fails_6h > 0 ? DRIFT_FG.red : "var(--rpc-text-muted)" }}>{r.fails_6h}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)" }}>
            Generated {new Date(data.generated_at).toLocaleString()} · Drift thresholds: green &lt; 2× cadence, yellow 2-5×, red &gt; 5× or 24h+ stale
          </div>
        </>
      )}
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rpc-card" style={{ padding: 12 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, color: accent ?? "var(--rpc-text-primary)", marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: "10px 12px", fontWeight: 700, fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
      {children}
    </th>
  );
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 12px", verticalAlign: "top", ...(style ?? {}) }}>{children}</td>;
}
