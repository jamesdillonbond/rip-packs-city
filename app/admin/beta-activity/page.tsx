"use client";

// app/admin/beta-activity/page.tsx
//
// Trevor-only beta-activity dashboard. For each active allow_list user
// shows username, last_active_at (user_profiles), 7d page-view count,
// last seen (usage_events), and the top 3 non-page-view features used.
//
// Token-gated via RPC_ADMIN_TOKEN against /api/admin/beta-activity.
// Token is pasted into a password input on first visit and cached in
// sessionStorage under "rpc_admin_token" — same key as flowty-analytics.

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "rpc_admin_token";

interface FeatureCount {
  feature: string;
  count: number;
}

interface Row {
  email: string;
  username: string | null;
  wallet_addr: string | null;
  approved_at: string | null;
  last_active_at: string | null;
  page_views_7d: number;
  last_seen_at: string | null;
  top_features: FeatureCount[];
}

interface Payload {
  generated_at: string;
  user_count: number;
  rows: Row[];
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const delta = Date.now() - t;
  if (delta < 0) return "just now";
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function truncAddr(addr: string | null): string {
  if (!addr) return "—";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function BetaActivityPage() {
  const [token, setToken] = useState<string>("");
  const [tokenInput, setTokenInput] = useState<string>("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"page_views" | "last_seen" | "approved">("page_views");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const cached = sessionStorage.getItem(TOKEN_KEY);
    if (cached) setToken(cached);
  }, []);

  const fetchData = useCallback(async (t: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/beta-activity", {
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
      <main style={{ minHeight: "100vh", background: "var(--rpc-surface, #0a0a0a)", color: "#fafafa", padding: 40 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 18 }}>
          Beta activity — admin
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
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 4,
              color: "#fff",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          />
          <button
            type="submit"
            style={{
              padding: "8px 16px",
              background: "var(--rpc-red, #E03A2F)",
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

  const sortedRows = data
    ? [...data.rows].sort((a, b) => {
        if (sortKey === "page_views") return b.page_views_7d - a.page_views_7d;
        if (sortKey === "last_seen") {
          const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
          const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
          return tb - ta;
        }
        const aA = a.approved_at ? new Date(a.approved_at).getTime() : 0;
        const bA = b.approved_at ? new Date(b.approved_at).getTime() : 0;
        return bA - aA;
      })
    : [];

  return (
    <main style={{ minHeight: "100vh", background: "var(--rpc-surface, #0a0a0a)", color: "#fafafa", padding: "24px 24px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", margin: 0 }}>
          Beta activity
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>Sort:</span>
          {([
            { k: "page_views", l: "7d page views" },
            { k: "last_seen", l: "Last seen" },
            { k: "approved", l: "Approved" },
          ] as const).map(({ k, l }) => (
            <button
              key={k}
              onClick={() => setSortKey(k)}
              style={{
                padding: "4px 10px",
                background: sortKey === k ? "var(--rpc-red, #E03A2F)" : "transparent",
                color: sortKey === k ? "#fff" : "rgba(255,255,255,0.7)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 4,
                fontFamily: "var(--font-display)",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              {l}
            </button>
          ))}
          <button
            onClick={() => fetchData(token)}
            style={{
              padding: "4px 10px",
              background: "transparent",
              color: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 4,
              fontFamily: "var(--font-display)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
              marginLeft: 8,
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Loading…</div>}
      {error && <div style={{ color: "#ef4444", fontFamily: "var(--font-mono)", fontSize: 12 }}>{error}</div>}

      {data && (
        <div style={{ marginBottom: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
          {data.user_count} active beta users · generated {relTime(data.generated_at)}
        </div>
      )}

      {data && (
        <div style={{ overflowX: "auto", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.03)", textAlign: "left" }}>
                <Th>User</Th>
                <Th>Wallet</Th>
                <Th>7d page views</Th>
                <Th>Last seen</Th>
                <Th>last_active_at</Th>
                <Th>Top features (7d)</Th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
                <tr key={r.email} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  <Td>
                    <div style={{ fontWeight: 700, color: "#fff" }}>{r.username ?? r.email.split("@")[0]}</div>
                    <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>{r.email}</div>
                  </Td>
                  <Td>{truncAddr(r.wallet_addr)}</Td>
                  <Td style={{ fontWeight: 700, color: r.page_views_7d > 0 ? "#34D399" : "rgba(255,255,255,0.3)" }}>
                    {r.page_views_7d}
                  </Td>
                  <Td>{relTime(r.last_seen_at)}</Td>
                  <Td>{relTime(r.last_active_at)}</Td>
                  <Td>
                    {r.top_features.length === 0 ? (
                      <span style={{ color: "rgba(255,255,255,0.3)" }}>—</span>
                    ) : (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {r.top_features.map((f) => (
                          <span
                            key={f.feature}
                            style={{
                              background: "rgba(255,255,255,0.05)",
                              border: "1px solid rgba(255,255,255,0.12)",
                              borderRadius: 3,
                              padding: "2px 6px",
                              fontSize: 10,
                              color: "rgba(255,255,255,0.85)",
                            }}
                          >
                            {f.feature} ×{f.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: "10px 12px", fontWeight: 700, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
      {children}
    </th>
  );
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 12px", verticalAlign: "top", ...(style ?? {}) }}>{children}</td>;
}
