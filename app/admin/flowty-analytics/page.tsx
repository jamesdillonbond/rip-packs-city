"use client";

// app/admin/flowty-analytics/page.tsx
// Trevor-only Flowty marketplace + lending intelligence dashboard.
// Bearer-gated via RPC_ADMIN_TOKEN against /api/admin/flowty-analytics.
// Token is pasted into a password input on first visit and cached in
// sessionStorage under "rpc_admin_token" — never read from a public env var.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// ─── Tokens / palette ────────────────────────────────────────────────────────

const TOKEN_KEY = "rpc_admin_token";

const COLLECTION_COLOR: Record<string, string> = {
  topshot: "#E03A2F",
  allday: "#1E40AF",
  golazos: "#7C3AED",
  ufc: "#F59E0B",
  pinnacle: "#DC2626",
};

const COLLECTION_LABEL: Record<string, string> = {
  all: "All",
  topshot: "Top Shot",
  allday: "AllDay",
  golazos: "Golazos",
  ufc: "UFC",
  pinnacle: "Pinnacle",
};

const COLLECTION_OPTIONS = ["all", "topshot", "allday", "golazos", "ufc", "pinnacle"] as const;
const COLLECTIONS_FOR_LINES = ["topshot", "allday", "golazos", "ufc", "pinnacle"] as const;

const PERIOD_OPTIONS = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "annual", label: "Annual" },
  { key: "all", label: "All Time" },
] as const;

type CollectionKey = (typeof COLLECTION_OPTIONS)[number];
type PeriodKey = (typeof PERIOD_OPTIONS)[number]["key"];

// ─── Response types ──────────────────────────────────────────────────────────

interface SalesPoint {
  bucket: string;
  collection: string;
  txCount: number;
  grossVolumeUsd: number;
  distinctBuyers?: number;
  distinctSellers?: number;
  activeBuyers?: number;
  activeSellers?: number;
}

interface LoansPoint {
  bucket: string;
  collection: string;
  loansFunded: number;
  principalFundedUsd: number;
  activeLenders: number;
  activeBorrowers: number;
}

interface ActivationPoint {
  bucket: string;
  collection: string;
  role: string;
  count: number;
}

interface Leader {
  rank: number;
  address?: string;
  [k: string]: unknown;
}

interface Summary {
  salesAllTimeVolumeUsd: number;
  salesAllTimeTxCount: number;
  loansAllTimeVolumeUsd: number;
  loansAllTimeCount: number;
  salesPeriodVolumeUsd: number;
  salesPeriodTxCount: number;
  loansPeriodVolumeUsd: number;
  loansPeriodCount: number;
  periodFirstTimeBuyers: number;
  periodFirstTimeSellers: number;
  periodFirstTimeLenders: number;
  periodFirstTimeBorrowers: number;
}

interface AnalyticsPayload {
  meta: { collection: string; period: string; start: string; end: string; bucket: string };
  refreshedAt: string | null;
  dataCaveats: string[];
  summary: Summary;
  salesTimeseries: SalesPoint[];
  loansTimeseries: LoansPoint[];
  activations: ActivationPoint[];
  leaderboards: {
    topBuyers: Leader[];
    topSellers: Leader[];
    topNetMarketplace: Leader[];
    topLenders: Leader[];
    topBorrowers: Leader[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) {
    return `$${Math.round(n).toLocaleString("en-US")}`;
  }
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  // Accept both 0.12 and 12 forms — assume <= 1 means decimal.
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  return `${pct.toFixed(2)}%`;
}

function truncAddr(addr: string | null | undefined): string {
  if (!addr) return "—";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Recharts v3's tooltip Formatter signature is too strict to satisfy with a
// narrow lambda, so cast through `any` at the boundary.
const currencyFormatter = ((value: unknown) => fmtCurrency(Number(value))) as never;
const intFormatter = ((value: unknown) => fmtInt(Number(value))) as never;

// Pivot timeseries from long form ({bucket, collection, ...}) into wide form
// for recharts: [{bucket, [collection]: value, ...}].
function pivot<T extends { bucket: string; collection: string }>(
  rows: T[],
  metric: keyof T,
  collections: readonly string[]
): Array<Record<string, string | number>> {
  const map = new Map<string, Record<string, string | number>>();
  for (const r of rows) {
    if (!collections.includes(r.collection)) continue;
    const existing = map.get(r.bucket) ?? { bucket: r.bucket };
    const v = r[metric];
    if (typeof v === "number") existing[r.collection] = (existing[r.collection] as number ?? 0) + v;
    map.set(r.bucket, existing);
  }
  // Make sure every collection has 0 fill so recharts doesn't break the line.
  const out = Array.from(map.values()).sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket))
  );
  for (const row of out) {
    for (const c of collections) {
      if (!(c in row)) row[c] = 0;
    }
  }
  return out;
}

