"use client";

// app/admin/analytics/page.tsx
// Trevor-only single-pane platform analytics overview.
// Bearer-gated via RPC_ADMIN_TOKEN against /api/admin/analytics-overview.
// Token is pasted into a password input on first visit and cached in
// localStorage under "rpc_admin_token" (same key as flowty-analytics).
// Auto-refreshes every 60s.

import { useCallback, useEffect, useState } from "react";
import { usdSignFirst } from "@/lib/usd-format"

const TOKEN_KEY = "rpc_admin_token";
const REFRESH_MS = 60_000;

interface UsersBlock {
  total_signups?: number;
  active_24h?: number;
  active_7d?: number;
  new_7d?: number;
  allowed?: number;
  saved_wallets?: number;
  users_with_wallets?: number;
}

interface MonetizationBlock {
  active_pro?: number;
  founding?: number;
  paid?: number;
  grandfathered?: number;
  moment_paid?: number;
  stripe_payments_lifetime?: number;
  moment_payments_lifetime?: number;
  stripe_revenue_30d?: number;
}

interface PipelinesBlock {
  runs_24h?: number;
  errors_24h?: number;
  success_pct?: number;
  distinct_pipelines_active_24h?: number;
}

interface InsiderSignalsBlock {
  alerts_24h?: number;
  critical_24h?: number;
  distinct_types?: number;
  by_type?: Record<string, number>;
}

interface EmailBlock {
  total?: number;
  verified?: number;
  deal_alerts_optin?: number;
  weekly_digest_optin?: number;
}

interface TradeHubBlock {
  wishlist_items?: number;
  active_offers?: number;
  pending_matches?: number;
  users_with_wishlist?: number;
}

// 2026-10-11 (platform review M3): the traction snapshot from
// get_rpc_traction_activity(), attached by the API as `traction`. Every field is
// optional/nullable ON PURPOSE: a missing block is a failed read, rendered "—"
// with `traction_error`, never a 0. The return rates are null over an empty
// cohort (the function refuses to divide by nobody).
export interface TractionBlock {
  generated_at?: string;
  basis?: string;
  accounts_total?: number | null;
  signups_7d?: number | null;
  signups_30d?: number | null;
  wau?: number | null;
  mau?: number | null;
  d7_cohort?: number | null;
  d7_returned?: number | null;
  d7_return_pct?: number | null;
  d30_cohort?: number | null;
  d30_returned?: number | null;
  d30_return_pct?: number | null;
}

