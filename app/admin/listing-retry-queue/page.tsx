"use client";

// app/admin/listing-retry-queue/page.tsx
//
// Trevor-only observability for the listing_resolution_failures queue
// (Round 7 Item 2 retry surface). Reads /api/admin/listing-retry-queue,
// renders the get_listing_retry_queue_stats() RPC output as panels.
// Auto-refreshes every 60s. Same RPC_ADMIN_TOKEN sessionStorage pattern
// as /admin/pipeline-health.

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "rpc_admin_token";

interface Payload {
  total_unresolved: number;
  by_collection: Record<string, number>;
  by_retry_count: Record<string, number>;
  oldest_unresolved_age_hours: number;
  last_retry_run_started_at: string | null;
  last_retry_run_ok: boolean | null;
  last_retry_run_resolved: number | null;
  last_retry_run_still_unresolved: number | null;
  last_retry_run_retry_count_hit_cap: number | null;
  generated_at: string;
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// Retry-count bucket sort: '0','1',..,'9','10+'.
function sortBuckets(a: string, b: string): number {
  const ai = a === "10+" ? 10 : Number(a);
  const bi = b === "10+" ? 10 : Number(b);
  return ai - bi;
}

export default function ListingRetryQueuePage() {
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
      const res = await fetch("/api/admin/listing-retry-queue", {
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
      setData((await res.json()) as Payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) fetchData(token);
  }, [token, fetchData]);

  // 60s auto-refresh.
  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => fetchData(token), 60_000);
    return () => clearInterval(id);
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
          Listing Retry Queue — admin
        </h1>
        <form onSubmit={onSubmitToken} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="password"
            placeholder="RPC_ADMIN_TOKEN"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{
              flex: 1, maxWidth: 360, padding: "8px 10px",
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: 4, color: "var(--rpc-text-primary)",
              fontFamily: "var(--font-mono)", fontSize: 12,
            }}
          />
          <button
            type="submit"
            style={{
              padding: "8px 16px", background: "var(--rpc-red)", color: "#fff",
              border: "none", borderRadius: 4,
              fontFamily: "var(--font-display)", fontWeight: 700,
              fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase",
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

  const stuckColor = data && data.oldest_unresolved_age_hours > 48 ? "#EF4444" : "var(--rpc-text-secondary)";

  return (
    <main style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", padding: "24px 24px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <h1 className="rpc-heading" style={{ fontSize: 24, margin: 0 }}>
          Listing Retry Queue
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
            auto-refresh 60s · last {data ? ageLabel(data.generated_at) : "—"}
          </span>
          <button
            onClick={() => fetchData(token)}
            disabled={loading}
            style={{
              padding: "6px 12px", background: "transparent",
              color: "var(--rpc-text-secondary)",
              border: "1px solid var(--rpc-border)", borderRadius: 4,
              fontFamily: "var(--font-display)", fontSize: 11,
              letterSpacing: "0.08em", textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div style={{ marginBottom: 16, color: "#ef4444", fontFamily: "var(--font-mono)", fontSize: 12 }}>{error}</div>}

      {!data && !error && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading…</div>
      )}

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {/* Total + oldest */}
          <Panel title="Queue">
            <Stat label="Total unresolved" value={data.total_unresolved.toLocaleString()} />
            <Stat
              label="Oldest unresolved"
              value={fmtHours(data.oldest_unresolved_age_hours)}
              valueColor={stuckColor}
              hint={data.oldest_unresolved_age_hours > 48 ? "exceeds 48h drain target" : null}
            />
          </Panel>

          {/* By collection */}
          <Panel title="By collection">
            {Object.keys(data.by_collection).length === 0 ? (
              <div style={muted}>empty</div>
            ) : (
              <ul style={list}>
                {Object.entries(data.by_collection)
                  .sort((a, b) => b[1] - a[1])
                  .map(([slug, n]) => (
                    <li key={slug} style={listRow}>
                      <span>{slug ?? "(unknown)"}</span>
                      <span style={mono}>{n.toLocaleString()}</span>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          {/* Retry-count distribution */}
          <Panel title="Retry count distribution">
            {Object.keys(data.by_retry_count).length === 0 ? (
              <div style={muted}>empty</div>
            ) : (
              <ul style={list}>
                {Object.entries(data.by_retry_count)
                  .sort((a, b) => sortBuckets(a[0], b[0]))
                  .map(([bucket, n]) => (
                    <li key={bucket} style={listRow}>
                      <span>retry_count = {bucket}</span>
                      <span style={{ ...mono, color: bucket === "10+" ? "#EF4444" : "var(--rpc-text-secondary)" }}>{n.toLocaleString()}</span>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          {/* Last retry run */}
          <Panel title="Last retry run (allday-listings-retry)">
            <Stat label="Started" value={data.last_retry_run_started_at ? ageLabel(data.last_retry_run_started_at) : "never"} />
            <Stat
              label="ok"
              value={data.last_retry_run_ok === null ? "—" : data.last_retry_run_ok ? "true" : "false"}
              valueColor={data.last_retry_run_ok === false ? "#EF4444" : data.last_retry_run_ok === true ? "#34D399" : "var(--rpc-text-secondary)"}
            />
            <Stat label="Resolved" value={String(data.last_retry_run_resolved ?? "—")} />
            <Stat label="Still unresolved" value={String(data.last_retry_run_still_unresolved ?? "—")} />
            <Stat label="Hit retry cap" value={String(data.last_retry_run_retry_count_hit_cap ?? "—")} />
          </Panel>
        </div>
      )}
    </main>
  );
}

const muted: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-muted)",
};
const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)",
};
const list: React.CSSProperties = {
  listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6,
};
const listRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between",
  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-primary)",
  borderBottom: "1px solid rgba(255,255,255,0.04)", paddingBottom: 4,
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: "var(--rpc-surface)",
        border: "1px solid var(--rpc-border)",
        borderRadius: 8,
        padding: "16px 18px",
      }}
    >
      <h2
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 13,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
          margin: "0 0 12px",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  valueColor,
  hint,
}: {
  label: string;
  value: string;
  valueColor?: string;
  hint?: string | null;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
      <div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
          {label}
        </div>
        {hint && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#EF4444", marginTop: 2 }}>{hint}</div>
        )}
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 18,
          letterSpacing: "0.02em",
          color: valueColor ?? "var(--rpc-text-primary)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