// Pull either distinct* (daily) or active* (non-daily) field from a SalesPoint.
function pickSalesActor(p: SalesPoint, kind: "buyers" | "sellers"): number {
  if (kind === "buyers") return p.distinctBuyers ?? p.activeBuyers ?? 0;
  return p.distinctSellers ?? p.activeSellers ?? 0;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function FlowtyAnalyticsPage() {
  const [token, setToken] = useState<string>("");
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      setAuthChecked(true);
      return;
    }
    const stored = window.sessionStorage.getItem(TOKEN_KEY);
    if (stored) setToken(stored);
    setAuthChecked(true);
  }, []);

  if (!authChecked) {
    return (
      <div style={loadingScreenStyle}>
        <div style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--rpc-text-muted)" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <SignInGate
        onSignedIn={(t) => {
          if (typeof window !== "undefined") window.sessionStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }

  return (
    <Dashboard
      token={token}
      onSignOut={() => {
        if (typeof window !== "undefined") window.sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
      }}
    />
  );
}

// ─── Sign-in gate ────────────────────────────────────────────────────────────

function SignInGate({ onSignedIn }: { onSignedIn: (t: string) => void }) {
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const t = input.trim();
    if (!t) {
      setErr("Token required");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/flowty-analytics?period=monthly&collection=all", {
        headers: { Authorization: `Bearer ${t}` },
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
      onSignedIn(t);
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
          Flowty Analytics — Sign In
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

// ─── Dashboard ───────────────────────────────────────────────────────────────

function Dashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [collection, setCollection] = useState<CollectionKey>("all");
  const [period, setPeriod] = useState<PeriodKey>("monthly");
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/flowty-analytics?collection=${collection}&period=${period}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
      );
      if (res.status === 401) {
        onSignOut();
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(j?.error || `HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as AnalyticsPayload;
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [collection, period, token, onSignOut]);

  useEffect(() => {
    load();
  }, [load]);

  // Per-collection or single-collection lines depending on filter.
  const lineCollections = useMemo<readonly string[]>(
    () => (collection === "all" ? COLLECTIONS_FOR_LINES : [collection]),
    [collection]
  );

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", paddingBottom: 60 }}>
      <PageStyles />

      <main className="rpc-fa-main">
        {/* Header */}
        <section className="rpc-card" style={{ padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="rpc-label">Rip Packs City</div>
            <div className="rpc-heading" style={{ fontSize: 26, marginTop: 2 }}>
              Flowty Analytics
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 4 }}>
              Marketplace + lending intelligence
              {data?.refreshedAt && <> · refreshed {data.refreshedAt}</>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={load} className="rpc-filter-button">
              Refresh
            </button>
            <button onClick={onSignOut} className="rpc-filter-button">
              Sign Out
            </button>
          </div>
        </section>

        {/* Controls */}
        <section className="rpc-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div className="rpc-label" style={{ marginBottom: 6 }}>Collection</div>
            <div className="rpc-fa-pills">
              {COLLECTION_OPTIONS.map((c) => (
                <button
                  key={c}
                  onClick={() => setCollection(c)}
                  className={`rpc-filter-button${collection === c ? " rpc-filter-button--active" : ""}`}
                >
                  {COLLECTION_LABEL[c]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="rpc-label" style={{ marginBottom: 6 }}>Period</div>
            <div className="rpc-fa-pills">
              {PERIOD_OPTIONS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={`rpc-filter-button${period === p.key ? " rpc-filter-button--active" : ""}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Caveats */}
        {data?.dataCaveats && data.dataCaveats.length > 0 && (
          <section
            style={{
              background: "rgba(245, 158, 11, 0.08)",
              border: "1px solid rgba(245, 158, 11, 0.35)",
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "#FBBF24",
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, letterSpacing: "0.12em", marginBottom: 6 }}>DATA CAVEATS</div>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {data.dataCaveats.map((c, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{c}</li>
              ))}
            </ul>
          </section>
        )}

        {err && (
          <div
            style={{
              padding: "10px 14px",
              background: "rgba(248, 113, 113, 0.08)",
              border: "1px solid rgba(248, 113, 113, 0.4)",
              color: "var(--rpc-danger)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              borderRadius: "var(--radius-md)",
            }}
          >
            {err}
          </div>
        )}

        {loading && !data ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            Loading…
          </div>
        ) : data ? (
          <>
            <SalesSection data={data} bucket={data.meta.bucket} lineCollections={lineCollections} />
            <ParticipantsSection data={data} bucket={data.meta.bucket} lineCollections={lineCollections} />
            <LoansSection data={data} bucket={data.meta.bucket} lineCollections={lineCollections} />
            <LeaderboardsSection data={data} />
          </>
        ) : null}
      </main>
    </div>
  );
}

