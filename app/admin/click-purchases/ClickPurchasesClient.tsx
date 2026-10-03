"use client";

// app/admin/click-purchases — RPC → marketplace clicks and the PRESUMED purchases
// that followed them (audit_20260930). Token-gated via RPC_ADMIN_TOKEN against
// /api/admin/click-purchases, through the shared lib/admin/use-admin-resource shell.
//
// ⚠ Honesty rules this page must keep:
//   · "presumed" is the word. Only CONFIRMED means the buyer was the clicker's own
//     wallet; LIKELY and POSSIBLE are a sale that FOLLOWED a click. The page says so.
//   · dollars count each sale ONCE however many clicks preceded it, and only
//     confirmed + likely; a capped purchase list says it was capped.
//   · bot clicks (link-preview fetchers) are shown apart from human ones.
//   · the headline counts are SALES, not clicks, and EXTERNAL only: internal accounts'
//     own buys (every confirmed one so far was the founder's) are stated apart.

import { useState } from "react";
import { useAdminResource } from "@/lib/admin/use-admin-resource";
import type { FunnelRow, PurchaseRow } from "@/app/api/admin/click-purchases/route";

export interface ClickPurchasesPayload {
  generated_at: string;
  days: number;
  since_day_pt: string;
  totals: {
    clicks: number;
    clicks_human: number;
    clicks_internal: number;
    purchases_confirmed: number;
    purchases_likely: number;
    purchases_possible: number;
    sales_confirmed_or_likely: number;
    usd_confirmed_or_likely: number;
    /** Distinct sales clicked only by internal accounts (founder / brand / QA) — not traction. */
    purchases_internal: number;
    usd_internal: number;
  };
  purchases_truncated: boolean;
  funnel: FunnelRow[];
  purchases: PurchaseRow[];
}

const PT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function fmtPt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${PT.format(d)} PT` : "—";
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** One row per source × surface over the window, busiest first. */
export function bySurface(funnel: FunnelRow[]) {
  const m = new Map<string, { source: string; surface: string; clicks_human: number; confirmed: number; likely: number; possible: number }>();
  for (const r of funnel) {
    const k = `${r.source}|${r.surface}`;
    const cur = m.get(k) ?? { source: r.source, surface: r.surface, clicks_human: 0, confirmed: 0, likely: 0, possible: 0 };
    cur.clicks_human += r.clicks_human;
    cur.confirmed += r.purchases_confirmed;
    cur.likely += r.purchases_likely;
    cur.possible += r.purchases_possible;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.clicks_human - a.clicks_human);
}

const mono = { fontFamily: "var(--font-mono)", fontSize: 12 } as const;
const dim = "rgba(255,255,255,0.5)";
const CONF_COLOR: Record<string, string> = { confirmed: "#22c55e", likely: "#eab308", possible: "rgba(255,255,255,0.55)" };

export default function ClickPurchasesClient() {
  const [days, setDays] = useState(30);
  const { token, tokenInput, setTokenInput, submitToken, data, loading, error, stale, refresh } =
    useAdminResource<ClickPurchasesPayload>(`/api/admin/click-purchases?days=${days}`);

  if (!token) {
    return (
      <main style={{ minHeight: "100vh", background: "var(--rpc-surface)", color: "#fafafa", padding: 24 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, textTransform: "uppercase", marginBottom: 18 }}>
          Click → purchase — admin
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

  return (
    <main style={{ minHeight: "100vh", background: "var(--rpc-surface)", color: "#fafafa", padding: "24px 16px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, textTransform: "uppercase", margin: 0 }}>
          Click → purchase
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} style={btn(d === days)} aria-pressed={d === days}>
              {d}d
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
            <Stat label="Human clicks" value={String(data.totals.clicks_human)} />
            <Stat label="Confirmed" value={String(data.totals.purchases_confirmed)} />
            <Stat label="Likely" value={String(data.totals.purchases_likely)} />
            <Stat label="Possible" value={String(data.totals.purchases_possible)} />
            <Stat label="Sales $ (conf + likely)" value={fmtUsd(data.totals.usd_confirmed_or_likely)} />
          </div>
          <p style={{ ...mono, fontSize: 11, color: dim, margin: "0 0 20px", lineHeight: 1.6 }}>
            Last {data.days} days (since {data.since_day_pt} PT). Presumed purchases: <b>confirmed</b> = the buyer was the
            clicker&apos;s own wallet; <b>likely</b> = that exact moment sold within 2 h at about the clicked ask;{" "}
            <b>possible</b> = a sale followed the click, nothing more. Dollars count each sale once, confirmed + likely only.
            {" "}All clicks {data.totals.clicks} · bots {data.totals.clicks - data.totals.clicks_human} · internal{" "}
            {data.totals.clicks_internal}. Headline counts are distinct sales by non-internal clickers; internal
            accounts&apos; own buys: {data.totals.purchases_internal} ({fmtUsd(data.totals.usd_internal)}). The
            by-surface table counts clicks. Matching runs hourly. Generated {fmtPt(data.generated_at)}.
            {data.purchases_truncated && (
              <span style={{ display: "block", color: "#eab308" }}>
                The purchase list hit its row cap — the dollar total and the list below are a lower bound.
              </span>
            )}
          </p>

          <Section title="By source and surface">
            <Table
              head={["Source", "Surface", "Human clicks", "Confirmed", "Likely", "Possible"]}
              rows={bySurface(data.funnel).map((r) => [r.source, r.surface, r.clicks_human, r.confirmed, r.likely, r.possible])}
              empty="No clicks in this window."
            />
          </Section>

          <Section title={`Presumed purchases — ${data.purchases.length}`}>
            <Table
              head={["Clicked", "Item", "From", "Confidence", "Sold after", "Ask → sold"]}
              rows={data.purchases.map((p) => [
                fmtPt(p.clicked_at),
                [p.player_name, p.set_name].filter(Boolean).join(" · ") || p.nft_id || "—",
                [p.source, p.surface, p.channel, p.internal ? "internal" : null].filter(Boolean).join(" · "),
                <span key="c" style={{ color: CONF_COLOR[p.confidence] }}>
                  {p.confidence}
                  {p.match === "same_edition" ? " (edition)" : ""}
                </span>,
                `${p.minutes_after_click} min`,
                `${fmtUsd(p.ask_price_usd)} → ${fmtUsd(p.price_usd)}`,
              ])}
              empty="No click has been followed by a matching sale in this window."
            />
          </Section>
        </>
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 800, textTransform: "uppercase", margin: "0 0 8px" }}>{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <div style={{ ...mono, color: dim }}>{empty}</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", ...mono }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: dim, fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.1)", whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={{ padding: "6px 8px", borderBottom: "1px solid rgba(255,255,255,0.05)", whiteSpace: "nowrap" }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
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
