"use client";

// app/admin/flowty-errors/ErrorTriageClient.tsx
// Client-side interactivity for the /admin/flowty-errors triage console.
// Sign-in gate writes the token to the rpc_admin_token cookie + reloads so the
// server component can pick it up and SSR initial data. After that, all
// interactive fetches go through the three /api/admin/error-triage/* proxies
// with Authorization: Bearer <token>.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

// Shapes pinned from the SQL function returns — see set_error_triage_status,
// get_error_triage_summary, get_error_triage_dashboard, get_error_triage_instances.

export interface DashboardPayload {
  total_signatures: number;
  open: number;
  auto_fixable: number;
  needs_trevor: number;
  fixed: number;
  wontfix: number;
  pipeline_signatures: number;
  onchain_signatures: number;
  total_occurrences_24h: number;
  recent_unresolved: number;
}

export interface SummaryRow {
  signature: string;
  source: "pipeline" | "onchain";
  pipeline: string | null;
  category: string | null;
  subcategory: string | null;
  resolution_status: ResolutionStatus;
  auto_fixable_hint: boolean | null;
  occurrence_count: number;
  unique_addresses: number | null;
  first_seen: string | null;
  last_seen: string | null;
  fix_action: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  sample_error: string | null;
}

export type ResolutionStatus =
  | "open"
  | "auto_fixable"
  | "fixed"
  | "needs_trevor"
  | "wontfix"
  | "duplicate";

interface PipelineInstance {
  id: string | number;
  started_at: string | null;
  duration_ms: number | null;
  error: string | null;
  extra: unknown;
}

interface OnchainInstance {
  tx_hash: string | null;
  sealed_at: string | null;
  proposer: string | null;
  payer: string | null;
  collection: string | null;
  storefront_addr: string | null;
  error_message: string | null;
}

interface InstancesResponse {
  found: number;
  source: "pipeline" | "onchain" | null;
  pipeline?: string | null;
  instances: Array<PipelineInstance | OnchainInstance>;
}

type TabKey = "all" | "open" | "auto_fixable" | "needs_trevor" | "resolved";

interface Tab {
  key: TabKey;
  label: string;
  filter: string | null;
}

const TABS: Tab[] = [
  { key: "all", label: "All", filter: null },
  { key: "open", label: "Open", filter: "open" },
  { key: "auto_fixable", label: "Auto-fixable", filter: "auto_fixable" },
  { key: "needs_trevor", label: "Needs Trevor", filter: "needs_trevor" },
  { key: "resolved", label: "Resolved", filter: "resolved" },
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "open", label: "Open" },
  { value: "auto_fixable", label: "Auto-fixable" },
  { value: "fixed", label: "Fixed" },
  { value: "needs_trevor", label: "Needs Trevor" },
  { value: "wontfix", label: "Wontfix" },
  { value: "duplicate", label: "Duplicate" },
];

const RESOLVED_BY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "trevor", label: "Trevor" },
  { value: "auto", label: "Auto" },
];

// Status badge palette (per spec).
function statusBadgeStyle(status: string): React.CSSProperties {
  switch (status) {
    case "auto_fixable":
      return { color: "#22D3EE", borderColor: "rgba(34,211,238,0.45)", background: "rgba(34,211,238,0.08)" };
    case "needs_trevor":
      return { color: "var(--rpc-red)", borderColor: "var(--rpc-red-border)", background: "var(--rpc-red-bg)" };
    case "fixed":
      return { color: "var(--rpc-success)", borderColor: "rgba(52,211,153,0.45)", background: "rgba(52,211,153,0.08)" };
    case "wontfix":
    case "duplicate":
      return { color: "var(--rpc-text-muted)", borderColor: "var(--rpc-border)", background: "rgba(255,255,255,0.03)" };
    case "open":
    default:
      return { color: "rgba(255,255,255,0.75)", borderColor: "var(--rpc-border)", background: "rgba(255,255,255,0.04)" };
  }
}

