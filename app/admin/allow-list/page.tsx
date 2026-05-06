"use client";

// app/admin/allow-list/page.tsx
// Trevor-only allow-list triage dashboard. Bearer-token-gated against
// RPC_ADMIN_TOKEN via /api/admin/allow-list. Mirrors the auth + visual
// language of /admin/feedback.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import {
  getAdminToken,
  setAdminToken,
  clearAdminToken,
} from "@/lib/admin-token";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const ACCENT_RED = "#E03A2F";

type AllowStatus = "pending" | "hold" | "active" | "rejected";

interface AllowRow {
  id: string;
  email: string;
  wallet_addr: string | null;
  username: string | null;
  collections: string[] | null;
  status: AllowStatus;
  prewarm_status: string;
  prewarm_attempts: number | null;
  prewarm_started_at: string | null;
  prewarm_completed_at: string | null;
  prewarm_error: string | null;
  prewarm_summary: Record<string, string> | null;
  source: string | null;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  welcome_email_sent_at: string | null;
  welcome_email_error: string | null;
  hold_reason: string | null;
  reject_reason: string | null;
  notified_at: string | null;
  notes: string | null;
}

interface CountsBag {
  pending: number;
  hold: number;
  active: number;
  rejected: number;
}

const FILTER_KEYS = ["all", "pending", "hold", "active", "rejected"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const STATUS_COLOR: Record<AllowStatus, string> = {
  pending: "#F87171",
  hold: "#FBBF24",
  active: "#34D399",
  rejected: "#9CA3AF",
};

const STATUS_LABEL: Record<AllowStatus, string> = {
  pending: "Pending",
  hold: "Hold",
  active: "Active",
  rejected: "Rejected",
};

const PREWARM_COLOR: Record<string, string> = {
  pending: "#FBBF24",
  in_progress: "#4F94D4",
  complete: "#34D399",
  complete_partial: "#A3E635",
  failed: "#F87171",
  skipped: "#6B7280",
};

const COLLECTION_LABEL: Record<string, string> = {
  nba_top_shot: "NBA Top Shot",
  nfl_all_day: "NFL All Day",
  laliga_golazos: "LaLiga Golazos",
  disney_pinnacle: "Disney Pinnacle",
  ufc_strike: "UFC Strike",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export default function AdminAllowListPage() {
  return (
    <Suspense fallback={<MinimalChecking />}>
      <AdminAllowListInner />
    </Suspense>
  );
}

function MinimalChecking() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#080808",
        color: "rgba(255,255,255,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: monoFont,
        fontSize: 12,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      Checking…
    </div>
  );
}

