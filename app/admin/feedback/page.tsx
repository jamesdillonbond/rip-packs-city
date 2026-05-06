"use client";

// app/admin/feedback/page.tsx
// Trevor-only beta-feedback triage dashboard. Bearer-token-gated against
// RPC_ADMIN_TOKEN via /api/admin/feedback. Intentionally does NOT import
// useFlowUser, SupportChatConnected, ConnectButton, or any wallet/auth
// surface — this page must not initialize FCL.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAdminToken,
  setAdminToken,
  clearAdminToken,
} from "@/lib/admin-token";

const condensedFont = "'Barlow Condensed', sans-serif";
const monoFont = "'Share Tech Mono', monospace";
const ACCENT_RED = "#E03A2F";

type FeedbackStatus =
  | "new"
  | "reviewed"
  | "in_progress"
  | "shipped"
  | "wontfix"
  | "duplicate";

type FeedbackType =
  | "bug"
  | "feature_request"
  | "confusion"
  | "general_feedback"
  | "praise";

interface Row {
  id: number;
  created_at: string;
  updated_at: string | null;
  shipped_at: string | null;
  owner_key: string | null;
  user_wallet: string | null;
  page_context: string | null;
  feedback_type: FeedbackType | null;
  feedback_summary: string | null;
  feedback_details: string | null;
  feedback_status: FeedbackStatus;
  admin_note: string | null;
  duplicate_of: number | null;
  user_message: string | null;
  bot_response: string | null;
  session_id: string | null;
}

interface Stats {
  open_bugs: number;
  open_features: number;
  open_confusion: number;
  open_general: number;
  open_praise: number;
  shipped_last_7d: number;
  wontfix_total: number;
  total_triaged: number;
  total_open: number;
}

interface Filter {
  key: string;
  label: string;
  status: FeedbackStatus[];
  type?: FeedbackType[];
}

const FILTERS: Filter[] = [
  { key: "all_open", label: "All Open", status: ["new", "reviewed", "in_progress"] },
  { key: "bugs", label: "Bugs", status: ["new", "reviewed", "in_progress"], type: ["bug"] },
  { key: "features", label: "Features", status: ["new", "reviewed", "in_progress"], type: ["feature_request"] },
  { key: "confusion", label: "Confusion", status: ["new", "reviewed", "in_progress"], type: ["confusion"] },
  { key: "praise", label: "Praise", status: ["new", "reviewed", "in_progress"], type: ["praise"] },
  { key: "shipped", label: "Shipped", status: ["shipped"] },
  { key: "wontfix", label: "Wontfix", status: ["wontfix"] },
  {
    key: "all",
    label: "All",
    status: ["new", "reviewed", "in_progress", "shipped", "wontfix", "duplicate"],
  },
];

const STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: "New",
  reviewed: "Reviewed",
  in_progress: "In Progress",
  shipped: "Shipped",
  wontfix: "Wontfix",
  duplicate: "Duplicate",
};

const STATUS_COLOR: Record<FeedbackStatus, string> = {
  new: "#F87171",
  reviewed: "#FBBF24",
  in_progress: "#4F94D4",
  shipped: "#34D399",
  wontfix: "#9CA3AF",
  duplicate: "#A855F7",
};

const TYPE_COLOR: Record<FeedbackType, string> = {
  bug: "#F87171",
  feature_request: "#4F94D4",
  confusion: "#FBBF24",
  general_feedback: "#9CA3AF",
  praise: "#34D399",
};