// ─── Section: Sales Volume ───────────────────────────────────────────────────

function SalesSection({
  data,
  bucket,
  lineCollections,
}: {
  data: AnalyticsPayload;
  bucket: string;
  lineCollections: readonly string[];
}) {
  const volumeData = useMemo(
    () => pivot(data.salesTimeseries, "grossVolumeUsd", lineCollections),
    [data.salesTimeseries, lineCollections]
  );
  const txData = useMemo(
    () => pivot(data.salesTimeseries, "txCount", lineCollections),
    [data.salesTimeseries, lineCollections]
  );

  return (
    <section className="rpc-card" style={sectionStyle}>
      <SectionHeader title="Sales Volume" subtitle={`bucket: ${bucket}`} />

      <KpiStrip
        items={[
          { label: "All-Time Volume", value: fmtCurrency(data.summary.salesAllTimeVolumeUsd) },
          { label: "All-Time Sales", value: fmtInt(data.summary.salesAllTimeTxCount) },
          { label: "Period Volume", value: fmtCurrency(data.summary.salesPeriodVolumeUsd) },
          { label: "Period Sales", value: fmtInt(data.summary.salesPeriodTxCount) },
        ]}
      />

      <ChartShell title="Gross Volume (USD)">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={volumeData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
            <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} tickFormatter={(v) => fmtCurrency(Number(v))} width={70} />
            <Tooltip {...tooltipStyle} formatter={currencyFormatter} />
            <Legend wrapperStyle={legendWrapper} />
            {lineCollections.map((c) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                stroke={COLLECTION_COLOR[c]}
                name={COLLECTION_LABEL[c]}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartShell>

      <ChartShell title="Transaction Count">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={txData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
            <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} width={50} />
            <Tooltip {...tooltipStyle} formatter={intFormatter} />
            <Legend wrapperStyle={legendWrapper} />
            {lineCollections.map((c) => (
              <Bar key={c} dataKey={c} fill={COLLECTION_COLOR[c]} name={COLLECTION_LABEL[c]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartShell>
    </section>
  );
}

// ─── Section: Marketplace Participants ───────────────────────────────────────

function ParticipantsSection({
  data,
  bucket,
  lineCollections,
}: {
  data: AnalyticsPayload;
  bucket: string;
  lineCollections: readonly string[];
}) {
  const isDaily = bucket === "day";
  const buyersLabel = isDaily ? "Distinct Buyers" : "Active Buyers (daily-sum upper bound)";
  const sellersLabel = isDaily ? "Distinct Sellers" : "Active Sellers (daily-sum upper bound)";

  // Build a buyers/sellers wide series from sales timeseries.
  const buyersWide = useMemo(() => {
    const synthetic = data.salesTimeseries.map((p) => ({
      bucket: p.bucket,
      collection: p.collection,
      value: pickSalesActor(p, "buyers"),
    }));
    return pivot(synthetic, "value", lineCollections);
  }, [data.salesTimeseries, lineCollections]);

  const sellersWide = useMemo(() => {
    const synthetic = data.salesTimeseries.map((p) => ({
      bucket: p.bucket,
      collection: p.collection,
      value: pickSalesActor(p, "sellers"),
    }));
    return pivot(synthetic, "value", lineCollections);
  }, [data.salesTimeseries, lineCollections]);

  return (
    <section className="rpc-card" style={sectionStyle}>
      <SectionHeader title="Marketplace Participants" subtitle={`bucket: ${bucket}`} />

      <div className="rpc-fa-two-up">
        <ChartShell title={buyersLabel}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={buyersWide} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} width={50} />
              <Tooltip {...tooltipStyle} formatter={intFormatter} />
              <Legend wrapperStyle={legendWrapper} />
              {lineCollections.map((c) => (
                <Line
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stroke={COLLECTION_COLOR[c]}
                  name={COLLECTION_LABEL[c]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartShell>

        <ChartShell title={sellersLabel}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sellersWide} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} width={50} />
              <Tooltip {...tooltipStyle} formatter={intFormatter} />
              <Legend wrapperStyle={legendWrapper} />
              {lineCollections.map((c) => (
                <Line
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stroke={COLLECTION_COLOR[c]}
                  name={COLLECTION_LABEL[c]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartShell>
      </div>

      <div className="rpc-fa-cards-row">
        <BigCard label="First-Time Buyers (period)" value={fmtInt(data.summary.periodFirstTimeBuyers)} accent="#34D399" />
        <BigCard label="First-Time Sellers (period)" value={fmtInt(data.summary.periodFirstTimeSellers)} accent="#34D399" />
        <BigCard label="First-Time Buyers (lifetime)" value="—" accent="rgba(255,255,255,0.4)" footnote="lifetime totals coming" />
        <BigCard label="First-Time Sellers (lifetime)" value="—" accent="rgba(255,255,255,0.4)" footnote="lifetime totals coming" />
      </div>
    </section>
  );
}

// ─── Section: Loan Volume ────────────────────────────────────────────────────

function LoansSection({
  data,
  bucket,
  lineCollections,
}: {
  data: AnalyticsPayload;
  bucket: string;
  lineCollections: readonly string[];
}) {
  const principalData = useMemo(
    () => pivot(data.loansTimeseries, "principalFundedUsd", lineCollections),
    [data.loansTimeseries, lineCollections]
  );
  const fundedData = useMemo(
    () => pivot(data.loansTimeseries, "loansFunded", lineCollections),
    [data.loansTimeseries, lineCollections]
  );
  const lendersData = useMemo(
    () => pivot(data.loansTimeseries, "activeLenders", lineCollections),
    [data.loansTimeseries, lineCollections]
  );
  const borrowersData = useMemo(
    () => pivot(data.loansTimeseries, "activeBorrowers", lineCollections),
    [data.loansTimeseries, lineCollections]
  );

  return (
    <section className="rpc-card" style={sectionStyle}>
      <SectionHeader title="Loan Volume" subtitle={`bucket: ${bucket}`} />

      <KpiStrip
        items={[
          { label: "All-Time Principal", value: fmtCurrency(data.summary.loansAllTimeVolumeUsd) },
          { label: "All-Time Loans", value: fmtInt(data.summary.loansAllTimeCount) },
          { label: "Period Principal", value: fmtCurrency(data.summary.loansPeriodVolumeUsd) },
          { label: "Period Loans", value: fmtInt(data.summary.loansPeriodCount) },
        ]}
      />

      <ChartShell title="Principal Funded (USD)">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={principalData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
            <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} tickFormatter={(v) => fmtCurrency(Number(v))} width={70} />
            <Tooltip {...tooltipStyle} formatter={currencyFormatter} />
            <Legend wrapperStyle={legendWrapper} />
            {lineCollections.map((c) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                stroke={COLLECTION_COLOR[c]}
                name={COLLECTION_LABEL[c]}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartShell>

      <ChartShell title="Loans Funded">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={fundedData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
            <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} width={50} />
            <Tooltip {...tooltipStyle} formatter={intFormatter} />
            <Legend wrapperStyle={legendWrapper} />
            {lineCollections.map((c) => (
              <Bar key={c} dataKey={c} fill={COLLECTION_COLOR[c]} name={COLLECTION_LABEL[c]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartShell>

      <div className="rpc-fa-two-up">
        <ChartShell title="Active Lenders">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lendersData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} width={50} />
              <Tooltip {...tooltipStyle} formatter={intFormatter} />
              <Legend wrapperStyle={legendWrapper} />
              {lineCollections.map((c) => (
                <Line
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stroke={COLLECTION_COLOR[c]}
                  name={COLLECTION_LABEL[c]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartShell>

        <ChartShell title="Active Borrowers">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={borrowersData} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="bucket" stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} width={50} />
              <Tooltip {...tooltipStyle} formatter={intFormatter} />
              <Legend wrapperStyle={legendWrapper} />
              {lineCollections.map((c) => (
                <Line
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stroke={COLLECTION_COLOR[c]}
                  name={COLLECTION_LABEL[c]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartShell>
      </div>

      <div className="rpc-fa-cards-row">
        <BigCard label="First-Time Lenders (period)" value={fmtInt(data.summary.periodFirstTimeLenders)} accent="#3B82F6" />
        <BigCard label="First-Time Borrowers (period)" value={fmtInt(data.summary.periodFirstTimeBorrowers)} accent="#3B82F6" />
      </div>
    </section>
  );
}

// ─── Section: Leaderboards ───────────────────────────────────────────────────

function LeaderboardsSection({ data }: { data: AnalyticsPayload }) {
  return (
    <section className="rpc-card" style={sectionStyle}>
      <SectionHeader title="Leaderboards" subtitle="Top 25 over selected period" />

      <div className="rpc-fa-leaderboards">
        <LeaderboardCard
          title="Top Buyers"
          rows={data.leaderboards.topBuyers}
          columns={[
            { key: "rank", label: "#", render: (r) => <span style={rankStyle}>{r.rank}</span> },
            { key: "address", label: "Address", render: (r) => <AddressLink addr={getStr(r.address)} /> },
            { key: "volumeUsd", label: "Volume", align: "right", render: (r) => fmtCurrency(getNum(r.volumeUsd)) },
            { key: "txCount", label: "Tx", align: "right", render: (r) => fmtInt(getNum(r.txCount)) },
          ]}
        />
        <LeaderboardCard
          title="Top Sellers"
          rows={data.leaderboards.topSellers}
          columns={[
            { key: "rank", label: "#", render: (r) => <span style={rankStyle}>{r.rank}</span> },
            { key: "address", label: "Address", render: (r) => <AddressLink addr={getStr(r.address)} /> },
            { key: "volumeUsd", label: "Volume", align: "right", render: (r) => fmtCurrency(getNum(r.volumeUsd)) },
            { key: "txCount", label: "Tx", align: "right", render: (r) => fmtInt(getNum(r.txCount)) },
          ]}
        />
        <LeaderboardCard
          title="Top Net Marketplace"
          rows={data.leaderboards.topNetMarketplace}
          columns={[
            { key: "rank", label: "#", render: (r) => <span style={rankStyle}>{r.rank}</span> },
            { key: "address", label: "Address", render: (r) => <AddressLink addr={getStr(r.address)} /> },
            { key: "grossActivityUsd", label: "Gross", align: "right", render: (r) => fmtCurrency(getNum(r.grossActivityUsd)) },
            { key: "netPositionUsd", label: "Net", align: "right", render: (r) => {
              const v = getNum(r.netPositionUsd);
              const color = v == null ? "var(--rpc-text-primary)" : v >= 0 ? "var(--rpc-success)" : "var(--rpc-danger)";
              return <span style={{ color }}>{fmtCurrency(v)}</span>;
            } },
            { key: "totalTxCount", label: "Tx", align: "right", render: (r) => fmtInt(getNum(r.totalTxCount)) },
          ]}
        />
        <LeaderboardCard
          title="Top Lenders"
          rows={data.leaderboards.topLenders}
          columns={[
            { key: "rank", label: "#", render: (r) => <span style={rankStyle}>{r.rank}</span> },
            { key: "address", label: "Address", render: (r) => <AddressLink addr={getStr(r.address)} /> },
            { key: "principalFundedUsd", label: "Principal", align: "right", render: (r) => fmtCurrency(getNum(r.principalFundedUsd)) },
            { key: "loansCount", label: "Loans", align: "right", render: (r) => fmtInt(getNum(r.loansCount)) },
            { key: "avgInterestRate", label: "Avg APR", align: "right", render: (r) => fmtPct(getNum(r.avgInterestRate)) },
          ]}
        />
        <LeaderboardCard
          title="Top Borrowers"
          rows={data.leaderboards.topBorrowers}
          columns={[
            { key: "rank", label: "#", render: (r) => <span style={rankStyle}>{r.rank}</span> },
            { key: "address", label: "Address", render: (r) => <AddressLink addr={getStr(r.address)} /> },
            { key: "principalBorrowedUsd", label: "Borrowed", align: "right", render: (r) => fmtCurrency(getNum(r.principalBorrowedUsd)) },
            { key: "loansCount", label: "Loans", align: "right", render: (r) => fmtInt(getNum(r.loansCount)) },
            { key: "repaidCount", label: "Repaid", align: "right", render: (r) => {
              const repaid = getNum(r.repaidCount);
              const total = getNum(r.loansCount);
              return (
                <span style={{ color: "var(--rpc-text-secondary)" }}>
                  {fmtInt(repaid)} of {fmtInt(total)} repaid
                </span>
              );
            } },
          ]}
        />
      </div>
    </section>
  );
}

// ─── Reusable bits ───────────────────────────────────────────────────────────

function getStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function getNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return isNaN(n) ? null : n;
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
      <div className="rpc-heading" style={{ fontSize: 20 }}>{title}</div>
      {subtitle && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function ChartShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="rpc-label" style={{ marginBottom: 6 }}>{title}</div>
      <div style={{ width: "100%", height: 280 }}>{children}</div>
    </div>
  );
}

function KpiStrip({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="rpc-fa-kpi-strip">
      {items.map((it) => (
        <div key={it.label} className="rpc-stat-tile" style={{ padding: "10px 14px" }}>
          <div className="rpc-stat-eyebrow">{it.label}</div>
          <div className="rpc-stat-value" style={{ fontSize: 22 }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function BigCard({ label, value, accent, footnote }: { label: string; value: string; accent: string; footnote?: string }) {
  return (
    <div className="rpc-stat-tile" style={{ padding: "14px 16px" }}>
      <div className="rpc-stat-eyebrow">{label}</div>
      <div className="rpc-stat-value" style={{ color: accent, fontSize: 28 }}>{value}</div>
      {footnote && (
        <div className="rpc-stat-caption" style={{ color: "var(--rpc-text-ghost)" }}>{footnote}</div>
      )}
    </div>
  );
}

function AddressLink({ addr }: { addr: string | null }) {
  if (!addr) return <span style={{ color: "var(--rpc-text-muted)" }}>—</span>;
  return (
    <Link
      href={`https://www.flowdiver.io/account/${addr}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: "var(--rpc-text-primary)",
        textDecoration: "none",
        borderBottom: "1px dotted var(--rpc-text-muted)",
      }}
    >
      {truncAddr(addr)}
    </Link>
  );
}

interface Column {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (row: Leader) => React.ReactNode;
}

function LeaderboardCard({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: Leader[];
  columns: Column[];
}) {
  return (
    <div className="rpc-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column" }}>
      <div className="rpc-heading" style={{ fontSize: 16, marginBottom: 10 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", padding: "16px 0" }}>
          No data for the selected period.
        </div>
      ) : (
        <div className="rpc-fa-table-wrap">
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    style={{
                      textAlign: col.align ?? "left",
                      padding: "6px 8px",
                      color: "var(--rpc-text-muted)",
                      fontSize: 10,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      fontWeight: 600,
                    }}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        textAlign: col.align ?? "left",
                        padding: "8px 8px",
                        color: "var(--rpc-text-primary)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const loadingScreenStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--rpc-black, #080808)",
  color: "var(--rpc-text-primary, #F1F1F1)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const sectionStyle: React.CSSProperties = {
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const rankStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--rpc-text-muted)",
  letterSpacing: "0.05em",
};

const tooltipStyle = {
  contentStyle: {
    background: "rgba(13,13,13,0.95)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 6,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "#F1F1F1",
  },
  labelStyle: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 10,
    letterSpacing: "0.08em",
  },
  itemStyle: {
    color: "#F1F1F1",
  },
} as const;

const legendWrapper: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "rgba(255,255,255,0.7)",
  paddingTop: 4,
};

function PageStyles() {
  return (
    <style>{`
      .rpc-fa-main {
        max-width: 1280px;
        margin: 0 auto;
        padding: 24px 20px 60px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .rpc-fa-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .rpc-fa-kpi-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        margin-top: 12px;
      }
      .rpc-fa-two-up {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
      }
      .rpc-fa-cards-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }
      .rpc-fa-leaderboards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        margin-top: 8px;
      }
      .rpc-fa-table-wrap {
        overflow-x: auto;
        max-width: 100%;
      }
      @media (max-width: 900px) {
        .rpc-fa-two-up { grid-template-columns: 1fr; }
        .rpc-fa-leaderboards { grid-template-columns: 1fr; }
      }
      @media (max-width: 600px) {
        .rpc-fa-main { padding: 16px 12px 40px; gap: 12px; }
        .rpc-fa-kpi-strip { grid-template-columns: 1fr 1fr; }
      }
    `}</style>
  );
}
