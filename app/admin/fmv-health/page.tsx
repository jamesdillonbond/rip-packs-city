"use client";

// app/admin/fmv-health/page.tsx
//
// Trevor-only thin-sales guard cap audit. Reads
// get_fmv_calibration_caps_summary via /api/admin/fmv-health and renders a
// table of every FMV row that the guard downgraded in the chosen window.
// Token-gated by RPC_ADMIN_TOKEN — same sessionStorage key as the other
// admin tools.

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "rpc_admin_token";

const WINDOW_OPTIONS = [
  { key: "1h", label: "1h", hours: 1 },
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 168 },
  { key: "30d", label: "30d", hours: 720 },
] as const;

type WindowKey = (typeof WINDOW_OPTIONS)[number]["key"];

const COLLECTION_SHORT: Record<string, string> = {
  nba_top_shot: "TS",
  nfl_all_day: "AD",
  laliga_golazos: "Golazos",
  ufc_strike: "UFC",
  disney_pinnacle: "Pinnacle",
};

const REASON_ICON: Record<string, string> = {
  thin_sales: "⚠",
  stale_30d_no_ask: "⏰",
  stale_30d_ask_capped: "💰",
  common_fandom_outlier: "🎯",
};

interface CapRow {
  edition_id: string;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  collection_slug: string | null;
  reason: string | null;
  fmv_before: number | null;
  fmv_after: number | null;
  pct_dropped: number | null;
  confidence_before: string | null;
  confidence_after: string | null;
  applied_at: string | null;
}

interface Payload {
  window_hours: number;
  generated_at: string;
  total_caps: number;
  by_reason: Record<string, number>;
  rows: CapRow[];
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${Number(n).toFixed(2)}`;
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const delta = Date.now() - t;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function FmvHealthPage() {
  const [token, setToken] = useState<string>("");
  const [tokenInput, setTokenInput] = useState<string>("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const cached = sessionStorage.getItem(TOKEN_KEY);
    if (cached) setToken(cached);
  }, []);

  const fetchData = useCallback(
    async (t: string, win: WindowKey) => {
      const hours = WINDOW_OPTIONS.find((w) => w.key === win)?.hours ?? 24;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/fmv-health?windowHours=${hours}&limit=200`,
          {
            headers: { Authorization: `Bearer ${t}` },
            cache: "no-store",
          }
        );
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
    },
    []
  );

  useEffect(() => {
    if (token) fetchData(token, windowKey);
  }, [token, windowKey, fetchData]);

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
          FMV Health — admin
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
          FMV Health
        </h1>
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          <span style={{ color: "var(--rpc-text-muted)" }}>Window:</span>
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setWindowKey(opt.key)}
              style={{
                padding: "4px 10px",
                background: windowKey === opt.key ? "var(--rpc-red)" : "transparent",
                color: windowKey === opt.key ? "#fff" : "var(--rpc-text-secondary)",
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
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading…</div>}
      {error && <div style={{ color: "#ef4444", fontFamily: "var(--font-mono)", fontSize: 12 }}>{error}</div>}

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
            <Stat label="Total caps" value={String(data.total_caps)} accent="var(--rpc-red)" />
            {Object.entries(data.by_reason).map(([reason, count]) => (
              <Stat
                key={reason}
                label={`${REASON_ICON[reason] ?? "•"} ${reason}`}
                value={String(count)}
              />
            ))}
          </div>

          <div style={{ overflowX: "auto", border: "1px solid var(--rpc-border)", borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--rpc-surface-raised)", textAlign: "left" }}>
                  <Th>Col</Th>
                  <Th>Player</Th>
                  <Th>Set</Th>
                  <Th>Tier</Th>
                  <Th>Reason</Th>
                  <Th>Before</Th>
                  <Th>After</Th>
                  <Th>Drop %</Th>
                  <Th>Conf shift</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ padding: 18, textAlign: "center", color: "var(--rpc-text-muted)" }}>
                      No caps applied in this window.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={`${r.edition_id}-${r.applied_at}`} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                      <Td>{COLLECTION_SHORT[r.collection_slug ?? ""] ?? r.collection_slug ?? "—"}</Td>
                      <Td>{r.player_name ?? "—"}</Td>
                      <Td style={{ color: "var(--rpc-text-secondary)" }}>{r.set_name ?? "—"}</Td>
                      <Td>{r.tier ?? "—"}</Td>
                      <Td title={r.reason ?? undefined}>
                        {REASON_ICON[r.reason ?? ""] ?? "•"} {r.reason ?? "—"}
                      </Td>
                      <Td>{fmtUsd(r.fmv_before)}</Td>
                      <Td style={{ color: "#34D399" }}>{fmtUsd(r.fmv_after)}</Td>
                      <Td style={{ color: "#EF4444" }}>
                        {r.pct_dropped != null ? `${Number(r.pct_dropped).toFixed(1)}%` : "—"}
                      </Td>
                      <Td>
                        <span style={{ color: "var(--rpc-text-muted)" }}>{r.confidence_before ?? "—"}</span>
                        {" → "}
                        <span>{r.confidence_after ?? "—"}</span>
                      </Td>
                      <Td>{relTime(r.applied_at)}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)" }}>
            Generated {relTime(data.generated_at)} · Window {data.window_hours}h
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

function Td({ children, style, title }: { children: React.ReactNode; style?: React.CSSProperties; title?: string }) {
  return (
    <td title={title} style={{ padding: "10px 12px", verticalAlign: "top", ...(style ?? {}) }}>
      {children}
    </td>
  );
}