const TYPE_LABEL: Record<FeedbackType, string> = {
  bug: "BUG",
  feature_request: "FEATURE",
  confusion: "CONFUSION",
  general_feedback: "FEEDBACK",
  praise: "PRAISE",
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

export default function AdminFeedbackPage() {
  const [token, setToken] = useState<string>("");
  const [authed, setAuthed] = useState<boolean>(false);
  const [authChecked, setAuthChecked] = useState<boolean>(false);

  // On mount, if a token is in localStorage probe the API to verify.
  useEffect(() => {
    const stored = getAdminToken();
    if (!stored) {
      setAuthChecked(true);
      return;
    }
    setToken(stored);
    fetch("/api/admin/feedback?limit=1", {
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
      .catch(() => {
        // Network error — leave the gate visible so Trevor can retry.
      })
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) {
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
      const res = await fetch("/api/admin/feedback?limit=1", {
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
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>("all_open");
  const [searchInput, setSearchInput] = useState<string>("");
  const [debouncedQ, setDebouncedQ] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reauth signal: if any request returns 401 we clear the token and revert.
  const handleUnauthorized = useCallback(() => {
    clearAdminToken();
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQ(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filter = useMemo(
    () => FILTERS.find((f) => f.key === activeFilter) ?? FILTERS[0],
    [activeFilter]
  );

  const fetchRows = useCallback(async () => {
    const t = getAdminToken();
    if (!t) {
      handleUnauthorized();
      return;
    }
    const params = new URLSearchParams();
    params.set("status", filter.status.join(","));
    if (filter.type) params.set("type", filter.type.join(","));
    if (debouncedQ) params.set("q", debouncedQ);
    params.set("limit", "200");
    try {
      const res = await fetch(`/api/admin/feedback?${params.toString()}`, {
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
      setStats(data.stats ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [filter, debouncedQ, handleUnauthorized]);

  useEffect(() => {
    setLoading(true);
    fetchRows();
  }, [fetchRows]);

  // Auto-refresh every 60s.
  useEffect(() => {
    const handle = setInterval(() => {
      fetchRows();
    }, 60000);
    return () => clearInterval(handle);
  }, [fetchRows]);

  // Optimistic row mutation. On success the next auto-refresh reconciles.
  const patchRow = useCallback(
    async (id: number, patch: Partial<Row>) => {
      const t = getAdminToken();
      if (!t) {
        handleUnauthorized();
        return null;
      }
      try {
        const res = await fetch(`/api/admin/feedback/${id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${t}`,
          },
          body: JSON.stringify(patch),
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
        return (data.row as Row) ?? null;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
        return null;
      }
    },
    [handleUnauthorized]
  );

  const onRowUpdated = useCallback((updated: Row) => {
    setRows((prev) => {
      // If the row is no longer in the active filter set, drop it.
      const idx = prev.findIndex((r) => r.id === updated.id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = updated;
      return next;
    });
    // Refresh stats opportunistically — cheap and keeps tiles honest.
    fetchRows();
  }, [fetchRows]);

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
        .rpc-section-title { font-family:${condensedFont}; font-weight:800; font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:rgba(255,255,255,0.7); margin-bottom:12px; }
        .rpc-pill { padding:7px 14px; border-radius:18px; font-family:${condensedFont}; font-weight:700; font-size:12px; letter-spacing:0.06em; text-transform:uppercase; cursor:pointer; border:1px solid #27272a; background:#0d0d0d; color:rgba(255,255,255,0.6); }
        .rpc-pill.active { border-color:${ACCENT_RED}; color:${ACCENT_RED}; background:${ACCENT_RED}11; }
        .rpc-card { background:#0d0d0d; border:1px solid #27272a; border-radius:8px; padding:12px 14px; transition:border-color 150ms ease; }
        .rpc-card:hover { border-color:#3f3f46; }
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
              Beta Feedback Triage
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

        {/* Stat tiles */}
        {stats && (
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))",
              gap: 10,
            }}
          >
            <StatTile label="Open Bugs" value={stats.open_bugs} color={TYPE_COLOR.bug} />
            <StatTile
              label="Open Features"
              value={stats.open_features}
              color={TYPE_COLOR.feature_request}
            />
            <StatTile
              label="Confusion"
              value={stats.open_confusion}
              color={TYPE_COLOR.confusion}
            />
            <StatTile
              label="Shipped This Week"
              value={stats.shipped_last_7d}
              color={STATUS_COLOR.shipped}
            />
            <StatTile label="Total Open" value={stats.total_open} color="#fff" />
          </section>
        )}

        {/* Filters + search */}
        <section className="rpc-section" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                className={`rpc-pill${activeFilter === f.key ? " active" : ""}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search summary, details, user message…"
            style={{
              padding: "10px 12px",
              background: "#0d0d0d",
              border: "1px solid #27272a",
              borderRadius: 6,
              color: "#fff",
              fontFamily: monoFont,
              fontSize: 13,
              outline: "none",
            }}
          />
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
          ) : rows.length === 0 ? (
            <div
              style={{
                fontFamily: monoFont,
                fontSize: 12,
                color: "rgba(255,255,255,0.4)",
                textAlign: "center",
                padding: 24,
              }}
            >
              No feedback in this view.
            </div>
          ) : (
            rows.map((r) => (
              <FeedbackRowCard
                key={r.id}
                row={r}
                onPatch={(patch) => patchRow(r.id, patch)}
                onUpdated={onRowUpdated}
              />
            ))
          )}
        </section>
      </main>
    </div>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          fontFamily: monoFont,
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.5)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: condensedFont,
          fontWeight: 900,
          fontSize: 28,
          letterSpacing: "0.02em",
          color,
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// ── Row card ─────────────────────────────────────────────────────────────────

function FeedbackRowCard({
  row,
  onPatch,
  onUpdated,
}: {
  row: Row;
  onPatch: (patch: Partial<Row>) => Promise<Row | null>;
  onUpdated: (next: Row) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string>(row.admin_note ?? "");
  const [noteSaving, setNoteSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const initialNote = useRef<string>(row.admin_note ?? "");

  // Keep the textarea in sync if the row gets updated by another action.
  useEffect(() => {
    if (row.admin_note !== initialNote.current) {
      setNoteDraft(row.admin_note ?? "");
      initialNote.current = row.admin_note ?? "";
    }
  }, [row.admin_note]);

  const typeKey = (row.feedback_type ?? "general_feedback") as FeedbackType;
  const statusKey = row.feedback_status ?? "new";

  const onStatusChange = async (next: FeedbackStatus) => {
    if (next === row.feedback_status) return;
    let duplicateOf: number | null | undefined = undefined;
    if (next === "duplicate") {
      const raw = typeof window !== "undefined"
        ? window.prompt("Canonical feedback id this is a duplicate of:")
        : null;
      if (!raw) return;
      const parsed = Number(raw.trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        if (typeof window !== "undefined") window.alert("Must be a positive integer");
        return;
      }
      duplicateOf = parsed;
    } else if (row.feedback_status === "duplicate") {
      // Moving away from duplicate — clear the pointer.
      duplicateOf = null;
    }
    setStatusSaving(true);
    const patch: Partial<Row> = { feedback_status: next };
    if (duplicateOf !== undefined) patch.duplicate_of = duplicateOf;
    const updated = await onPatch(patch);
    setStatusSaving(false);
    if (updated) onUpdated(updated);
  };

  const onNoteBlur = async () => {
    const next = noteDraft;
    if (next === (row.admin_note ?? "")) return;
    setNoteSaving(true);
    const updated = await onPatch({ admin_note: next.length === 0 ? null : next });
    setNoteSaving(false);
    if (updated) onUpdated(updated);
  };

  return (
    <div className="rpc-card">
      {/* Collapsed header row */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: monoFont,
            fontSize: 9,
            letterSpacing: "0.14em",
            color: TYPE_COLOR[typeKey],
            border: `1px solid ${TYPE_COLOR[typeKey]}55`,
            background: `${TYPE_COLOR[typeKey]}11`,
            padding: "3px 7px",
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          {TYPE_LABEL[typeKey]}
        </span>
        <span
          style={{
            fontFamily: condensedFont,
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: "0.02em",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.feedback_summary ?? row.user_message ?? "(no summary)"}
        </span>
        <span
          style={{
            fontFamily: monoFont,
            fontSize: 9,
            letterSpacing: "0.12em",
            color: STATUS_COLOR[statusKey],
            border: `1px solid ${STATUS_COLOR[statusKey]}55`,
            padding: "3px 7px",
            borderRadius: 4,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {STATUS_LABEL[statusKey]}
        </span>
        <span
          style={{
            fontFamily: monoFont,
            fontSize: 10,
            color: "rgba(255,255,255,0.45)",
            flexShrink: 0,
          }}
        >
          #{row.id}
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

      {/* Subline: owner + page */}
      <div
        style={{
          marginTop: 6,
          fontFamily: monoFont,
          fontSize: 10,
          color: "rgba(255,255,255,0.5)",
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span>{row.owner_key ?? row.user_wallet ?? "anonymous"}</span>
        {row.page_context && <span>page: {row.page_context}</span>}
        {row.duplicate_of && <span>dup of #{row.duplicate_of}</span>}
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid #27272a",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {row.feedback_details && (
            <Field label="Details" value={row.feedback_details} />
          )}
          {row.user_message && (
            <Field label="Original Message" value={row.user_message} mono />
          )}
          {row.bot_response && (
            <Field label="Bot Response" value={row.bot_response} mono />
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))",
              gap: 8,
              fontFamily: monoFont,
              fontSize: 10,
              color: "rgba(255,255,255,0.5)",
            }}
          >
            <div>created {fmtIso(row.created_at)}</div>
            <div>updated {fmtIso(row.updated_at)}</div>
            <div>shipped {fmtIso(row.shipped_at)}</div>
            <div>session {row.session_id ?? "—"}</div>
          </div>

          {/* Toolbar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              paddingTop: 6,
            }}
          >
            <label
              style={{
                fontFamily: monoFont,
                fontSize: 10,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              Status
            </label>
            <select
              value={statusKey}
              disabled={statusSaving}
              onChange={(e) => onStatusChange(e.target.value as FeedbackStatus)}
              style={{
                padding: "6px 10px",
                background: "#0a0a0a",
                border: "1px solid #27272a",
                borderRadius: 6,
                color: "#fff",
                fontFamily: monoFont,
                fontSize: 12,
                cursor: statusSaving ? "default" : "pointer",
              }}
            >
              {(Object.keys(STATUS_LABEL) as FeedbackStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            {statusSaving && (
              <span
                style={{
                  fontFamily: monoFont,
                  fontSize: 10,
                  color: "rgba(255,255,255,0.4)",
                }}
              >
                saving…
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label
              style={{
                fontFamily: monoFont,
                fontSize: 10,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              Admin Note {noteSaving ? "(saving…)" : ""}
            </label>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={onNoteBlur}
              placeholder="Triage notes — saved on blur"
              rows={2}
              style={{
                padding: "8px 10px",
                background: "#0a0a0a",
                border: "1px solid #27272a",
                borderRadius: 6,
                color: "#fff",
                fontFamily: monoFont,
                fontSize: 12,
                resize: "vertical",
                outline: "none",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: monoFont,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.5)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? monoFont : condensedFont,
          fontWeight: mono ? 400 : 600,
          fontSize: mono ? 12 : 14,
          color: "rgba(255,255,255,0.85)",
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
        }}
      >
        {value}
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
