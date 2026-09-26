"use client";

// PaniniBoardsTabs — the four Panini WC Prizm boards that were built but never
// surfaced (deals, pack EV, special serials, players), as tabs under the squeeze
// board. Server-seeded from the hourly `panini-boards` snapshot
// (lib/insights/panini-more-boards.ts); nothing here fetches.
//
// Honesty rules this component keeps:
//   · The coverage disclosure sits above EVERY tab: Panini publishes no
//     checklist, so these are boards over what has been LISTED, not a census.
//   · Each tab has three states — failed ("couldn't load"), empty, rows.
//   · Deals lead with the ones a recent SALE corroborates; FMV-only deals follow,
//     labelled (243 of 263 on 2026-09-25 had no recent sale behind them).
//   · Player totals include ask-derived FMV on cards that never traded, so the
//     tab sorts by edition count and says so, rather than ranking by a sum an
//     ask can inflate.

import { useMemo, useState } from "react";
import DegradedDataNotice from "@/components/insights/DegradedDataNotice";
import type { DegradedSummary } from "@/lib/insights/board-status";

type Num = number | null;

export interface DealRow {
  sku: string;
  player_name: string | null;
  parallel: string | null;
  tier: string | null;
  serial_number: Num;
  mint_cap: Num;
  ask_usd: Num;
  best_offer_usd: Num;
  last_sale_usd: Num;
  fmv_usd: Num;
  discount_pct: Num;
  est_profit_usd: Num;
  special_flag: string | null;
  ask_confirmed_at: string | null;
  recent_sales_median_usd: Num;
  recent_sales_n: Num;
  deal_basis: string | null;
}
export interface PackRow {
  pack_type: string;
  pack_cost_usd: Num;
  floor_usd: Num;
  avg_sale_usd: Num;
  recent_sale_usd: Num;
  cards_per_pack: Num;
  packs_total: Num;
  packs_remaining: Num;
  packs_ripped_pct: Num;
  actual_ev_usd: Num;
  typical_ev_usd: Num;
  net_rip_edge_usd: Num;
  model_note: string | null;
  updated_at: string | null;
}
export interface SpecialRow {
  sku: string;
  player_name: string | null;
  parallel: string | null;
  serial_number: Num;
  mint_cap: Num;
  headline_flag: string | null;
  all_flags: string | null;
  serial_ask_usd: Num;
  serial_fmv_usd: Num;
  edition_fmv_usd: Num;
  last_sale_usd: Num;
  last_sale_at: string | null;
  ask_confirmed_at: string | null;
}
export interface PlayerRow {
  player_name: string | null;
  editions: Num;
  chases: Num;
  rookie_editions: Num;
  sealed_in_packs: Num;
  top_fmv_usd: Num;
  catalog_fmv_usd: Num;
  sealed_fmv_exposure_usd: Num;
  avg_rip_pct: Num;
}
export interface PaniniBoardsPayload {
  deals?: DealRow[] | null;
  deals_error?: boolean;
  deals_capped?: boolean;
  packs?: PackRow[] | null;
  packs_error?: boolean;
  specials?: SpecialRow[] | null;
  specials_error?: boolean;
  specials_total?: Num;
  specials_listed?: Num;
  players?: PlayerRow[] | null;
  players_error?: boolean;
  players_capped?: boolean;
  coverage?: { total_editions?: Num; pct_trustworthy?: Num } | null;
}

type Tab = "deals" | "packs" | "specials" | "players";
const TABS: { k: Tab; label: string }[] = [
  { k: "deals", label: "Deals" },
  { k: "packs", label: "Pack EV" },
  { k: "specials", label: "Special serials" },
  { k: "players", label: "Players" },
];

const mono = "var(--font-mono)";
const display = "var(--font-display)";

