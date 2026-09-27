"use client";

// app/admin/trophy-campaign — Trevor-only trophy-case campaign board (2026-09-27).
//
// Who has STARTED a trophy case, who has FINISHED one (6/6), who has not started
// (the campaign audience), and which campaign link drove each first pin.
// Token-gated via RPC_ADMIN_TOKEN against /api/admin/trophy-campaign, through the
// shared lib/admin/use-admin-resource shell.
//
// ⚠ Two honesty rules the page must keep:
//   · a date marked "≤" is a BACKFILLED CEILING — reconstructed from overwritten
//     pinned_at values, so the true moment is at or before it. Never render it as
//     an observed date.
//   · "—" for campaign on a pre-2026-09-27 pin means UNKNOWN (no event existed
//     then), not "no campaign".

import { useState } from "react";
import { useAdminResource } from "@/lib/admin/use-admin-resource";

type Source = "observed" | "backfill_upper_bound";

interface CampaignUser {
  user_id: string;
  email: string | null;
  is_internal: boolean;
  internal_reason: string | null;
  status: "started" | "completed";
  started_at: string;
  started_at_source: Source;
  completed_at: string | null;
  completed_at_source: Source | null;
  current_slots: number;
  first_pin_event_at: string | null;
  first_pin_utm_source: string | null;
  first_pin_utm_campaign: string | null;
  first_pin_share_ref: string | null;
}

interface NotStarted {
  user_id: string;
  email: string | null;
  is_internal: boolean;
  internal_reason: string | null;
  signed_up_at: string | null;
  last_sign_in_at: string | null;
}

interface DailyRow {
  day_pt: string;
  started_external: number;
  completed_external: number;
  started_internal: number;
  completed_internal: number;
  includes_backfill: boolean;
}

export interface TrophyCampaignPayload {
  generated_at: string;
  totals: {
    accounts: number;
    accounts_external: number;
    started_external: number;
    completed_external: number;
    not_started_external: number;
    started_internal: number;
    completed_internal: number;
  };
  users: CampaignUser[];
  not_started: NotStarted[];
  daily: DailyRow[];
}

const PT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A PT timestamp; a backfilled ceiling is prefixed "≤" so it never reads as observed. */
export function fmtPt(iso: string | null, source?: Source | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const s = `${PT.format(d)} PT`;
  return source === "backfill_upper_bound" ? `≤ ${s}` : s;
}