function sourceBadgeStyle(source: string): React.CSSProperties {
  if (source === "pipeline") {
    return { color: "#A855F7", borderColor: "rgba(168,85,247,0.45)", background: "rgba(168,85,247,0.08)" };
  }
  if (source === "onchain") {
    return { color: "#F59E0B", borderColor: "rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.08)" };
  }
  return { color: "var(--rpc-text-muted)", borderColor: "var(--rpc-border)", background: "rgba(255,255,255,0.03)" };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

const COOKIE_NAME = "rpc_admin_token";
const TOKEN_KEY = "rpc_admin_token";

function getStoredToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function setStoredToken(t: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, t);
  } catch {}
  // 30-day cookie so the server component can pick it up on next request.
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(t)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
}

function clearStoredToken() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {}
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const ms = Date.now() - t;
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
  if (isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function truncSig(sig: string | null, len = 28): string {
  if (!sig) return "—";
  if (sig.length <= len) return sig;
  return `${sig.slice(0, len)}…`;
}

function truncAddr(addr: string | null): string {
  if (!addr) return "—";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function truncMid(s: string | null, len = 80): string {
  if (!s) return "—";
  if (s.length <= len) return s;
  return `${s.slice(0, len)}…`;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ErrorTriageClient({
  authed,
  initialDashboard,
  initialSummary,
  loadError,
}: {
  authed: boolean;
  initialDashboard: DashboardPayload | null;
  initialSummary: SummaryRow[];
  loadError: string | null;
}) {
  if (!authed) {
    return <SignInGate />;
  }
  return (
    <Console
      initialDashboard={initialDashboard}
      initialSummary={initialSummary}
      loadError={loadError}
    />
  );
}

// ─── Sign-in gate ────────────────────────────────────────────────────────────

function SignInGate() {
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Hydrate from any previously stored token so a stale cookie doesn't lock
  // Trevor out of the gate on first render.
  useEffect(() => {
    const stored = getStoredToken();
    if (stored && !input) setInput(stored);
    // We deliberately don't auto-submit — user clicks Sign In.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    const t = input.trim();
    if (!t) {
      setErr("Token required");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/error-triage/list", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({}),
        cache: "no-store",
      });
      if (res.status === 401) {
        setErr("Invalid token");
        return;
      }
      if (!res.ok) {
        setErr(`HTTP ${res.status}`);
        return;
      }
      setStoredToken(t);
      // Reload so the server component picks up the cookie and SSRs the dash.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={loadingScreenStyle}>
      <PageStyles />
      <div className="rpc-card" style={{ padding: 28, width: "100%", maxWidth: 380 }}>
        <div className="rpc-label" style={{ marginBottom: 6 }}>
          Rip Packs City
        </div>
        <div className="rpc-heading" style={{ fontSize: 24, marginBottom: 18 }}>
          Error Triage — Sign In
        </div>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="RPC_ADMIN_TOKEN"
          autoFocus
          className="rpc-filter-input"
          style={{ width: "100%", marginBottom: 12 }}
        />
        {err && (
          <div style={{ color: "var(--rpc-danger)", fontFamily: "var(--font-mono)", fontSize: 11, marginBottom: 10 }}>
            {err}
          </div>
        )}
        <button onClick={submit} disabled={submitting} className="rpc-btn-ghost" style={{ width: "100%" }}>
          {submitting ? "Checking…" : "Sign In"}
        </button>
      </div>
    </div>
  );
}

// ─── Main console ────────────────────────────────────────────────────────────

function Console({
  initialDashboard,
  initialSummary,
  loadError,
}: {
  initialDashboard: DashboardPayload | null;
  initialSummary: SummaryRow[];
  loadError: string | null;
}) {
  const [token, setToken] = useState<string>("");
  const [tab, setTab] = useState<TabKey>("all");
  const [rows, setRows] = useState<SummaryRow[]>(initialSummary);
  const [loadingRows, setLoadingRows] = useState(false);
  const [tabError, setTabError] = useState<string | null>(loadError);
  const [expandedSig, setExpandedSig] = useState<string | null>(null);

  useEffect(() => {
    setToken(getStoredToken());
  }, []);

  const onSignOut = () => {
    clearStoredToken();
    window.location.reload();
  };

  const fetchRows = useCallback(
    async (filter: string | null) => {
      const t = token || getStoredToken();
      if (!t) return;
      setLoadingRows(true);
      setTabError(null);
      try {
        const res = await fetch("/api/admin/error-triage/list", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
          body: JSON.stringify({ status_filter: filter }),
          cache: "no-store",
        });
        if (res.status === 401) {
          onSignOut();
          return;
        }
        const json = await res.json().catch(() => ({} as Record<string, unknown>));
        if (!res.ok) {
          setTabError((json as { error?: string }).error ?? `HTTP ${res.status}`);
          return;
        }
        setRows(((json as { rows?: SummaryRow[] }).rows ?? []) as SummaryRow[]);
      } catch (e) {
        setTabError(e instanceof Error ? e.message : "Network error");
      } finally {
        setLoadingRows(false);
      }
    },
    [token]
  );

  const onTabChange = (next: TabKey) => {
    if (next === tab) return;
    setTab(next);
    setExpandedSig(null);
    const def = TABS.find((t) => t.key === next);
    fetchRows(def?.filter ?? null);
  };

  const onRefresh = () => {
    const def = TABS.find((t) => t.key === tab);
    fetchRows(def?.filter ?? null);
  };

  // Optimistic patch when triage form saves a status — update the row in
  // place so the user sees their change without a full refetch.
  const onTriageSaved = useCallback((sig: string, patch: Partial<SummaryRow>) => {
    setRows((prev) => prev.map((r) => (r.signature === sig ? { ...r, ...patch } : r)));
  }, []);

  const dashboard = initialDashboard;

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", paddingBottom: 60 }}>
      <PageStyles />
      <main className="rpc-fe-main">
        {/* Header */}
        <section className="rpc-card" style={headerCardStyle}>
          <div>
            <div className="rpc-label">Rip Packs City</div>
            <div className="rpc-heading" style={{ fontSize: 26, marginTop: 2 }}>
              Error Triage
            </div>
            <div style={subHeaderStyle}>Pipeline + on-chain failure rollup · refresh_error_triage runs every 30 min</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onRefresh} className="rpc-filter-button">
              Refresh
            </button>
            <button onClick={onSignOut} className="rpc-filter-button">
              Sign Out
            </button>
          </div>
        </section>

        {/* KPI tiles */}
        <section className="rpc-fe-kpi-grid">
          <KpiTile label="Total Signatures" value={fmtInt(dashboard?.total_signatures)} />
          <KpiTile label="Occurrences (24h)" value={fmtInt(dashboard?.total_occurrences_24h)} />
          <KpiTile label="Recent Unresolved" value={fmtInt(dashboard?.recent_unresolved)} />
          <KpiTile label="Pipeline Signatures" value={fmtInt(dashboard?.pipeline_signatures)} accent="#A855F7" />
          <KpiTile label="Onchain Signatures" value={fmtInt(dashboard?.onchain_signatures)} accent="#F59E0B" />
        </section>

        {/* Tabs */}
        <section className="rpc-card" style={{ padding: "14px 16px" }}>
          <div className="rpc-fe-pills">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => onTabChange(t.key)}
                className={`rpc-filter-button${tab === t.key ? " rpc-filter-button--active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        {tabError && (
          <div style={errorBannerStyle}>{tabError}</div>
        )}

        {/* Table */}
        <section className="rpc-card" style={{ padding: 0, overflow: "hidden" }}>
          {loadingRows && rows.length === 0 ? (
            <div style={emptyStyle}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={emptyStyle}>No rows in this view.</div>
          ) : (
            <div className="rpc-fe-table-wrap">
              <table style={tableStyle}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                    <Th>Signature</Th>
                    <Th>Source</Th>
                    <Th>Pipeline / Storefront</Th>
                    <Th>Category</Th>
                    <Th>Subcategory</Th>
                    <Th align="right">Count</Th>
                    <Th align="right">Wallets</Th>
                    <Th>Last Seen</Th>
                    <Th>Status</Th>
                    <Th>Fix Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const sig = row.signature ?? `row-${i}`;
                    const source = row.source;
                    const pipelineOrStore = row.pipeline ?? "";
                    const category = row.category ?? "";
                    const subcategory = row.subcategory ?? "";
                    const occCount = row.occurrence_count;
                    const uniqAddrs = row.unique_addresses;
                    const lastSeen = row.last_seen;
                    const status = row.resolution_status;
                    const fixAction = row.fix_action;
                    const isOpen = expandedSig === sig;

                    return (
                      <Fragment key={`sig-${sig}-${i}`}>
                        <tr
                          onClick={() => setExpandedSig(isOpen ? null : sig)}
                          style={{
                            borderBottom: "1px solid rgba(255,255,255,0.04)",
                            cursor: "pointer",
                            background: isOpen ? "rgba(255,255,255,0.04)" : undefined,
                          }}
                        >
                          <Td>
                            <span title={sig} style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                              {truncSig(sig)}
                            </span>
                          </Td>
                          <Td>
                            <Badge text={source || "—"} style={sourceBadgeStyle(source)} />
                          </Td>
                          <Td>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} title={pipelineOrStore}>
                              {source === "onchain" ? truncAddr(pipelineOrStore) : pipelineOrStore || "—"}
                            </span>
                          </Td>
                          <Td>{category || "—"}</Td>
                          <Td>{subcategory || "—"}</Td>
                          <Td align="right">{fmtInt(occCount)}</Td>
                          <Td align="right">
                            {source === "onchain" ? fmtInt(uniqAddrs) : <span style={{ color: "var(--rpc-text-ghost)" }}>—</span>}
                          </Td>
                          <Td>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }} title={fmtIso(lastSeen)}>
                              {timeAgo(lastSeen)}
                            </span>
                          </Td>
                          <Td>
                            <Badge text={status} style={statusBadgeStyle(status)} />
                          </Td>
                          <Td>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }} title={fixAction ?? ""}>
                              {truncMid(fixAction, 40)}
                            </span>
                          </Td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={10} style={{ background: "rgba(255,255,255,0.02)", padding: 0, borderBottom: "1px solid var(--rpc-border)" }}>
                              <DrilldownPanel
                                token={token}
                                signature={sig}
                                source={source}
                                rowSnapshot={row}
                                onTriageSaved={(patch) => onTriageSaved(sig, patch)}
                                onUnauthorized={onSignOut}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ─── KPI tile + helpers ──────────────────────────────────────────────────────

function KpiTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rpc-stat-tile" style={{ padding: "14px 16px" }}>
      <div className="rpc-stat-eyebrow">{label}</div>
      <div className="rpc-stat-value" style={{ fontSize: 28, color: accent ?? "var(--rpc-text-primary)" }}>{value}</div>
    </div>
  );
}

function Badge({ text, style }: { text: string; style: React.CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 8px",
        borderRadius: 4,
        border: "1px solid",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        ...style,
      }}
    >
      {text}
    </span>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "10px 12px",
        color: "var(--rpc-text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "8px 12px",
        color: "var(--rpc-text-primary)",
        fontFamily: "var(--font-display)",
        fontSize: 13,
        verticalAlign: "middle",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}

// ─── Drilldown panel ─────────────────────────────────────────────────────────

function DrilldownPanel({
  token,
  signature,
  source,
  rowSnapshot,
  onTriageSaved,
  onUnauthorized,
}: {
  token: string;
  signature: string;
  source: "pipeline" | "onchain";
  rowSnapshot: SummaryRow;
  onTriageSaved: (patch: Partial<SummaryRow>) => void;
  onUnauthorized: () => void;
}) {
  const [instances, setInstances] = useState<Array<PipelineInstance | OnchainInstance>>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = token || getStoredToken();
    if (!t) return;
    setLoading(true);
    setErr(null);
    fetch("/api/admin/error-triage/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ signature, limit: 20 }),
      cache: "no-store",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          onUnauthorized();
          return;
        }
        const json = (await res.json().catch(() => ({}))) as InstancesResponse & { error?: string };
        if (!res.ok) {
          setErr(json.error ?? `HTTP ${res.status}`);
          return;
        }
        setInstances(Array.isArray(json.instances) ? json.instances : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Network error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [signature, token, onUnauthorized]);

  return (
    <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="rpc-label">Last 20 instances</div>
      {loading ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>Loading…</div>
      ) : err ? (
        <div style={errorBannerStyle}>{err}</div>
      ) : instances.length === 0 ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>No instances found.</div>
      ) : source === "pipeline" ? (
        <PipelineInstances rows={instances as PipelineInstance[]} />
      ) : (
        <OnchainInstances rows={instances as OnchainInstance[]} />
      )}

      <TriageForm
        token={token}
        signature={signature}
        rowSnapshot={rowSnapshot}
        onSaved={onTriageSaved}
        onUnauthorized={onUnauthorized}
      />
    </div>
  );
}

function PipelineInstances({ rows }: { rows: PipelineInstance[] }) {
  return (
    <div className="rpc-fe-table-wrap">
      <table style={instanceTableStyle}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rpc-border)" }}>
            <Th>ID</Th>
            <Th>Started</Th>
            <Th align="right">Duration</Th>
            <Th>Error</Th>
            <Th>Extra</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const id = String(r.id ?? "");
            const extraStr =
              r.extra && typeof r.extra === "object"
                ? safeJson(r.extra)
                : typeof r.extra === "string"
                  ? r.extra
                  : "";
            return (
              <tr key={`pi-${i}`} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <Td>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} title={id}>
                    {truncSig(id, 14)}
                  </span>
                </Td>
                <Td>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }} title={fmtIso(r.started_at)}>
                    {timeAgo(r.started_at)}
                  </span>
                </Td>
                <Td align="right">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                    {r.duration_ms == null ? "—" : `${r.duration_ms.toLocaleString()} ms`}
                  </span>
                </Td>
                <Td>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }} title={r.error ?? ""}>
                    {truncMid(r.error, 80)}
                  </span>
                </Td>
                <Td>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }} title={extraStr}>
                    {truncMid(extraStr, 60)}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function OnchainInstances({ rows }: { rows: OnchainInstance[] }) {
  return (
    <div className="rpc-fe-table-wrap">
      <table style={instanceTableStyle}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rpc-border)" }}>
            <Th>Tx Hash</Th>
            <Th>Sealed</Th>
            <Th>Proposer</Th>
            <Th>Payer</Th>
            <Th>Collection</Th>
            <Th>Storefront</Th>
            <Th>Error</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`oi-${i}`} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              <Td>
                {r.tx_hash ? (
                  <a
                    href={`https://flowscan.io/tx/${r.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--rpc-text-primary)",
                      textDecoration: "none",
                      borderBottom: "1px dotted var(--rpc-text-muted)",
                    }}
                    title={r.tx_hash}
                  >
                    {truncSig(r.tx_hash, 14)}
                  </a>
                ) : (
                  <span style={{ color: "var(--rpc-text-ghost)" }}>—</span>
                )}
              </Td>
              <Td>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }} title={fmtIso(r.sealed_at)}>
                  {timeAgo(r.sealed_at)}
                </span>
              </Td>
              <Td>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} title={r.proposer ?? ""}>
                  {truncAddr(r.proposer)}
                </span>
              </Td>
              <Td>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} title={r.payer ?? ""}>
                  {truncAddr(r.payer)}
                </span>
              </Td>
              <Td>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{r.collection ?? "—"}</span>
              </Td>
              <Td>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} title={r.storefront_addr ?? ""}>
                  {truncAddr(r.storefront_addr)}
                </span>
              </Td>
              <Td>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }} title={r.error_message ?? ""}>
                  {truncMid(r.error_message, 70)}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Triage form ─────────────────────────────────────────────────────────────

