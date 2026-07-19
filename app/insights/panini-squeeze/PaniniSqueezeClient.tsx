"use client";
import { useMemo, useState } from "react";
import { FreshnessStamp } from "@/components/insights/FreshnessStamp";

type Row = {
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  mint_cap: number | null;
  pulled_count: number | null;
  still_in_packs: number | null;
  rip_pct: number | null;
  fmv_usd: number | null;
  sealed_fmv_exposure_usd: number | null;
  serial_low_ask_usd: number | null;
  is_rookie: boolean | null;
  is_debut: boolean | null;
  real_sales: number | null;
};

export type Totals = {
  editions: number | null;
  sealed_fmv_exposure_usd: number | null;
  chases_lte_25: number | null;
  sealed_copies: number | null;
};

export type Coverage = {
  total_editions: number | null;
  trustworthy_editions: number | null;
  pct_trustworthy: number | null;
  listing_gated_editions: number | null;
  listing_gated_families: number | null;
  families: number | null;
  // Added after a self-audit: pct_trustworthy is a COMPOSITION share, not a coverage
  // percentage, and reads as the latter. The honest headline is the RANGE, plus the fact
  // that our own checklist count is a lower bound (it grew 474 -> 487 mid-discovery), so
  // every percent-of-checklist figure is best-case.
  best_family_checklist_pct: number | null;
  worst_family_checklist_pct: number | null;
  checklist_players_seen: number | null;
  checklist_players_new_24h: number | null;
};

const usd = (x: number | null | undefined) =>
  x == null || isNaN(Number(x)) || Number(x) <= 0
    ? "—"
    : "$" + Number(x).toLocaleString(undefined, { maximumFractionDigits: Math.abs(Number(x)) < 100 ? 2 : 0 });
const num = (x: number | null | undefined, d = 0) =>
  x == null || isNaN(Number(x)) ? "—" : Number(x).toLocaleString(undefined, { maximumFractionDigits: d });

const CSS = `
.psq-wrap{max-width:1180px;margin:0 auto;padding:20px 16px 60px;color:var(--rpc-text-primary,#ECEAE3)}
.psq-h1{font-family:var(--font-display,'Barlow Condensed'),sans-serif;font-size:30px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;margin:0;border-bottom:3px solid var(--rpc-red,#E03A2F);padding-bottom:8px;display:inline-block}
.psq-sub{color:var(--rpc-text-secondary,#9A968C);font-size:12.5px;margin:10px 0 18px}
.psq-cov{background:var(--rpc-surface,#16161a);border:1px solid var(--rpc-border,rgba(255,255,255,.10));border-left:3px solid var(--rpc-red,#E03A2F);border-radius:8px;padding:10px 13px;margin:0 0 16px;font-size:12px;line-height:1.55;color:var(--rpc-text-secondary,#9A968C)}
.psq-cov b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
.psq-note{color:var(--rpc-text-secondary,#9A968C);font-size:11.5px;margin:10px 2px 0}
.psq-note b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
.psq-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:18px}
@media(min-width:760px){.psq-kpis{grid-template-columns:repeat(4,1fr)}}
.psq-card{background:var(--rpc-surface,#16161a);border:1px solid var(--rpc-border,rgba(255,255,255,.10));border-radius:10px;padding:13px 14px}
.psq-card h3{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--rpc-text-secondary,#9A968C);margin:0 0 7px;font-weight:700}
.psq-big{font-family:var(--font-mono,ui-monospace),monospace;font-size:22px;font-weight:600;color:var(--rpc-red,#E03A2F)}
.psq-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 12px}
.psq-controls input{background:var(--rpc-surface,#1b1b20);border:1px solid var(--rpc-border,rgba(255,255,255,.12));border-radius:8px;color:var(--rpc-text-primary,#ECEAE3);padding:7px 11px;font-size:12.5px;min-width:200px}
.psq-seg{display:flex;border:1px solid var(--rpc-border,rgba(255,255,255,.12));border-radius:8px;overflow:hidden}
.psq-seg button{background:transparent;border:0;color:var(--rpc-text-secondary,#9A968C);padding:7px 11px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;font-weight:700}
.psq-seg button.on{background:var(--rpc-red,#E03A2F);color:#fff}
.psq-scroll{overflow-x:auto}
.psq-tbl{width:100%;border-collapse:collapse;border:1px solid var(--rpc-border,rgba(255,255,255,.10));border-radius:10px;overflow:hidden}
.psq-tbl th,.psq-tbl td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
.psq-tbl th{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--rpc-text-secondary,#9A968C);font-weight:700;cursor:pointer}
.psq-tbl th.n,.psq-tbl td.n{text-align:right;font-family:var(--font-mono,ui-monospace),monospace}
.psq-tbl tbody tr:hover td{background:rgba(255,255,255,.03)}
.psq-nm{font-weight:600;color:var(--rpc-text-primary,#F2F0EA)}
.psq-par{color:var(--rpc-text-secondary,#9A968C);font-size:11px}
.psq-rc{font-size:9px;font-weight:800;padding:1px 4px;border-radius:3px;color:#0c0c0e;background:#5fd6a0;margin-left:5px}
.psq-seal{color:#5fd6a0;font-weight:700}
.psq-exp{color:#e0a64b;font-weight:700}
.psq-tier{font-size:9.5px;font-weight:800;padding:2px 6px;border-radius:4px;text-transform:uppercase}
`;