function usd(n: Num | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2, minimumFractionDigits: v >= 100 ? 0 : 2 });
}
function int(n: Num | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US");
}
/** Absolute PT date — the reader's clock never enters render. */
function ptDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}
function serial(n: Num, cap: Num): string {
  if (n === null) return "—";
  return cap === null ? `#${n}` : `#${n}/${cap}`;
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 8px", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle)", whiteSpace: "nowrap" };

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)", margin: "8px 0" }}>{children}</div>;
}
function Failed({ what }: { what: string }) {
  return <Note>{what} couldn&apos;t load right now — this is a failed read, not an empty board.</Note>;
}
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
        <thead>
          <tr>{head.map((h) => <th key={h} style={th}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default function PaniniBoardsTabs({
  data,
  degraded,
}: {
  data: PaniniBoardsPayload | null;
  degraded: DegradedSummary | null;
}) {
  const [tab, setTab] = useState<Tab>("deals");

  // Sale-corroborated deals first; within each group, biggest estimated edge first.
  const deals = useMemo(() => {
    const rows = data?.deals ?? null;
    if (!rows) return null;
    const backed = rows.filter((r) => r.deal_basis === "fmv_and_recent_sales");
    const fmvOnly = rows.filter((r) => r.deal_basis !== "fmv_and_recent_sales");
    return { backed, fmvOnly };
  }, [data?.deals]);

  const players = useMemo(() => {
    const rows = data?.players ?? null;
    if (!rows) return null;
    return [...rows].sort((a, b) => (Number(b.editions ?? 0) - Number(a.editions ?? 0)) || (a.player_name ?? "").localeCompare(b.player_name ?? ""));
  }, [data?.players]);

  const cov = data?.coverage ?? null;

  return (
    <section style={{ marginTop: 32 }} aria-label="More Panini boards">
      <h2 style={{ fontFamily: display, fontWeight: 900, fontSize: 20, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 8px" }}>
        More Panini boards
      </h2>
      <div role="note" style={{ padding: "10px 14px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 6, marginBottom: 12 }}>
        <Note>
          <b>A floor, not a census.</b> Panini publishes no checklist, so RPC only knows a card once it has been listed for sale.
          {cov && cov.pct_trustworthy != null
            ? ` Of the ${int(cov.total_editions)} editions indexed, ${cov.pct_trustworthy}% sit in sets with broad listing coverage; the rest are known mostly through their listings.`
            : ""}{" "}
          Everything below is a board over what has been seen, refreshed about hourly.
        </Note>
      </div>
      <DegradedDataNotice summary={degraded} />

      <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0 12px" }}>
        {TABS.map((t) => (
          <button
            key={t.k}
            role="tab"
            aria-selected={tab === t.k}
            onClick={() => setTab(t.k)}
            style={{
              fontFamily: mono, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 12px", borderRadius: 6, cursor: "pointer",
              background: tab === t.k ? "var(--rpc-red-bg)" : "transparent",
              border: `1px solid ${tab === t.k ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
              color: tab === t.k ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!data ? (
        <Failed what="These boards" />
      ) : tab === "deals" ? (
        data.deals_error || !deals ? (
          <Failed what="Deals" />
        ) : deals.backed.length + deals.fmvOnly.length === 0 ? (
          <Note>No listed card is priced at least 15% under its FMV right now.</Note>
        ) : (
          <>
            <Note>
              Listed serials asking at least 15% under FMV (adjusted for #1 / jersey / perfect-mint premiums), with the ask re-read in the last 7 days.
              Cards whose own edition FMV is ask-derived are excluded. <b>{int(deals.backed.length)}</b> are also under the median of recent sales;{" "}
              <b>{int(deals.fmvOnly.length)}</b> have no recent sale to check against and are listed after them.
            </Note>
            <Table head={["Player", "Parallel", "Serial", "Ask", "FMV", "Under FMV", "Recent sales", "Ask seen"]}>
              {[...deals.backed, ...deals.fmvOnly].map((r) => (
                <tr key={r.sku}>
                  <td style={td}>{r.player_name ?? "—"}{r.special_flag ? ` · ${r.special_flag}` : ""}</td>
                  <td style={td}>{r.parallel ?? "—"}</td>
                  <td style={td}>{serial(r.serial_number, r.mint_cap)}</td>
                  <td style={td}>{usd(r.ask_usd)}</td>
                  <td style={td}>{usd(r.fmv_usd)}</td>
                  <td style={td}>{r.discount_pct === null ? "—" : `${r.discount_pct}%`}</td>
                  <td style={td}>
                    {r.deal_basis === "fmv_and_recent_sales"
                      ? `median ${usd(r.recent_sales_median_usd)} (${int(r.recent_sales_n)})`
                      : "none in 30 days"}
                  </td>
                  <td style={td}>{ptDate(r.ask_confirmed_at)}</td>
                </tr>
              ))}
            </Table>
            {data.deals_capped ? <Note>Showing the top {int(data.deals?.length ?? 0)} by estimated edge; more exist.</Note> : null}
          </>
        )
      ) : tab === "packs" ? (
        data.packs_error || !data.packs ? (
          <Failed what="Pack EV" />
        ) : data.packs.length === 0 ? (
          <Note>No Panini pack products are tracked.</Note>
        ) : (
          <>
            <Table head={["Pack", "Price", "Typical pull", "Actual EV (mean)", "Recent sale", "Remaining", "Ripped"]}>
              {data.packs.map((p) => (
                <tr key={p.pack_type}>
                  <td style={td}>{p.pack_type === "fotl" ? "FOTL" : p.pack_type === "hobby" ? "Hobby" : p.pack_type} · {int(p.cards_per_pack)} cards</td>
                  <td style={td}>{usd(p.pack_cost_usd)}</td>
                  <td style={td}>{usd(p.typical_ev_usd)}</td>
                  <td style={td}>{usd(p.actual_ev_usd)}</td>
                  <td style={td}>{usd(p.recent_sale_usd)}</td>
                  <td style={td}>{int(p.packs_remaining)} of {int(p.packs_total)}</td>
                  <td style={td}>{p.packs_ripped_pct === null ? "—" : `${p.packs_ripped_pct}%`}</td>
                </tr>
              ))}
            </Table>
            <Note>
              Read the typical pull first: it is what the median pack holds. The mean is dragged up by chase cards most packs never contain, and it is
              priced off FMV on a listing-fed index, so it is indicative pull value, not what the cards would sell for. Updated {ptDate(data.packs[0]?.updated_at ?? null)}.
            </Note>
          </>
        )
      ) : tab === "specials" ? (
        data.specials_error || !data.specials ? (
          <Failed what="Special serials" />
        ) : data.specials.length === 0 ? (
          <Note>No #1, jersey-number or perfect-mint serial is listed with a recently confirmed ask.</Note>
        ) : (
          <>
            <Note>
              #1s, jersey-number serials and perfect mints listed for sale with an ask re-read in the last 7 days
              {data.specials_listed != null && data.specials_total != null
                ? ` — ${int(data.specials_listed)} of the ${int(data.specials_total)} such serials RPC has seen`
                : ""}
              . &ldquo;Model value&rdquo; is the edition&apos;s FMV times a premium fitted to past sales of flagged serials; for an edition that has never
              traded, that FMV rests on asks.
            </Note>
            <Table head={["Player", "Parallel", "Serial", "Flag", "Ask", "Model value", "Last sale"]}>
              {data.specials.map((r) => (
                <tr key={r.sku}>
                  <td style={td}>{r.player_name ?? "—"}</td>
                  <td style={td}>{r.parallel ?? "—"}</td>
                  <td style={td}>{serial(r.serial_number, r.mint_cap)}</td>
                  <td style={td}>{r.all_flags ?? r.headline_flag ?? "—"}</td>
                  <td style={td}>{usd(r.serial_ask_usd)}</td>
                  <td style={td}>{usd(r.serial_fmv_usd)}</td>
                  <td style={td}>{r.last_sale_usd === null ? "—" : `${usd(r.last_sale_usd)} · ${ptDate(r.last_sale_at)}`}</td>
                </tr>
              ))}
            </Table>
          </>
        )
      ) : data.players_error || !players ? (
        <Failed what="Players" />
      ) : players.length === 0 ? (
        <Note>No players are indexed.</Note>
      ) : (
        <>
          <Note>
            Players by how many of their editions RPC has indexed. The value columns sum edition FMV, and for cards that have never traded that FMV
            comes from asks — so a single high ask can dominate a player&apos;s total. Treat them as a guide to where the value sits, not a price.
          </Note>
          <Table head={["Player", "Editions", "Chases (≤/25)", "Rookie editions", "Still in packs", "Top edition FMV", "Avg ripped"]}>
            {players.map((p) => (
              <tr key={p.player_name ?? ""}>
                <td style={td}>{p.player_name ?? "—"}</td>
                <td style={td}>{int(p.editions)}</td>
                <td style={td}>{int(p.chases)}</td>
                <td style={td}>{int(p.rookie_editions)}</td>
                <td style={td}>{int(p.sealed_in_packs)}</td>
                <td style={td}>{usd(p.top_fmv_usd)}</td>
                <td style={td}>{p.avg_rip_pct === null ? "—" : `${p.avg_rip_pct}%`}</td>
              </tr>
            ))}
          </Table>
          {data.players_capped ? <Note>Showing the {int(players.length)} players with the most indexed editions; more are indexed.</Note> : null}
        </>
      )}
    </section>
  );
}