interface OverviewPayload {
  generated_at?: string;
  traction?: TractionBlock | null;
  traction_error?: string | null;
  users?: UsersBlock;
  monetization?: MonetizationBlock;
  pipelines?: PipelinesBlock;
  feature_engagement_7d?: Record<string, number>;
  insider_signals?: InsiderSignalsBlock;
  email?: EmailBlock;
  trade_hub?: TradeHubBlock;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function fmtCurrency(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtCurrency); if (neg !== null) return neg
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export default function AdminAnalyticsClient() {
  const [token, setToken] = useState<string>("");
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      setAuthChecked(true);
      return;
    }
    const stored = window.localStorage.getItem(TOKEN_KEY);
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
          if (typeof window !== "undefined") window.localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }

  return (
    <Dashboard
      token={token}
      onSignOut={() => {
        if (typeof window !== "undefined") window.localStorage.removeItem(TOKEN_KEY);
        setToken("");
      }}
    />
  );
}

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
      const res = await fetch("/api/admin/analytics-overview", {
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
          Platform Analytics — Sign In
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

function Dashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/analytics-overview", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        onSignOut();
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(j?.error || `HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as OverviewPayload;
      setData(json);
      setLastFetched(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [token, onSignOut]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", paddingBottom: 60 }}>
      <PageStyles />

      <main className="rpc-ao-main">
        <section className="rpc-card" style={{ padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="rpc-label">Rip Packs City</div>
            <div className="rpc-heading" style={{ fontSize: 26, marginTop: 2 }}>
              Platform Analytics
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 4 }}>
              Single-pane overview · auto-refresh 60s
              {data?.generated_at && <> · snapshot {data.generated_at}</>}
              {/* hydration-safe: `lastFetched` is useState<Date|null>(null),
                  set only in the client load(), so it is null at SSR and the
                  fragment is gated on it. Unpinned on purpose — an operator
                  reading a fetch clock wants their own zone. */}
              {lastFetched && <> · fetched {lastFetched.toLocaleTimeString("en-US")}</>}
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
            <TractionPanel traction={data.traction ?? null} error={data.traction_error ?? null} />
            <UsersPanel users={data.users ?? {}} />
            <MonetizationPanel monetization={data.monetization ?? {}} />
            <PipelinesPanel pipelines={data.pipelines ?? {}} />
            <InsiderSignalsPanel signals={data.insider_signals ?? {}} />
            <FeatureEngagementPanel engagement={data.feature_engagement_7d ?? {}} />
            <EmailTradeHubPanel email={data.email ?? {}} tradeHub={data.trade_hub ?? {}} />
          </>
        ) : null}
      </main>
    </div>
  );
}

function PanelHeader({ title, subtitle }: { title: string; subtitle?: string }) {
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

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rpc-stat-tile" style={{ padding: "12px 14px" }}>
      <div className="rpc-stat-eyebrow">{label}</div>
      <div className="rpc-stat-value" style={{ color: accent ?? "var(--rpc-text-primary)", fontSize: 24 }}>
        {value}
      </div>
    </div>
  );
}

/**
 * The roadmap's gate, as tiles: WAU / MAU / signups / D7 + D30 return, all
 * excluding internal_accounts (the SQL does the exclusion; this only renders).
 *
 * ⚠ THREE STATES, not two. `traction === null` is a FAILED READ (or a not-yet-
 * applied function): every tile reads "—" and the error is printed beside the
 * header — this is an operator page behind a shared secret, so the driver
 * message is the diagnostic, not a leak. A null RATE inside a good payload is an
 * EMPTY COHORT and also "—"; a measured 0 renders as 0. `fmtInt`/`fmtPct` already
 * map null → "—", so nothing here can turn an absence into a number.
 */
export function TractionPanel({ traction, error }: { traction: TractionBlock | null; error: string | null }) {
  const t = traction ?? {};
  const failed = traction === null;
  const cohort = (n: number | null | undefined, r: number | null | undefined) =>
    n == null ? "cohort unread" : `${fmtInt(r)} of ${fmtInt(n)}`;
  return (
    <section className="rpc-card" style={sectionStyle} data-testid="traction-panel" data-state={failed ? "read-failed" : "ok"}>
      <PanelHeader title="Traction" subtitle="the 100-WAU gate · excludes internal accounts" />
      {failed && (
        <div
          role="status"
          style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-red-text)", marginBottom: 10 }}
        >
          Traction snapshot could not be read — tiles show a dash, not zero.{error ? ` ${error}` : ""}
        </div>
      )}
      <div className="rpc-ao-tiles">
        <Tile label="WAU (7d)" value={fmtInt(t.wau)} accent="#34D399" />
        <Tile label="MAU (30d)" value={fmtInt(t.mau)} accent="#34D399" />
        <Tile label="Accounts" value={fmtInt(t.accounts_total)} />
        <Tile label="Signups 7d" value={fmtInt(t.signups_7d)} />
        <Tile label="Signups 30d" value={fmtInt(t.signups_30d)} />
        <Tile label="D7 return" value={fmtPct(t.d7_return_pct)} />
        <Tile label="D30 return" value={fmtPct(t.d30_return_pct)} />
      </div>
      {!failed && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 8, lineHeight: 1.6 }}>
          D7: {cohort(t.d7_cohort, t.d7_returned)} returned · D30: {cohort(t.d30_cohort, t.d30_returned)} returned
          {t.basis ? <> · {t.basis}</> : null}
        </div>
      )}
    </section>
  );
}

function UsersPanel({ users }: { users: UsersBlock }) {
  return (
    <section className="rpc-card" style={sectionStyle}>
      <PanelHeader title="Users" subtitle="signups + activity" />
      <div className="rpc-ao-tiles">
        <Tile label="Total Signups" value={fmtInt(users.total_signups)} />
        <Tile label="Active 24h" value={fmtInt(users.active_24h)} accent="#34D399" />
        <Tile label="Active 7d" value={fmtInt(users.active_7d)} accent="#34D399" />
        <Tile label="New 7d" value={fmtInt(users.new_7d)} />
        <Tile label="Allow List" value={fmtInt(users.allowed)} />
        <Tile label="Saved Wallets" value={fmtInt(users.saved_wallets)} />
        <Tile label="Users w/ Wallets" value={fmtInt(users.users_with_wallets)} />
      </div>
    </section>
  );
}

function MonetizationPanel({ monetization }: { monetization: MonetizationBlock }) {
  return (
    <section className="rpc-card" style={sectionStyle}>
      <PanelHeader title="Monetization" subtitle="pro + payments" />
      <div className="rpc-ao-tiles">
        <Tile label="Active Pro" value={fmtInt(monetization.active_pro)} accent="var(--rpc-red)" />
        <Tile label="Founding" value={fmtInt(monetization.founding)} />
        <Tile label="Paid" value={fmtInt(monetization.paid)} />
        <Tile label="Grandfathered" value={fmtInt(monetization.grandfathered)} />
        <Tile label="Moment Paid" value={fmtInt(monetization.moment_paid)} />
        <Tile label="Stripe Lifetime" value={fmtInt(monetization.stripe_payments_lifetime)} />
        <Tile label="Moment Lifetime" value={fmtInt(monetization.moment_payments_lifetime)} />
        <Tile label="Stripe Rev 30d" value={fmtCurrency(monetization.stripe_revenue_30d)} accent="#34D399" />
      </div>
    </section>
  );
}

function PipelinesPanel({ pipelines }: { pipelines: PipelinesBlock }) {
  const ok = (pipelines.success_pct ?? 0) >= 99 ? "#34D399" : (pipelines.success_pct ?? 0) >= 95 ? "#F59E0B" : "var(--rpc-danger)";
  return (
    <section className="rpc-card" style={sectionStyle}>
      <PanelHeader title="Pipelines" subtitle="24h health" />
      <div className="rpc-ao-tiles">
        <Tile label="Runs 24h" value={fmtInt(pipelines.runs_24h)} />
        <Tile label="Errors 24h" value={fmtInt(pipelines.errors_24h)} accent={(pipelines.errors_24h ?? 0) > 0 ? "var(--rpc-danger)" : undefined} />
        <Tile label="Success %" value={fmtPct(pipelines.success_pct)} accent={ok} />
        <Tile label="Distinct Active" value={fmtInt(pipelines.distinct_pipelines_active_24h)} />
      </div>
    </section>
  );
}

function InsiderSignalsPanel({ signals }: { signals: InsiderSignalsBlock }) {
  const byType = signals.by_type ?? {};
  const typeRows = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  return (
    <section className="rpc-card" style={sectionStyle}>
      <PanelHeader title="Insider Signals" subtitle="24h" />
      <div className="rpc-ao-tiles">
        <Tile label="Alerts 24h" value={fmtInt(signals.alerts_24h)} />
        <Tile label="Critical 24h" value={fmtInt(signals.critical_24h)} accent={(signals.critical_24h ?? 0) > 0 ? "var(--rpc-red)" : undefined} />
        <Tile label="Distinct Types" value={fmtInt(signals.distinct_types)} />
      </div>
      {typeRows.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="rpc-label" style={{ marginBottom: 6 }}>By Type</div>
          <table style={tableStyle}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                <th style={thStyle}>Type</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Count</th>
              </tr>
            </thead>
            <tbody>
              {typeRows.map(([type, count]) => (
                <tr key={type} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={tdStyle}>{type}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{fmtInt(count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FeatureEngagementPanel({ engagement }: { engagement: Record<string, number> }) {
  const rows = Object.entries(engagement).sort((a, b) => b[1] - a[1]);
  return (
    <section className="rpc-card" style={sectionStyle}>
      <PanelHeader title="Feature Engagement" subtitle="7d events" />
      {rows.length === 0 ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", padding: "16px 0" }}>
          No events tracked yet.
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--rpc-border)" }}>
              <th style={thStyle}>Feature</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Events 7d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([feature, count]) => (
              <tr key={feature} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <td style={tdStyle}>{feature}</td>
                <td style={{ ...tdStyle, textAlign: "right" }}>{fmtInt(count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function EmailTradeHubPanel({ email, tradeHub }: { email: EmailBlock; tradeHub: TradeHubBlock }) {
  return (
    <section className="rpc-card" style={sectionStyle}>
      <PanelHeader title="Email + Trade Hub" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="rpc-ao-twocol">
        <div>
          <div className="rpc-label" style={{ marginBottom: 8 }}>Email Subscribers</div>
          <div className="rpc-ao-tiles">
            <Tile label="Total" value={fmtInt(email.total)} />
            <Tile label="Verified" value={fmtInt(email.verified)} />
            <Tile label="Deal Alerts" value={fmtInt(email.deal_alerts_optin)} />
            <Tile label="Weekly Digest" value={fmtInt(email.weekly_digest_optin)} />
          </div>
        </div>
        <div>
          <div className="rpc-label" style={{ marginBottom: 8 }}>Trade Hub</div>
          <div className="rpc-ao-tiles">
            <Tile label="Wishlist Items" value={fmtInt(tradeHub.wishlist_items)} />
            <Tile label="Users w/ Wishlist" value={fmtInt(tradeHub.users_with_wishlist)} />
            <Tile label="Active Offers" value={fmtInt(tradeHub.active_offers)} />
            <Tile label="Pending Matches" value={fmtInt(tradeHub.pending_matches)} />
          </div>
        </div>
      </div>
    </section>
  );
}

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

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  color: "var(--rpc-text-muted)",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 8px",
  color: "var(--rpc-text-primary)",
  whiteSpace: "nowrap",
};

function PageStyles() {
  return (
    <style>{`
      .rpc-ao-main {
        max-width: 1280px;
        margin: 0 auto;
        padding: 24px 20px 60px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .rpc-ao-tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 10px;
      }
      @media (max-width: 700px) {
        .rpc-ao-twocol { grid-template-columns: 1fr !important; }
        .rpc-ao-main { padding: 16px 12px 40px; gap: 12px; }
      }
    `}</style>
  );
}