function campaignLabel(u: CampaignUser): string {
  if (!u.first_pin_event_at) return "— (pinned before tracking)";
  const parts = [u.first_pin_utm_campaign, u.first_pin_utm_source, u.first_pin_share_ref ? `ref ${u.first_pin_share_ref}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "direct / no campaign";
}

const mono = { fontFamily: "var(--font-mono)", fontSize: 12 } as const;
const dim = "rgba(255,255,255,0.5)";

export default function TrophyCampaignClient() {
  const { token, tokenInput, setTokenInput, submitToken, data, loading, error, stale, refresh } =
    useAdminResource<TrophyCampaignPayload>("/api/admin/trophy-campaign");
  const [showInternal, setShowInternal] = useState(false);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);

  if (!token) {
    return (
      <main style={{ minHeight: "100vh", background: "var(--rpc-surface)", color: "#fafafa", padding: 24 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, textTransform: "uppercase", marginBottom: 18 }}>
          Trophy campaign — admin
        </h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitToken();
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <input
            type="password"
            placeholder="RPC_ADMIN_TOKEN"
            aria-label="Admin token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{ flex: 1, minWidth: 0, maxWidth: 360, padding: "8px 10px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, color: "#fff", ...mono }}
          />
          <button type="submit" style={btn(true)}>Authenticate</button>
        </form>
        {error && <div style={{ marginTop: 16, color: "#ef4444", ...mono }}>{error}</div>}
      </main>
    );
  }

  const users = (data?.users ?? []).filter((u) => showInternal || !u.is_internal);
  const completed = users.filter((u) => u.status === "completed");
  const started = users.filter((u) => u.status === "started");
  const notStarted = (data?.not_started ?? []).filter((u) => showInternal || !u.is_internal);

  async function copyAudience() {
    const emails = notStarted.filter((u) => !u.is_internal && u.email).map((u) => u.email).join(", ");
    try {
      await navigator.clipboard.writeText(emails);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--rpc-surface)", color: "#fafafa", padding: "24px 16px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, textTransform: "uppercase", margin: 0 }}>
          Trophy case campaign
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ ...mono, fontSize: 11, color: dim, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
            Show internal accounts
          </label>
          <button onClick={refresh} style={btn(false)}>Refresh</button>
        </div>
      </div>

      {loading && <div style={{ ...mono, color: dim }}>Loading…</div>}
      {error && (
        <div role="alert" style={{ color: "#ef4444", ...mono, marginBottom: 12 }}>
          {error}
          {stale && data && (
            <span style={{ display: "block", marginTop: 4 }}>Showing the last successful read — the figures below are not current.</span>
          )}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 20 }}>
            <Stat label="External accounts" value={data.totals.accounts_external} />
            <Stat label="Started" value={data.totals.started_external} />
            <Stat label="Finished (6/6)" value={data.totals.completed_external} />
            <Stat label="Not started" value={data.totals.not_started_external} />
          </div>
          <p style={{ ...mono, fontSize: 11, color: dim, margin: "0 0 20px" }}>
            External accounts only. Internal (founder / brand / QA): {data.totals.started_internal} started,{" "}
            {data.totals.completed_internal} finished. “≤” marks a date reconstructed from overwritten pin times —
            the real moment is at or before it. Generated {fmtPt(data.generated_at)}.
          </p>

          <Section title={`Finished — ${completed.length}`}>
            <UserTable rows={completed} showCompleted />
          </Section>
          <Section title={`Started, not finished — ${started.length}`}>
            <UserTable rows={started} />
          </Section>
          <Section
            title={`Not started — ${notStarted.length}`}
            action={
              <button onClick={copyAudience} style={btn(false)}>
                {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy external emails"}
              </button>
            }
          >
            <Table
              head={["Account", "Signed up", "Last sign-in"]}
              rows={notStarted.map((u) => [
                <Who key="w" email={u.email} internal={u.internal_reason} />,
                fmtPt(u.signed_up_at),
                fmtPt(u.last_sign_in_at),
              ])}
            />
          </Section>
          <Section title="By day (PT)">
            <Table
              head={["Day", "Started", "Finished", "Internal", "Note"]}
              rows={data.daily.map((d) => [
                d.day_pt,
                String(d.started_external),
                String(d.completed_external),
                `${d.started_internal} / ${d.completed_internal}`,
                d.includes_backfill ? "reconstructed (≤)" : "",
              ])}
            />
          </Section>
        </>
      )}
    </main>
  );
}

function UserTable({ rows, showCompleted }: { rows: CampaignUser[]; showCompleted?: boolean }) {
  const head = ["Account", "Slots", "Started", ...(showCompleted ? ["Finished"] : []), "First-pin campaign"];
  return (
    <Table
      head={head}
      rows={rows.map((u) => [
        <Who key="w" email={u.email} internal={u.internal_reason} />,
        `${u.current_slots}/6`,
        fmtPt(u.started_at, u.started_at_source),
        ...(showCompleted ? [fmtPt(u.completed_at, u.completed_at_source)] : []),
        campaignLabel(u),
      ])}
    />
  );
}

function Who({ email, internal }: { email: string | null; internal: string | null }) {
  return (
    <span>
      {email ?? "(no email)"}
      {internal && <span style={{ marginLeft: 6, color: "var(--rpc-red)", fontSize: 10, textTransform: "uppercase" }}>internal · {internal}</span>}
    </span>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 800, textTransform: "uppercase", margin: 0 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return <div style={{ ...mono, color: dim }}>None.</div>;
  return (
    <div style={{ overflowX: "auto", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", ...mono }}>
        <thead>
          <tr style={{ textAlign: "left", background: "rgba(255,255,255,0.03)" }}>
            {head.map((h) => (
              <th key={h} style={{ padding: "8px 10px", fontSize: 10, color: dim, textTransform: "uppercase", letterSpacing: "0.1em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              {r.map((c, j) => (
                <td key={j} style={{ padding: "8px 10px", verticalAlign: "top" }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ ...mono, fontSize: 10, color: dim, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 900 }}>{value}</div>
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: primary ? "var(--rpc-red)" : "transparent",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 4,
    fontFamily: "var(--font-display)",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    cursor: "pointer",
  };
}
