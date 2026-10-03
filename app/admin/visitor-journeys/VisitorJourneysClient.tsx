"use client";

// app/admin/visitor-journeys — one timeline per human visit (2026-10-03).
//
// Reads /api/admin/visitor-journeys (public.admin_visitor_journeys). Each row
// is one rpc_sess visit: where it landed from (AI assistant, utm, referrer),
// what it viewed, whether it pasted a wallet, chatted with the concierge,
// left an email or clicked out — and whether the browser has been here before.
//
// Honesty rules this page keeps:
//   - Bot / smoke / internal sessions are excluded from the list, and the
//     header SAYS how many were excluded, so a small list never reads as "the
//     site is quiet" when it is "the site is mostly bots".
//   - "Returning" can only be known for visits that carry a visitor id (rpc_vid
//     shipped 2026-10-03; absent under GPC/DNT). The count is shown beside the
//     number of visits that COULD be classified, never as a share of all.
//   - Every time is PT.

import { useState } from "react";
import { useAdminResource } from "@/lib/admin/use-admin-resource";

export interface JourneyEvent {
  at: string;
  src: "funnel" | "usage" | "click" | "concierge";
  kind: string;
  detail: string | null;
}

export interface JourneySession {
  sid: string;
  visitor_id: string | null;
  returning: boolean;
  first_at: string;
  last_at: string;
  n_events: number;
  landing_ref: string | null;
  ai_source: string | null;
  landing_path: string | null;
  wallet: string | null;
  signed_in: boolean;
  chatted: boolean;
  pasted: boolean;
  captured: boolean;
  clicked_out: boolean;
  events: JourneyEvent[] | null;
}

export interface VisitorJourneysPayload {
  generated_at: string;
  window_hours: number;
  totals: {
    sessions_seen: number;
    sessions_human: number;
    sessions_excluded_bot: number;
    sessions_excluded_internal: number;
    sessions_shown: number;
    with_concierge: number;
    with_wallet_paste: number;
    with_email_capture: number;
    signed_in: number;
    returning: number;
    with_visitor_id: number;
    from_ai: number;
  };
  ai_referrals_window: Array<{ source: string; sessions: number }>;
  ai_referrals_30d: Array<{ source: string; sessions: number }>;
  sessions: JourneySession[];
}