const CAPS = [
  { k: 0, label: "All" },
  { k: 25, label: "≤ /25" },
  { k: 10, label: "≤ /10" },
  { k: 1, label: "1-of-1s" },
];

export default function PaniniSqueezeClient({
  initialRows,
  fetchedAt,
  coverage = null,
  totals = null,
}: {
  initialRows: Row[];
  fetchedAt: string;
  coverage?: Coverage | null;
  totals?: Totals | null;
}) {
  const [sortK, setSortK] = useState<keyof Row>("fmv_usd");
  const [asc, setAsc] = useState(false);
  const [cap, setCap] = useState(0);
  const [rookie, setRookie] = useState(false);
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    let r = initialRows.filter((x) => {
      if (cap === 1 ? Number(x.mint_cap) !== 1 : cap > 0 && Number(x.mint_cap) > cap) return false;
      if (rookie && !x.is_rookie) return false;
      if (q && !((x.player_name || "") + " " + (x.set_name || "")).toLowerCase().includes(q)) return false;
      return true;
    });
    r = [...r].sort((a, b) => {
      let x: any = a[sortK], y: any = b[sortK];
      if (sortK === "player_name" || sortK === "set_name" || sortK === "tier") {
        x = (x || "").toLowerCase(); y = (y || "").toLowerCase();
        return asc ? (x < y ? -1 : x > y ? 1 : 0) : x < y ? 1 : x > y ? -1 : 0;
      }
      x = x == null ? (asc ? Infinity : -Infinity) : Number(x);
      y = y == null ? (asc ? Infinity : -Infinity) : Number(y);
      return asc ? x - y : y - x;
    });
    return r;
  }, [initialRows, sortK, asc, cap, rookie, q]);

  // Slice-derived fallbacks — used only if the whole-board totals query fails (fail-soft).
  const sealedTotal = useMemo(() => initialRows.reduce((s, r) => s + (Number(r.sealed_fmv_exposure_usd) || 0), 0), [initialRows]);
  const chases = useMemo(() => initialRows.filter((r) => Number(r.mint_cap) <= 25).length, [initialRows]);
  const sealedCopies = useMemo(() => initialRows.reduce((s, r) => s + (Number(r.still_in_packs) || 0), 0), [initialRows]);

  const th = (k: keyof Row, label: string, n = false) => (
    <th className={n ? "n" : ""} onClick={() => (k === sortK ? setAsc(!asc) : (setSortK(k), setAsc(false)))}>
      {label}{k === sortK ? (asc ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <div className="psq-wrap">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <h1 className="psq-h1">Panini · WC Prizm Squeeze</h1>
      <div className="psq-sub">
        2026 Prizm World Cup Soccer — which cards are still sealed in packs. <FreshnessStamp iso={fetchedAt} />
      </div>

      {coverage && Number(coverage.total_editions) > 0 ? (
        <div className="psq-cov">
          <b>Coverage:</b> RPC indexes <b>{num(coverage.total_editions)}</b> editions of this set. Panini
          publishes no full checklist, so a card is indexed only once it has been <b>listed for sale</b>.
          {coverage.best_family_checklist_pct != null && coverage.worst_family_checklist_pct != null ? (
            <>
              {" "}Coverage per parallel runs from about{" "}
              <b>{num(coverage.best_family_checklist_pct, 0)}%</b> down to{" "}
              <b>{num(coverage.worst_family_checklist_pct, 0)}%</b> — thinnest exactly where cards are scarcest
            </>
          ) : (
            <> Coverage is thinnest exactly where cards are scarcest</>
          )}
          {Number(coverage.listing_gated_editions) > 0 ? (
            <>
              {" "}(<b>{num(coverage.listing_gated_editions)}</b> editions across{" "}
              <b>{num(coverage.listing_gated_families)}</b> of {num(coverage.families)} parallels are visible to us
              only while listed)
            </>
          ) : null}
          .
          {Number(coverage.checklist_players_new_24h) > 0 ? (
            <>
              {" "}We are also still finding players we had not seen (
              <b>{num(coverage.checklist_players_new_24h)}</b> new in the last 24h), so our own checklist count is a
              lower bound and these figures are best-case.
            </>
          ) : null}{" "}
          Treat this board as a <b>floor, not a census</b>.
        </div>
      ) : null}

      <div className="psq-kpis">
        <div className="psq-card"><h3>Editions</h3><div className="psq-big">{num(totals?.editions ?? initialRows.length)}</div></div>
        <div className="psq-card"><h3>Value sealed in packs</h3><div className="psq-big">{usd(totals?.sealed_fmv_exposure_usd ?? sealedTotal)}</div></div>
        <div className="psq-card"><h3>Chases ≤ /25</h3><div className="psq-big">{num(totals?.chases_lte_25 ?? chases)}</div></div>
        <div className="psq-card"><h3>Sealed copies</h3><div className="psq-big">{num(totals?.sealed_copies ?? sealedCopies)}</div></div>
      </div>

      <div className="psq-controls">
        <input placeholder="Filter player or parallel…" value={q} onChange={(e) => setQ(e.target.value.trim().toLowerCase())} />
        <div className="psq-seg">
          {CAPS.map((c) => (
            <button key={c.k} className={cap === c.k ? "on" : ""} onClick={() => setCap(c.k)}>{c.label}</button>
          ))}
        </div>
        <div className="psq-seg"><button className={rookie ? "on" : ""} onClick={() => setRookie(!rookie)}>Rookies</button></div>
      </div>

      <div className="psq-scroll">
        <table className="psq-tbl">
          <thead><tr>
            {th("player_name", "Player")}
            {th("set_name", "Parallel")}
            {th("tier", "Tier")}
            {th("mint_cap", "Mint", true)}
            {th("still_in_packs", "In packs", true)}
            {th("rip_pct", "Rip %", true)}
            {th("sealed_fmv_exposure_usd", "Sealed $", true)}
            {th("serial_low_ask_usd", "Ask", true)}
            {th("fmv_usd", "FMV", true)}
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="psq-par">No editions match.</td></tr>
            ) : rows.map((r) => (
              <tr key={(r.player_name || "") + (r.set_name || "") + r.mint_cap}>
                <td><span className="psq-nm">{r.player_name || "—"}</span>{r.is_rookie ? <span className="psq-rc">RC</span> : null}</td>
                <td className="psq-par">{r.set_name || "—"}</td>
                <td><span className="psq-tier">{(r.tier || "—").toUpperCase()}</span></td>
                <td className="n">/{num(r.mint_cap)}</td>
                <td className={"n" + (Number(r.still_in_packs) > 0 ? " psq-seal" : "")}>{num(r.still_in_packs)}</td>
                <td className="n">{num(r.rip_pct, 1)}%</td>
                <td className="n psq-exp">{usd(r.sealed_fmv_exposure_usd)}</td>
                <td className="n">{usd(r.serial_low_ask_usd)}</td>
                <td className="n"><b>{usd(r.fmv_usd)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* KPIs above are whole-board totals; this table is the top slice. Without saying so,
          a reader sees "Editions 1,833" over 300 rows and reasonably assumes the table is
          the whole set. */}
      {totals?.editions != null && Number(totals.editions) > initialRows.length ? (
        <div className="psq-note">
          Showing the top <b>{num(initialRows.length)}</b> editions by FMV. The totals above cover all{" "}
          <b>{num(totals.editions)}</b> indexed editions.
        </div>
      ) : null}
    </div>
  );
}