function TriageForm({
  token,
  signature,
  rowSnapshot,
  onSaved,
  onUnauthorized,
}: {
  token: string;
  signature: string;
  rowSnapshot: SummaryRow;
  onSaved: (patch: Partial<SummaryRow>) => void;
  onUnauthorized: () => void;
}) {
  const initialStatus = useMemo<ResolutionStatus>(
    () => rowSnapshot.resolution_status ?? "open",
    [rowSnapshot.resolution_status]
  );
  const initialFix = useMemo(() => rowSnapshot.fix_action ?? "", [rowSnapshot.fix_action]);
  const initialNotes = useMemo(() => rowSnapshot.resolution_notes ?? "", [rowSnapshot.resolution_notes]);
  const initialResolvedBy = useMemo(() => rowSnapshot.resolved_by ?? "", [rowSnapshot.resolved_by]);

  const [status, setStatus] = useState<ResolutionStatus>(initialStatus);
  const [fixAction, setFixAction] = useState<string>(initialFix);
  const [notes, setNotes] = useState<string>(initialNotes);
  const [resolvedBy, setResolvedBy] = useState<string>(initialResolvedBy);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const onSave = async () => {
    const t = token || getStoredToken();
    if (!t) {
      onUnauthorized();
      return;
    }
    setSaving(true);
    setErr(null);
    const fixActionPayload = fixAction.trim() || null;
    const notesPayload = notes.trim() || null;
    const resolvedByPayload = resolvedBy || null;
    try {
      const res = await fetch("/api/admin/error-triage/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          signature,
          status,
          fix_action: fixActionPayload,
          resolution_notes: notesPayload,
          resolved_by: resolvedByPayload,
        }),
        cache: "no-store",
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setSavedAt(Date.now());
      onSaved({
        resolution_status: status,
        fix_action: fixActionPayload,
        resolution_notes: notesPayload,
        resolved_by: resolvedByPayload,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rpc-card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="rpc-label">Triage</div>
      <div className="rpc-fe-form-grid">
        <FormField label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ResolutionStatus)}
            className="rpc-filter-select"
            style={{ width: "100%" }}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Resolved By">
          <select
            value={resolvedBy}
            onChange={(e) => setResolvedBy(e.target.value)}
            className="rpc-filter-select"
            style={{ width: "100%" }}
          >
            <option value="">—</option>
            {RESOLVED_BY_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="Fix Action">
        <textarea
          value={fixAction}
          onChange={(e) => setFixAction(e.target.value)}
          rows={2}
          className="rpc-filter-input"
          style={{ width: "100%", resize: "vertical" }}
          placeholder="e.g. tighten regex on flowty-tx-classifier RULES[7]"
        />
      </FormField>
      <FormField label="Resolution Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="rpc-filter-input"
          style={{ width: "100%", resize: "vertical" }}
          placeholder="Context for future-you"
        />
      </FormField>
      {err && <div style={{ color: "var(--rpc-danger)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{err}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onSave} disabled={saving} className="rpc-btn-ghost">
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-success)" }}>
            saved {timeAgo(new Date(savedAt).toISOString())}
          </span>
        )}
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="rpc-label">{label}</div>
      {children}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const loadingScreenStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--rpc-black)",
  color: "var(--rpc-text-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const headerCardStyle: React.CSSProperties = {
  padding: "16px 18px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
};

const subHeaderStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--rpc-text-muted)",
  marginTop: 4,
};

const errorBannerStyle: React.CSSProperties = {
  padding: "10px 14px",
  background: "rgba(248, 113, 113, 0.08)",
  border: "1px solid rgba(248, 113, 113, 0.4)",
  color: "var(--rpc-danger)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  borderRadius: "var(--radius-md)",
};

const emptyStyle: React.CSSProperties = {
  padding: 40,
  textAlign: "center",
  color: "var(--rpc-text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const instanceTableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "rgba(0,0,0,0.2)",
  borderRadius: "var(--radius-md)",
  overflow: "hidden",
};

function PageStyles() {
  return (
    <style>{`
      .rpc-fe-main {
        max-width: 1440px;
        margin: 0 auto;
        padding: 24px 20px 60px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .rpc-fe-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .rpc-fe-kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .rpc-fe-table-wrap {
        overflow-x: auto;
        max-width: 100%;
      }
      .rpc-fe-form-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      @media (max-width: 700px) {
        .rpc-fe-form-grid { grid-template-columns: 1fr; }
        .rpc-fe-kpi-grid { grid-template-columns: 1fr 1fr; }
      }
    `}</style>
  );
}