const PT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const PT_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function fmtPt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${PT.format(d)} PT` : "—";
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? PT_TIME.format(d) : "—";
}

/** Where a visit came from, in one short label. */
export function sourceLabel(s: Pick<JourneySession, "ai_source" | "landing_ref">): string {
  if (s.ai_source) return `AI · ${s.ai_source}`;
  const ref = s.landing_ref ?? "";
  if (!ref) return "direct / unknown";
  const utm = /(?:^|&)utm_source=([^&]+)/.exec(ref)?.[1];
  if (utm) return `utm · ${utm}`;
  const share = /(?:^|&)share_ref=([^&]+)/.exec(ref)?.[1];
  if (share) return `share · ${share}`;
  const host = /(?:^|&)ref=https?:\/\/([^/&]+)/.exec(ref)?.[1];
  return host ? `ref · ${host}` : ref.slice(0, 40);
}

const mono = { fontFamily: "var(--font-mono)", fontSize: 12 } as const;
const dim = "rgba(255,255,255,0.5)";
const WINDOWS = [6, 24, 72, 168] as const;

export default function VisitorJourneysClient() {
  const [hours, setHours] = useState<number>(24);
  const { token, tokenInput, setTokenInput, submitToken, data, loading, error, stale, refresh } =
    useAdminResource<VisitorJourneysPayload>(`/api/admin/visitor-journeys?hours=${hours}`);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "engaged" | "ai">("all");

  if (!token) {
    return (
      <main style={{ minHeight: "100vh", background: "var(--rpc-surface)", color: "#fafafa", padding: 24 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, textTransform: "uppercase", marginBottom: 18 }}>
          Visitor journeys — admin
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

  const sessions = (data?.sessions ?? []).filter((s) =>
    filter === "ai" ? !!s.ai_source : filter === "engaged" ? s.chatted || s.pasted || s.captured || s.clicked_out || s.signed_in : true
  );

  return (
    <main style={{ minHeight: "100vh", background: "var(--rpc-surface)", color: "#fafafa", padding: "24px 16px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, textTransform: "uppercase", margin: 0 }}>
          Visitor journeys
        </h1>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {WINDOWS.map((h) => (
            <button key={h} onClick={() => setHours(h)} style={btn(h === hours)} aria-pressed={h === hours}>
              {h < 48 ? `${h}h` : `${h / 24}d`}
            </button>
          ))}
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 12 }}>
            <Stat label="Human visits" value={data.totals.sessions_human} />
            <Stat label="From AI assistants" value={data.totals.from_ai} />
            <Stat label="Wallet pasted" value={data.totals.with_wallet_paste} />
            <Stat label="Concierge chat" value={data.totals.with_concierge} />
            <Stat label="Email left" value={data.totals.with_email_capture} />
            <Stat label="Signed in" value={data.totals.signed_in} />
          </div>
          <p style={{ ...mono, fontSize: 11, color: dim, margin: "0 0 16px", lineHeight: 1.6 }}>
            Last {data.window_hours}h. Excluded from the list: {data.totals.sessions_excluded_bot} bot / automated /
            smoke-test visits and {data.totals.sessions_excluded_internal} internal-account visits (of{" "}
            {data.totals.sessions_seen} seen). Returning: {data.totals.returning} of the{" "}
            {data.totals.with_visitor_id} visits carrying a visitor id (ids began 2026-10-03; none under GPC/DNT).
            Generated {fmtPt(data.generated_at)}.
          </p>

          <Section title="AI-assistant referrals">
            <p style={{ ...mono, color: dim, margin: "0 0 8px" }}>
              This window:{" "}
              {data.ai_referrals_window.length
                ? data.ai_referrals_window.map((r) => `${r.source} ${r.sessions}`).join(" · ")
                : "none"}
              {"  ·  "}30 days (human funnel visits):{" "}
              {data.ai_referrals_30d.length
                ? data.ai_referrals_30d.map((r) => `${r.source} ${r.sessions}`).join(" · ")
                : "none"}
            </p>
          </Section>

          <Section
            title={`Visits — ${sessions.length}${data.totals.sessions_shown < data.totals.sessions_human ? ` (newest ${data.totals.sessions_shown} of ${data.totals.sessions_human})` : ""}`}
            action={
              <div style={{ display: "flex", gap: 6 }}>
                {(["all", "engaged", "ai"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)} style={btn(f === filter)} aria-pressed={f === filter}>
                    {f}
                  </button>
                ))}
              </div>
            }
          >
            {sessions.length === 0 ? (
              <div style={{ ...mono, color: dim }}>No human visits match this filter in the window.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {sessions.map((s) => (
                  <div key={s.sid} style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "8px 10px" }}>
                    <button
                      onClick={() => setOpen(open === s.sid ? null : s.sid)}
                      aria-expanded={open === s.sid}
                      style={{ all: "unset", cursor: "pointer", display: "flex", flexWrap: "wrap", gap: "4px 12px", width: "100%", ...mono }}
                    >
                      <span>{fmtPt(s.first_at)}</span>
                      <span style={{ color: s.ai_source ? "#22c55e" : dim }}>{sourceLabel(s)}</span>
                      <span style={{ color: dim, overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{s.landing_path ?? "—"}</span>
                      <span>{s.n_events} events</span>
                      {s.returning && <Tag>returning</Tag>}
                      {s.signed_in && <Tag>signed in</Tag>}
                      {s.pasted && <Tag>paste{s.wallet ? ` ${s.wallet}` : ""}</Tag>}
                      {s.chatted && <Tag>concierge</Tag>}
                      {s.captured && <Tag>email</Tag>}
                      {s.clicked_out && <Tag>clicked out</Tag>}
                    </button>
                    {open === s.sid && (
                      <ol style={{ margin: "8px 0 0", paddingLeft: 18, ...mono, fontSize: 11 }}>
                        {(s.events ?? []).map((e, i) => (
                          <li key={i} style={{ marginBottom: 2 }}>
                            <span style={{ color: dim }}>{fmtTime(e.at)}</span> {e.src}:{e.kind}
                            {e.detail ? <span style={{ color: dim }}> — {e.detail}</span> : null}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </main>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ padding: "0 6px", borderRadius: 999, background: "rgba(224,58,47,0.15)", color: "#fafafa", fontSize: 11 }}>
      {children}
    </span>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, textTransform: "uppercase", margin: 0 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ ...mono, fontSize: 10, color: dim, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 22 }}>{value}</div>
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    background: primary ? "var(--rpc-red)" : "transparent",
    border: `1px solid ${primary ? "var(--rpc-red)" : "rgba(255,255,255,0.2)"}`,
    borderRadius: 4,
    color: "#fff",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  };
}