function AdminAllowListInner() {
  const [token, setToken] = useState<string>("");
  const [authed, setAuthed] = useState<boolean>(false);
  const [authChecked, setAuthChecked] = useState<boolean>(false);

  useEffect(() => {
    const stored = getAdminToken();
    if (!stored) {
      setAuthChecked(true);
      return;
    }
    setToken(stored);
    fetch("/api/admin/allow-list", {
      headers: { Authorization: `Bearer ${stored}` },
      cache: "no-store",
    })
      .then((res) => {
        if (res.ok) {
          setAuthed(true);
        } else {
          clearAdminToken();
          setToken("");
        }
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return <MinimalChecking />;

  if (!authed) {
    return (
      <SignInGate
        onSignedIn={(t) => {
          setAdminToken(t);
          setToken(t);
          setAuthed(true);
        }}
      />
    );
  }

  return (
    <Dashboard
      token={token}
      onSignOut={() => {
        clearAdminToken();
        if (typeof window !== "undefined") window.location.reload();
      }}
    />
  );
}

// ── Sign-in gate ─────────────────────────────────────────────────────────────

function SignInGate({ onSignedIn }: { onSignedIn: (t: string) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const t = input.trim();
    if (!t) {
      setError("Token required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/allow-list", {
        headers: { Authorization: `Bearer ${t}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        setError("Invalid token");
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      onSignedIn(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#080808",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;}
      `}</style>
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 10,
          padding: 28,
        }}
      >
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 10,
            color: ACCENT_RED,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Rip Packs City
        </div>
        <div
          style={{
            fontFamily: condensedFont,
            fontWeight: 900,
            fontSize: 28,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            marginBottom: 18,
          }}
        >
          Admin Sign In
        </div>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Admin token"
          autoFocus
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "#0a0a0a",
            border: `1.5px solid ${ACCENT_RED}88`,
            borderRadius: 8,
            color: "#fff",
            fontFamily: monoFont,
            fontSize: 14,
            letterSpacing: "0.02em",
            outline: "none",
            marginBottom: 12,
          }}
        />
        {error && (
          <div
            style={{
              color: "#F87171",
              fontFamily: monoFont,
              fontSize: 11,
              marginBottom: 10,
            }}
          >
            {error}
          </div>
        )}
        <button
          onClick={submit}
          disabled={submitting}
          style={{
            width: "100%",
            background: "transparent",
            border: `1.5px solid ${ACCENT_RED}`,
            color: ACCENT_RED,
            padding: "11px 16px",
            borderRadius: 8,
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: submitting ? "default" : "pointer",
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? "Checking…" : "Sign In"}
        </button>
      </div>
    </div>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({
  token,
  onSignOut,
}: {
  token: string;
  onSignOut: () => void;
}) {
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus");

  const [rows, setRows] = useState<AllowRow[]>([]);
  const [counts, setCounts] = useState<CountsBag>({
    pending: 0,
    hold: 0,
    active: 0,
    rejected: 0,
  });
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const focusedRef = useRef<HTMLDivElement | null>(null);
  const didScrollRef = useRef(false);

  const handleUnauthorized = useCallback(() => {
    clearAdminToken();
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  const fetchRows = useCallback(async () => {
    const t = getAdminToken();
    if (!t) {
      handleUnauthorized();
      return;
    }
    try {
      const res = await fetch("/api/admin/allow-list", {
        headers: { Authorization: `Bearer ${t}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setRows(data.rows ?? []);
      setCounts(data.counts ?? { pending: 0, hold: 0, active: 0, rejected: 0 });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    setLoading(true);
    fetchRows();
  }, [fetchRows]);

  // Auto-refresh every 30s so prewarm_status / welcome_email_sent_at update
  // visually as the background drain completes.
  useEffect(() => {
    const handle = setInterval(() => {
      fetchRows();
    }, 30000);
    return () => clearInterval(handle);
  }, [fetchRows]);

  // Scroll-to-focus once after the first successful row load.
  useEffect(() => {
    if (didScrollRef.current) return;
    if (!focusId) return;
    if (rows.length === 0) return;
    const target = rows.find((r) => r.id === focusId);
    if (!target) return;
    didScrollRef.current = true;
    setTimeout(() => {
      focusedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }, [focusId, rows]);

  const visibleRows = useMemo(() => {
    if (activeFilter === "all") return rows;
    return rows.filter((r) => r.status === activeFilter);
  }, [rows, activeFilter]);

  const decide = useCallback(
    async (id: string, action: "approve" | "hold" | "deny" | "reset", reason: string | null) => {
      const t = getAdminToken();
      if (!t) {
        handleUnauthorized();
        return null;
      }
      setBusyRowId(id);
      try {
        const res = await fetch(`/api/admin/allow-list/${id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${t}`,
          },
          body: JSON.stringify({ action, reason }),
        });
        if (res.status === 401) {
          handleUnauthorized();
          return null;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data?.error || `HTTP ${res.status}`);
          return null;
        }
        const data = await res.json();
        const next = data.row as AllowRow;
        setRows((prev) => prev.map((r) => (r.id === id ? next : r)));
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
        return null;
      } finally {
        setBusyRowId(null);
      }
    },
    [handleUnauthorized]
  );

  const triggerPrewarmNow = useCallback(
    async (id: string) => {
      const t = getAdminToken();
      if (!t) {
        handleUnauthorized();
        return;
      }
      try {
        const res = await fetch("/api/admin/allow-list/prewarm-now", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${t}`,
          },
          body: JSON.stringify({ id }),
        });
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.warn("[admin/allow-list] prewarm-now failed:", data?.error);
        }
      } catch (err) {
        console.warn("[admin/allow-list] prewarm-now threw:", err);
      } finally {
        // Refresh to pull in the new prewarm_status / welcome_email_sent_at.
        fetchRows();
      }
    },
    [handleUnauthorized, fetchRows]
  );

  const onApprove = useCallback(
    async (row: AllowRow) => {
      const next = await decide(row.id, "approve", null);
      // Approving immediately stamps prewarm_status='pending' (if there's a
      // wallet/username) — kick off prewarm-now in the background so the admin
      // sees the row finish without waiting for the cron tick.
      if (next && (next.wallet_addr || next.username)) {
        void triggerPrewarmNow(next.id);
      }
    },
    [decide, triggerPrewarmNow]
  );

  const onHold = useCallback(
    async (row: AllowRow) => {
      const reason =
        typeof window !== "undefined"
          ? window.prompt("Hold reason (optional):", row.hold_reason ?? "")
          : null;
      if (reason === null) return;
      await decide(row.id, "hold", reason.trim() || null);
    },
    [decide]
  );

  const onDeny = useCallback(
    async (row: AllowRow) => {
      const reason =
        typeof window !== "undefined"
          ? window.prompt("Reject reason (optional):", row.reject_reason ?? "")
          : null;
      if (reason === null) return;
      const ok =
        typeof window !== "undefined"
          ? window.confirm(`Deny ${row.email}? They will not be able to sign in.`)
          : true;
      if (!ok) return;
      await decide(row.id, "deny", reason.trim() || null);
    },
    [decide]
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#080808",
        color: "#fff",
        paddingBottom: 60,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .rpc-section { background:#18181b; border:1px solid #27272a; border-radius:10px; padding:16px 18px; }
        .rpc-pill { padding:7px 14px; border-radius:18px; font-family:${condensedFont}; font-weight:700; font-size:12px; letter-spacing:0.06em; text-transform:uppercase; cursor:pointer; border:1px solid #27272a; background:#0d0d0d; color:rgba(255,255,255,0.6); }
        .rpc-pill.active { border-color:${ACCENT_RED}; color:${ACCENT_RED}; background:${ACCENT_RED}11; }
        .rpc-card { background:#0d0d0d; border:1px solid #27272a; border-radius:8px; padding:14px 16px; transition:border-color 150ms ease, box-shadow 150ms ease; }
        .rpc-card:hover { border-color:#3f3f46; }
        .rpc-card.focused { border-color:${ACCENT_RED}; box-shadow:0 0 0 2px ${ACCENT_RED}33; }
        .rpc-chip { display:inline-flex; align-items:center; padding:3px 9px; border-radius:999px; font-family:${monoFont}; font-size:10px; letter-spacing:0.08em; text-transform:uppercase; border:1px solid #27272a; background:#18181b; color:rgba(255,255,255,0.7); }
      `}</style>
      <main
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "24px 24px 40px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {/* Header */}
        <section
          className="rpc-section"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: monoFont,
                fontSize: 10,
                color: ACCENT_RED,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
              }}
            >
              Rip Packs City
            </div>
            <div
              style={{
                fontFamily: condensedFont,
                fontWeight: 900,
                fontSize: 24,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                marginTop: 2,
              }}
            >
              Allow-List Triage
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                setLoading(true);
                fetchRows();
              }}
              style={ghostBtnStyle}
            >
              Refresh
            </button>
            <button onClick={onSignOut} style={ghostBtnStyle}>
              Sign Out
            </button>
          </div>
        </section>

        {/* Filter pills */}
        <section className="rpc-section" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {FILTER_KEYS.map((k) => {
            const labelMap: Record<FilterKey, string> = {
              all: "All",
              pending: "Pending",
              hold: "Hold",
              active: "Active",
              rejected: "Rejected",
            };
            const count =
              k === "all"
                ? counts.pending + counts.hold + counts.active + counts.rejected
                : counts[k as keyof CountsBag];
            return (
              <button
                key={k}
                onClick={() => setActiveFilter(k)}
                className={`rpc-pill${activeFilter === k ? " active" : ""}`}
              >
                {labelMap[k]} ({count})
              </button>
            );
          })}
        </section>

        {error && (
          <div
            style={{
              padding: "10px 14px",
              background: "#1a0d0d",
              border: "1px solid #F8717166",
              color: "#F87171",
              fontFamily: monoFont,
              fontSize: 12,
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        )}

        {/* Row list */}
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {loading && rows.length === 0 ? (
            <div
              style={{
                fontFamily: monoFont,
                fontSize: 12,
                color: "rgba(255,255,255,0.4)",
                textAlign: "center",
                padding: 24,
              }}
            >
              Loading…
            </div>
          ) : visibleRows.length === 0 ? (
            <div
              style={{
                fontFamily: monoFont,
                fontSize: 12,
                color: "rgba(255,255,255,0.4)",
                textAlign: "center",
                padding: 24,
              }}
            >
              Nothing in this view.
            </div>
          ) : (
            visibleRows.map((r) => (
              <RowCard
                key={r.id}
                row={r}
                isFocused={r.id === focusId}
                focusRef={r.id === focusId ? focusedRef : null}
                busy={busyRowId === r.id}
                onApprove={() => onApprove(r)}
                onHold={() => onHold(r)}
                onDeny={() => onDeny(r)}
                onReset={() => decide(r.id, "reset", null)}
                onPrewarmNow={() => triggerPrewarmNow(r.id)}
              />
            ))
          )}
        </section>
      </main>
    </div>
  );
}

// ── Row card ─────────────────────────────────────────────────────────────────

function RowCard({
  row,
  isFocused,
  focusRef,
  busy,
  onApprove,
  onHold,
  onDeny,
  onReset,
  onPrewarmNow,
}: {
  row: AllowRow;
  isFocused: boolean;
  focusRef: React.RefObject<HTMLDivElement | null> | null;
  busy: boolean;
  onApprove: () => void;
  onHold: () => void;
  onDeny: () => void;
  onReset: () => void;
  onPrewarmNow: () => void;
}) {
  const statusKey = row.status;
  const collections = row.collections ?? [];

  return (
    <div ref={focusRef} className={`rpc-card${isFocused ? " focused" : ""}`}>
      {/* Header line */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: monoFont,
            fontSize: 9,
            letterSpacing: "0.14em",
            color: STATUS_COLOR[statusKey],
            border: `1px solid ${STATUS_COLOR[statusKey]}55`,
            background: `${STATUS_COLOR[statusKey]}11`,
            padding: "3px 8px",
            borderRadius: 4,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {STATUS_LABEL[statusKey]}
        </span>
        <span
          style={{
            fontFamily: condensedFont,
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: "0.01em",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.email}
        </span>
        <span
          style={{
            fontFamily: monoFont,
            fontSize: 10,
            color: "rgba(255,255,255,0.45)",
            flexShrink: 0,
          }}
        >
          {timeAgo(row.created_at)}
        </span>
      </div>

      {/* Identity line */}
      <div
        style={{
          fontFamily: monoFont,
          fontSize: 11,
          color: "rgba(255,255,255,0.65)",
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        {row.wallet_addr && <span>wallet: {row.wallet_addr}</span>}
        {row.username && <span>user: {row.username}</span>}
        {row.source && <span>via: {row.source}</span>}
      </div>

      {/* Collections pills */}
      {collections.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 5,
            marginBottom: 10,
          }}
        >
          {collections.map((c) => (
            <span key={c} className="rpc-chip">
              {COLLECTION_LABEL[c] ?? c}
            </span>
          ))}
        </div>
      )}

      {/* Active-row prewarm + welcome state */}
      {row.status === "active" && (
        <div
          style={{
            background: "#000",
            border: "1px solid #1f1f23",
            borderRadius: 6,
            padding: "10px 12px",
            marginBottom: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span
              style={{
                fontFamily: monoFont,
                fontSize: 9,
                letterSpacing: "0.14em",
                color: PREWARM_COLOR[row.prewarm_status] ?? "#9CA3AF",
                border: `1px solid ${(PREWARM_COLOR[row.prewarm_status] ?? "#9CA3AF")}55`,
                padding: "3px 7px",
                borderRadius: 4,
                textTransform: "uppercase",
              }}
            >
              prewarm: {row.prewarm_status}
            </span>
            {row.prewarm_attempts != null && (
              <span style={{ fontFamily: monoFont, fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
                attempts: {row.prewarm_attempts}
              </span>
            )}
            {row.welcome_email_sent_at && (
              <span
                style={{
                  fontFamily: monoFont,
                  fontSize: 10,
                  color: "#34D399",
                }}
              >
                welcome sent {timeAgo(row.welcome_email_sent_at)}
              </span>
            )}
            {row.welcome_email_error && (
              <span
                style={{
                  fontFamily: monoFont,
                  fontSize: 10,
                  color: "#F87171",
                }}
                title={row.welcome_email_error}
              >
                welcome ERROR
              </span>
            )}
          </div>
          {row.prewarm_summary && Object.keys(row.prewarm_summary).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {Object.entries(row.prewarm_summary).map(([k, v]) => (
                <span key={k} className="rpc-chip" style={{ color: PREWARM_COLOR[String(v)] ?? "rgba(255,255,255,0.7)" }}>
                  {(COLLECTION_LABEL[k] ?? k) + ": " + String(v)}
                </span>
              ))}
            </div>
          )}
          {row.prewarm_error && (
            <div style={{ fontFamily: monoFont, fontSize: 10, color: "#F87171" }}>
              {row.prewarm_error}
            </div>
          )}
        </div>
      )}

      {(row.hold_reason || row.reject_reason) && (
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 11,
            color: row.hold_reason ? "#FBBF24" : "#9CA3AF",
            marginBottom: 10,
          }}
        >
          {row.hold_reason && <>hold: {row.hold_reason}</>}
          {row.reject_reason && <>reject: {row.reject_reason}</>}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>
        {(row.status === "pending" || row.status === "hold") && (
          <>
            <button
              onClick={onApprove}
              disabled={busy}
              style={primaryBtnStyle("#34D399", busy)}
            >
              Approve
            </button>
            <button
              onClick={onHold}
              disabled={busy}
              style={primaryBtnStyle("#FBBF24", busy)}
            >
              Hold
            </button>
            <button
              onClick={onDeny}
              disabled={busy}
              style={primaryBtnStyle("#F87171", busy)}
            >
              Deny
            </button>
          </>
        )}
        {row.status === "active" && (
          <>
            <button onClick={onPrewarmNow} disabled={busy} style={ghostBtnStyle}>
              Prewarm Now
            </button>
            <button onClick={onReset} disabled={busy} style={ghostBtnStyle}>
              Reset to Pending
            </button>
          </>
        )}
        {row.status === "rejected" && (
          <button onClick={onReset} disabled={busy} style={ghostBtnStyle}>
            Reset to Pending
          </button>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontFamily: monoFont,
            fontSize: 10,
            color: "rgba(255,255,255,0.35)",
            alignSelf: "center",
          }}
        >
          {fmtIso(row.created_at)}
        </span>
      </div>
    </div>
  );
}

const ghostBtnStyle: React.CSSProperties = {
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.85)",
  background: "transparent",
  padding: "7px 12px",
  border: `1px solid ${ACCENT_RED}66`,
  borderRadius: 5,
  cursor: "pointer",
};

function primaryBtnStyle(color: string, busy: boolean): React.CSSProperties {
  return {
    fontFamily: condensedFont,
    fontWeight: 800,
    fontSize: 12,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color,
    background: "transparent",
    padding: "8px 14px",
    border: `1.5px solid ${color}`,
    borderRadius: 6,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.5 : 1,
  };
}
