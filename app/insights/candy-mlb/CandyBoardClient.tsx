"use client";
import { useMemo, useState } from "react";
import { FreshnessStamp } from "@/components/insights/FreshnessStamp";

type Row = {
  external_id: string | null;
  player_name: string | null;
  edition_name: string | null;
  tier: string | null;
  is_rainbow: boolean | null;
  circulation_count: number | null;
  fmv_usd: number | null;
  fmv_computed_at: string | null;
  sales_24h: number | null;
  sales_7d: number | null;
  sales_all: number | null;
  last_sale_at: string | null;
  last_sale_usd: number | null;
  best_offer_usd: number | null;
  offer_bidders: number | null;
  floor_ask_usd: number | null;
  listing_count: number | null;
  excluded_troll_count: number | null;
};

export type PackEv = {
  icon_slots: number | null;
  rainbow_chance: number | null;
  pack_cost_usd: number | null;
  common_slot_ev: number | null;
  common_slot_typical: number | null;
  rainbow_ev: number | null;
  common_total: number | null;
  common_priced: number | null;
  rainbow_total: number | null;
  rainbow_priced: number | null;
  actual_ev_usd: number | null;
  typical_pull_ev_usd: number | null;
  model_note: string | null;
};

type Dict = Record<string, any>;

// Locale is pinned to "en-US" rather than left as `undefined` (= runtime
// default). This component is SSR'd, so an implicit locale formats with the
// server's default on the server and the visitor's in the browser — a
// server/client text mismatch (React #418) for anyone whose browser locale
// groups or decimalises numbers differently. Same reason FreshnessStamp pins
// "en-US".
const usd = (x: number | null | undefined) =>
  x == null || isNaN(Number(x)) || Number(x) <= 0
    ? "—"
    : "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: Math.abs(Number(x)) < 100 ? 2 : 0 });
const num = (x: number | null | undefined, d = 0) =>
  x == null || isNaN(Number(x)) ? "—" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d });
const pct = (x: number | null | undefined) => (x == null || isNaN(Number(x)) ? "—" : Number(x).toFixed(1) + "%");
const shortWallet = (w: string | null | undefined) => (w ? w.slice(0, 4) + "…" + w.slice(-4) : "—");

const CSS = `
.cdy-wrap{max-width:1180px;margin:0 auto;padding:20px 16px 60px;color:var(--rpc-text-primary,#ECEAE3)}
.cdy-h1{font-family:var(--font-display,'Barlow Condensed'),sans-serif;font-size:30px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;margin:0;border-bottom:3px solid var(--rpc-red,#E03A2F);padding-bottom:8px;display:inline-block}
.cdy-sub{color:var(--rpc-text-secondary,#9A968C);font-size:12.5px;margin:10px 0 18px}
.cdy-cov{background:var(--rpc-surface,#16161a);border:1px solid var(--rpc-border,rgba(255,255,255,.10));border-left:3px solid var(--rpc-red,#E03A2F);border-radius:8px;padding:10px 13px;margin:0 0 16px;font-size:12px;line-height:1.55;color:var(--rpc-text-secondary,#9A968C)}
.cdy-cov b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
.cdy-ev{background:var(--rpc-surface,#16161a);border:1px solid var(--rpc-border,rgba(255,255,255,.10));border-radius:10px;padding:14px 16px;margin:0 0 16px}
.cdy-ev-row{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-end}
.cdy-ev-lead h3{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--rpc-text-secondary,#9A968C);margin:0 0 5px;font-weight:700}
.cdy-ev-lead .v{font-family:var(--font-mono,ui-monospace),monospace;font-size:30px;font-weight:700;color:#5fd6a0;line-height:1}
.cdy-ev-sec h3{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--rpc-text-secondary,#9A968C);margin:0 0 5px;font-weight:700}
.cdy-ev-sec .v{font-family:var(--font-mono,ui-monospace),monospace;font-size:19px;font-weight:600;color:var(--rpc-text-secondary,#C6C2B8);line-height:1}
.cdy-ev-cost{margin-left:auto;text-align:right}
.cdy-ev-cost h3{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--rpc-text-secondary,#9A968C);margin:0 0 5px;font-weight:700}
.cdy-ev-cost .v{font-family:var(--font-mono,ui-monospace),monospace;font-size:19px;font-weight:600;color:var(--rpc-text-primary,#ECEAE3)}
.cdy-ev-warn{margin-top:11px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);font-size:11.5px;line-height:1.55;color:#e0a64b}
.cdy-ev-warn b{color:#f2c879;font-weight:700}
.cdy-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:18px}
@media(min-width:760px){.cdy-kpis{grid-template-columns:repeat(4,1fr)}}
.cdy-card{background:var(--rpc-surface,#16161a);border:1px solid var(--rpc-border,rgba(255,255,255,.10));border-radius:10px;padding:13px 14px}
.cdy-card h3{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--rpc-text-secondary,#9A968C);margin:0 0 7px;font-weight:700}
.cdy-big{font-family:var(--font-mono,ui-monospace),monospace;font-size:22px;font-weight:600;color:var(--rpc-red,#E03A2F)}
.cdy-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--rpc-border,rgba(255,255,255,.10));margin:0 0 16px}
.cdy-tabs button{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--rpc-text-secondary,#9A968C);padding:8px 12px;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;font-weight:700}
.cdy-tabs button.on{color:var(--rpc-text-primary,#F2F0EA);border-bottom-color:var(--rpc-red,#E03A2F)}
.cdy-tabs button .b{display:inline-block;margin-left:5px;font-size:9px;background:rgba(255,255,255,.10);border-radius:8px;padding:1px 6px;color:var(--rpc-text-secondary,#C6C2B8)}
.cdy-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 12px}
.cdy-controls input{background:var(--rpc-surface,#1b1b20);border:1px solid var(--rpc-border,rgba(255,255,255,.12));border-radius:8px;color:var(--rpc-text-primary,#ECEAE3);padding:7px 11px;font-size:12.5px;min-width:200px}
.cdy-seg{display:flex;border:1px solid var(--rpc-border,rgba(255,255,255,.12));border-radius:8px;overflow:hidden}
.cdy-seg button{background:transparent;border:0;color:var(--rpc-text-secondary,#9A968C);padding:7px 11px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;font-weight:700}
.cdy-seg button.on{background:var(--rpc-red,#E03A2F);color:#fff}
.cdy-blurb{font-size:12px;line-height:1.55;color:var(--rpc-text-secondary,#9A968C);margin:0 0 12px}
.cdy-blurb b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
.cdy-scroll{overflow-x:auto}
.cdy-tbl{width:100%;border-collapse:collapse;border:1px solid var(--rpc-border,rgba(255,255,255,.10));border-radius:10px;overflow:hidden}
.cdy-tbl th,.cdy-tbl td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
.cdy-tbl th{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--rpc-text-secondary,#9A968C);font-weight:700;cursor:pointer}
.cdy-tbl th.n,.cdy-tbl td.n{text-align:right;font-family:var(--font-mono,ui-monospace),monospace}
.cdy-tbl tbody tr:hover td{background:rgba(255,255,255,.03)}
.cdy-nm{font-weight:600;color:var(--rpc-text-primary,#F2F0EA)}
.cdy-par{color:var(--rpc-text-secondary,#9A968C);font-size:11px}
.cdy-rb{font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;color:#0c0c0e;background:linear-gradient(90deg,#f472b6,#a78bfa,#60a5fa);margin-left:5px}
.cdy-off{color:#e0a64b;font-weight:700}
.cdy-disc{color:#5fd6a0;font-weight:700}
.cdy-kind{font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:.03em}
.cdy-kind.first{color:#0c0c0e;background:#f2c879}
.cdy-kind.last{color:#ECEAE3;background:rgba(255,255,255,.14)}
.cdy-kind.low{color:#ECEAE3;background:rgba(96,165,250,.28)}
.cdy-seal{font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;color:#9A968C;border:1px solid rgba(255,255,255,.14);margin-left:5px}
.cdy-note{color:var(--rpc-text-secondary,#9A968C);font-size:11.5px;margin:10px 2px 0}
.cdy-note b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
.cdy-par2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:0 0 16px}
.cdy-par2 .cdy-card .mul{font-size:11px;color:#5fd6a0;font-weight:700;margin-top:5px}
`;

// ── Generic sortable table for the non-Market sections ──────────────────────
type Col = {
  k: string;
  label: string;
  n?: boolean;
  fmt?: (v: any, row: Dict) => React.ReactNode;
  sortable?: boolean;
};
const playerCell = (r: Dict) => (
  <>
    <span className="cdy-nm">{r.player_name || "—"}</span>
    {r.is_rainbow ? <span className="cdy-rb">RB</span> : null}
  </>
);

function DataTable({
  rows,
  cols,
  defaultSort,
  empty,
  cap = 400,
}: {
  rows: Dict[];
  cols: Col[];
  defaultSort: string;
  empty: string;
  cap?: number;
}) {
  const [sortK, setSortK] = useState(defaultSort);
  const [asc, setAsc] = useState(false);
  const sorted = useMemo(() => {
    const r = [...rows].sort((a, b) => {
      let x: any = a[sortK],
        y: any = b[sortK];
      if (typeof x === "string" || typeof y === "string") {
        x = (x || "").toString().toLowerCase();
        y = (y || "").toString().toLowerCase();
        return asc ? (x < y ? -1 : x > y ? 1 : 0) : x < y ? 1 : x > y ? -1 : 0;
      }
      x = x == null ? (asc ? Infinity : -Infinity) : Number(x);
      y = y == null ? (asc ? Infinity : -Infinity) : Number(y);
      return asc ? x - y : y - x;
    });
    return r.slice(0, cap);
  }, [rows, sortK, asc, cap]);

  const onTh = (k: string, sortable: boolean) => {
    if (sortable === false) return;
    if (k === sortK) setAsc(!asc);
    else {
      setSortK(k);
      setAsc(false);
    }
  };

  return (
    <div className="cdy-scroll">
      <table className="cdy-tbl">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.k} className={c.n ? "n" : ""} onClick={() => onTh(c.k, c.sortable !== false)}>
                {c.label}
                {c.k === sortK ? (asc ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={cols.length} className="cdy-par">
                {empty}
              </td>
            </tr>
          ) : (
            sorted.map((r, i) => (
              <tr key={r.pda_address || r.external_id || r.wallet_address || r.player_name || i}>
                {cols.map((c) => (
                  <td key={c.k} className={c.n ? "n" : ""}>
                    {c.fmt ? c.fmt(r[c.k], r) : r[c.k] ?? "—"}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const TABS = [
  { k: "market", label: "Market" },
  { k: "deals", label: "Deals" },
  { k: "spread", label: "Spread" },
  { k: "serials", label: "Serials" },
  { k: "scarcity", label: "Scarcity" },
  { k: "holders", label: "Holders" },
  { k: "players", label: "Players" },
];

const MARKET_TIERS = [
  { k: "", label: "All" },
  { k: "COMMON", label: "ICONs" },
  { k: "LEGENDARY", label: "Rainbows" },
];

export default function CandyBoardClient({
  initialRows,
  packEv = null,
  deals = [],
  spreads = [],
  serials = [],
  scarcity = [],
  holders = [],
  players = [],
  parallel = [],
  fetchedAt,
}: {
  initialRows: Row[];
  packEv?: PackEv | null;
  deals?: Dict[];
  spreads?: Dict[];
  serials?: Dict[];
  scarcity?: Dict[];
  holders?: Dict[];
  players?: Dict[];
  parallel?: Dict[];
  fetchedAt: string;
}) {
  const [tab, setTab] = useState("market");

  // Market tab local state.
  const [sortK, setSortK] = useState<keyof Row>("fmv_usd");
  const [asc, setAsc] = useState(false);
  const [tier, setTier] = useState("");
  const [q, setQ] = useState("");

  const RENDER_CAP = 300;
  const marketRows = useMemo(() => {
    let r = initialRows.filter((x) => {
      if (tier && (x.tier || "").toUpperCase() !== tier) return false;
      if (q && !((x.player_name || "") + " " + (x.edition_name || "")).toLowerCase().includes(q)) return false;
      return true;
    });
    r = [...r].sort((a, b) => {
      let x: any = a[sortK],
        y: any = b[sortK];
      if (sortK === "player_name" || sortK === "edition_name" || sortK === "tier") {
        x = (x || "").toLowerCase();
        y = (y || "").toLowerCase();
        return asc ? (x < y ? -1 : x > y ? 1 : 0) : x < y ? 1 : x > y ? -1 : 0;
      }
      x = x == null ? (asc ? Infinity : -Infinity) : Number(x);
      y = y == null ? (asc ? Infinity : -Infinity) : Number(y);
      return asc ? x - y : y - x;
    });
    return r;
  }, [initialRows, sortK, asc, tier, q]);

  const matched = marketRows.length;
  const visible = marketRows.slice(0, RENDER_CAP);

  const priced = useMemo(() => initialRows.filter((r) => r.fmv_usd != null).length, [initialRows]);
  const sales24h = useMemo(() => initialRows.reduce((s, r) => s + (Number(r.sales_24h) || 0), 0), [initialRows]);
  const withOffer = useMemo(() => initialRows.filter((r) => r.best_offer_usd != null).length, [initialRows]);
  const hiddenOutliers = useMemo(
    () => initialRows.reduce((s, r) => s + (Number(r.excluded_troll_count) || 0), 0),
    [initialRows]
  );
  const withAsk = useMemo(() => initialRows.filter((r) => r.floor_ask_usd != null).length, [initialRows]);

  const th = (k: keyof Row, label: string, n = false) => (
    <th className={n ? "n" : ""} onClick={() => (k === sortK ? setAsc(!asc) : (setSortK(k), setAsc(false)))}>
      {label}
      {k === sortK ? (asc ? " ▲" : " ▼") : ""}
    </th>
  );

  // Parallel-premium summary (Core vs Rainbow) for the Players tab.
  const core = parallel.find((p) => !p.is_rainbow);
  const rainbow = parallel.find((p) => p.is_rainbow);
  const rbMultiple =
    core && rainbow && Number(core.avg_fmv) > 0 && rainbow.avg_fmv != null
      ? Number(rainbow.avg_fmv) / Number(core.avg_fmv)
      : null;

  // Column configs for the generic sections.
  const dealCols: Col[] = [
    { k: "player_name", label: "Player", fmt: (_v, r) => playerCell(r) },
    { k: "edition_name", label: "Edition", fmt: (v) => <span className="cdy-par">{v || "—"}</span> },
    { k: "serial_number", label: "Serial", n: true, fmt: (v) => (v == null ? "—" : "#" + num(v)) },
    { k: "ask_usd", label: "Ask", n: true, fmt: (v) => usd(v) },
    { k: "fmv_usd", label: "FMV", n: true, fmt: (v) => usd(v) },
    { k: "discount_pct", label: "Discount", n: true, fmt: (v) => <span className="cdy-disc">{pct(v)}</span> },
  ];
  const spreadCols: Col[] = [
    { k: "player_name", label: "Player", fmt: (_v, r) => playerCell(r) },
    { k: "edition_name", label: "Edition", fmt: (v) => <span className="cdy-par">{v || "—"}</span> },
    { k: "best_offer_usd", label: "Best offer", n: true, fmt: (v) => <span className="cdy-off">{usd(v)}</span> },
    { k: "distinct_bidders", label: "Bidders", n: true, fmt: (v) => num(v) },
    { k: "floor_usd", label: "Floor ask", n: true, fmt: (v) => usd(v) },
    { k: "spread_usd", label: "Spread", n: true, fmt: (v) => usd(v) },
    // PRESENTATION FIX (P5). The view's `spread_pct` is
    // 100 * (floor_ask - best_offer) / best_offer — i.e. it divides by the BID.
    // On a days-old book with $0.22 lowball bids sitting under $55 asks that is
    // mathematically correct and completely unreadable: all 17 populated rows
    // exceeded 200%, the median was 3,591% and the max was 24,849%. A column of
    // five-digit percentages reads as a broken site, not as a wide spread.
    //
    // We render the conventional bid-ask spread instead — (ask - bid) / ask —
    // which is bounded at 100% and answers the question a collector is actually
    // asking: "how far below the ask is the best standing offer?" A $0.22 bid
    // under a $55 ask is "99.6% below ask", which is both true and legible.
    //
    // Deliberately computed CLIENT-SIDE from floor_usd + best_offer_usd, which
    // are already in the row payload. `spread_pct` has exactly one consumer in
    // the codebase (this column) and feeds no FMV, no pack EV and no published
    // price, so this is purely a display change — no view/migration touched and
    // nothing about pricing is altered. The raw dollar spread is unchanged and
    // remains the honest headline number.
    {
      k: "spread_pct",
      label: "Below ask",
      n: true,
      fmt: (_v, r) => {
        const ask = Number(r.floor_usd);
        const bid = Number(r.best_offer_usd);
        if (!isFinite(ask) || !isFinite(bid) || ask <= 0 || r.floor_usd == null || r.best_offer_usd == null)
          return "—";
        return pct(Math.max(0, ((ask - bid) / ask) * 100));
      },
    },
    { k: "fmv_usd", label: "FMV", n: true, fmt: (v) => usd(v) },
  ];
  const serialCols: Col[] = [
    { k: "player_name", label: "Player", fmt: (_v, r) => playerCell(r) },
    { k: "edition_name", label: "Edition", fmt: (v) => <span className="cdy-par">{v || "—"}</span> },
    {
      k: "kind",
      label: "Type",
      fmt: (v) => {
        const cls = v === "first_mint" ? "first" : v === "last_mint" ? "last" : "low";
        const label = v === "first_mint" ? "#1 First" : v === "last_mint" ? "Last" : "Low";
        return <span className={`cdy-kind ${cls}`}>{label}</span>;
      },
    },
    { k: "serial_number", label: "Serial", n: true, fmt: (v, r) => "#" + num(v) + " / " + num(r.circulation_count) },
    {
      k: "owner",
      label: "Owner",
      fmt: (v, r) => (
        <>
          <span className="cdy-par">{shortWallet(v)}</span>
          {r.is_treasury ? <span className="cdy-seal">SEALED</span> : null}
        </>
      ),
    },
    { k: "last_sale_usd", label: "Last sale", n: true, fmt: (v) => usd(v) },
    { k: "fmv_usd", label: "FMV", n: true, fmt: (v) => usd(v) },
  ];
  const scarcityCols: Col[] = [
    { k: "player_name", label: "Player", fmt: (_v, r) => playerCell(r) },
    { k: "edition_name", label: "Edition", fmt: (v) => <span className="cdy-par">{v || "—"}</span> },
    { k: "circulation_count", label: "Mint", n: true, fmt: (v) => "/" + num(v) },
    { k: "sealed", label: "Sealed", n: true, fmt: (v) => num(v) },
    { k: "circulating", label: "Circulating", n: true, fmt: (v) => num(v) },
    { k: "circulating_pct", label: "% Out", n: true, fmt: (v) => pct(v) },
    { k: "holders", label: "Holders", n: true, fmt: (v) => num(v) },
    { k: "fmv_usd", label: "FMV", n: true, fmt: (v) => usd(v) },
  ];
  const holderCols: Col[] = [
    { k: "wallet_address", label: "Wallet", fmt: (v) => <span className="cdy-nm">{shortWallet(v)}</span> },
    { k: "serials", label: "Serials", n: true, fmt: (v) => num(v) },
    { k: "editions", label: "Editions", n: true, fmt: (v) => num(v) },
    { k: "priced_serials", label: "Priced", n: true, fmt: (v) => num(v) },
    { k: "est_fmv_usd", label: "Est. value", n: true, fmt: (v) => usd(v) },
  ];
  const playerCols: Col[] = [
    { k: "player_name", label: "Player", fmt: (v) => <span className="cdy-nm">{v || "—"}</span> },
    { k: "team_name", label: "Team", fmt: (v) => <span className="cdy-par">{v || "—"}</span> },
    { k: "editions", label: "Editions", n: true, fmt: (v) => num(v) },
    { k: "rainbow_editions", label: "Rainbows", n: true, fmt: (v) => num(v) },
    { k: "total_supply", label: "Supply", n: true, fmt: (v) => num(v) },
    { k: "priced", label: "Priced", n: true, fmt: (v) => num(v) },
    { k: "avg_fmv", label: "Avg FMV", n: true, fmt: (v) => usd(v) },
    { k: "top_fmv", label: "Top FMV", n: true, fmt: (v) => usd(v) },
    { k: "sales_all", label: "Sales", n: true, fmt: (v) => num(v) },
  ];

  return (
    <div className="cdy-wrap">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <h1 className="cdy-h1">Candy · MLB ICONs</h1>
      <div className="cdy-sub">
        2026 MLB Base Series ICONs — Candy Digital on Solana. Live secondary FMV, asks, best offers, scarcity, and
        pack EV. <FreshnessStamp iso={fetchedAt} />
      </div>

      <div className="cdy-cov">
        <b>Early read, not a census.</b> Candy&apos;s secondary market opened <b>~Jul 23</b> (Magic Eden). FMV is
        auto-computed off live sales, but only <b>{num(priced)}</b> of <b>{num(initialRows.length)}</b> editions have
        traded — and most of those prices come off no more than a handful of sales. Un-traded editions show FMV
        &ldquo;—&rdquo;. <b>Best offer</b> is an offer-derived floor and <b>ask/floor</b> is a listing-derived floor —
        <b> neither is FMV</b>. The book is thin and Drop 3 (Jul 29) adds forward supply, so treat these as an
        indicative early signal.
      </div>

      <div className="cdy-tabs">
        {TABS.map((t) => {
          const count =
            t.k === "deals" ? deals.length : t.k === "spread" ? spreads.length : t.k === "holders" ? holders.length : null;
          return (
            <button key={t.k} className={tab === t.k ? "on" : ""} onClick={() => setTab(t.k)}>
              {t.label}
              {count != null ? <span className="b">{num(count)}</span> : null}
            </button>
          );
        })}
      </div>

      {tab === "market" && (
        <>
          {packEv ? (
            <div className="cdy-ev">
              <div className="cdy-ev-row">
                <div className="cdy-ev-lead">
                  <h3>Typical pull value</h3>
                  <div className="v">{usd(packEv.typical_pull_ev_usd)}</div>
                </div>
                <div className="cdy-ev-sec">
                  <h3>Actual EV (chase-inclusive)</h3>
                  <div className="v">{usd(packEv.actual_ev_usd)}</div>
                </div>
                <div className="cdy-ev-cost">
                  <h3>Pack cost</h3>
                  <div className="v">{usd(packEv.pack_cost_usd)}</div>
                </div>
              </div>
              <div className="cdy-ev-warn">
                <b>Read the Typical Pull, not the Actual EV.</b> A pack is {num(packEv.icon_slots)} ICONs + a{" "}
                {num(Number(packEv.rainbow_chance) * 100)}% Rainbow chance. &ldquo;Actual EV&rdquo; is a mean dragged
                up by the Rainbow leg, which is{" "}
                <b>largely unpriced ({num(packEv.rainbow_priced)}/{num(packEv.rainbow_total)})</b> — and you cannot
                liquidate {num(packEv.icon_slots)} ICONs at FMV on a market this thin. These are FMV estimates off
                1–2 sales each; Drop 3 adds ~15,000 more commons, so the floor will move.
              </div>
            </div>
          ) : null}

          <div className="cdy-kpis">
            <div className="cdy-card">
              <h3>Editions</h3>
              <div className="cdy-big">{num(initialRows.length)}</div>
            </div>
            <div className="cdy-card">
              <h3>Priced (traded)</h3>
              <div className="cdy-big">{num(priced)}</div>
            </div>
            <div className="cdy-card">
              <h3>With an ask</h3>
              <div className="cdy-big">{num(withAsk)}</div>
            </div>
            <div className="cdy-card">
              <h3>With a best offer</h3>
              <div className="cdy-big">{num(withOffer)}</div>
            </div>
          </div>

          <div className="cdy-controls">
            <input placeholder="Filter player…" value={q} onChange={(e) => setQ(e.target.value.trim().toLowerCase())} />
            <div className="cdy-seg">
              {MARKET_TIERS.map((t) => (
                <button key={t.k} className={tier === t.k ? "on" : ""} onClick={() => setTier(t.k)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="cdy-scroll">
            <table className="cdy-tbl">
              <thead>
                <tr>
                  {th("player_name", "Player")}
                  {th("edition_name", "Edition")}
                  {th("circulation_count", "Mint", true)}
                  {th("sales_24h", "24h", true)}
                  {th("sales_all", "Sales", true)}
                  {th("last_sale_usd", "Last sale", true)}
                  {th("floor_ask_usd", "Floor ask", true)}
                  {th("best_offer_usd", "Best offer", true)}
                  {th("fmv_usd", "FMV", true)}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="cdy-par">
                      No editions match.
                    </td>
                  </tr>
                ) : (
                  visible.map((r) => (
                    <tr key={r.external_id || r.edition_name || ""}>
                      <td>
                        <span className="cdy-nm">{r.player_name || "—"}</span>
                        {r.is_rainbow ? <span className="cdy-rb">RB</span> : null}
                      </td>
                      <td className="cdy-par">{r.edition_name || "—"}</td>
                      <td className="n">/{num(r.circulation_count)}</td>
                      <td className="n">{num(r.sales_24h)}</td>
                      <td className="n">{num(r.sales_all)}</td>
                      <td className="n">{usd(r.last_sale_usd)}</td>
                      <td className="n">{usd(r.floor_ask_usd)}</td>
                      <td className="n cdy-off">{usd(r.best_offer_usd)}</td>
                      <td className="n">
                        {/* No confidence pill: FMV confidence tiers are a
                            build-time signal only and must never render on a
                            user surface (site-wide policy, 2026-07-11). The
                            honest signal is the sales counts in the columns
                            beside this one + the banner above. */}
                        <b>{usd(r.fmv_usd)}</b>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="cdy-note">
            {matched > visible.length ? (
              <>
                Showing <b>{num(visible.length)}</b> of <b>{num(matched)}</b> matching editions.
              </>
            ) : (
              <>
                Showing all <b>{num(matched)}</b> matching editions.
              </>
            )}{" "}
            FMV auto-computes from live Magic Eden sales; the cold tail with no sales shows &ldquo;—&rdquo;. Floor ask
            is a listing-derived floor and best offer a standing-bid floor — neither is FMV.
            {hiddenOutliers > 0 ? (
              <>
                {" "}
                <b>{num(hiddenOutliers)}</b> outlier {hiddenOutliers === 1 ? "listing" : "listings"} priced &gt;10× the
                edition&apos;s (or its tier&apos;s) FMV are excluded from the floor as likely troll asks.
              </>
            ) : null}
          </div>
        </>
      )}

      {tab === "deals" && (
        <>
          <div className="cdy-blurb">
            <b>Underpriced listings</b> — active Magic Eden asks below the auto-computed FMV, ranked by discount. FMV
            comes off just 1–2 sales and the book is thin, so treat these as <b>indicative, not arbitrage</b>.
            Empty until secondary listings open (the ask feed captures the first one automatically).
          </div>
          <DataTable rows={deals} cols={dealCols} defaultSort="discount_pct" empty="No underpriced listings yet — the ask feed is live and will populate when listings open." />
        </>
      )}

      {tab === "spread" && (
        <>
          <div className="cdy-blurb">
            <b>Bid ↔ ask spread</b> — per edition, the best standing offer against the floor ask. A tight spread with
            multiple bidders is liquid; a wide spread or single bidder is not. Best offer is a bid-derived floor,{" "}
            <b>never FMV</b>. &ldquo;Below ask&rdquo; is how far the best offer sits under the floor ask — on a book
            this young most bids are speculative lowballs, so expect that number to run close to 100%.
          </div>
          <DataTable rows={spreads} cols={spreadCols} defaultSort="best_offer_usd" empty="No offers or asks yet." />
        </>
      )}

      {tab === "serials" && (
        <>
          <div className="cdy-blurb">
            <b>Special serials</b> — every #1 (first mint), last mint, and low serial (≤ #3), with its current owner.{" "}
            <b>SEALED</b> = still held in Candy&apos;s treasury reserve (unsold). Jersey-match serials are not
            included yet — Candy assets do carry a player number, we simply do not surface the match on this
            board, so what you see here is serial-position rarity only.
          </div>
          <DataTable rows={serials} cols={serialCols} defaultSort="fmv_usd" empty="No special serials." cap={550} />
        </>
      )}

      {tab === "scarcity" && (
        <>
          <div className="cdy-blurb">
            <b>Scarcity — sealed vs circulating.</b> Candy&apos;s treasury holds most supply sealed; only{" "}
            <b>circulating</b> serials are in collector hands. Lowest <b>% Out</b> = most squeezed. Sorted most-squeezed
            first.
          </div>
          <DataTable rows={scarcity} cols={scarcityCols} defaultSort="circulating_pct" empty="No scarcity data." cap={130} />
          <div className="cdy-note">
            <b>Sealed</b> is the treasury/max-holder reserve; <b>circulating</b> excludes it. Drop 3 (Jul 29) adds
            forward supply, so circulating % will move.
          </div>
        </>
      )}

      {tab === "holders" && (
        <>
          <div className="cdy-blurb">
            <b>Holder concentration.</b> Collector wallets only — the treasury/max-holder reserve is excluded.{" "}
            <b>Est. value</b> sums each held serial&apos;s edition FMV, which is as thin as every Candy price today.
          </div>
          <DataTable rows={holders} cols={holderCols} defaultSort="serials" empty="No holders." cap={250} />
        </>
      )}

      {tab === "players" && (
        <>
          {core && rainbow ? (
            <div className="cdy-par2">
              <div className="cdy-card">
                <h3>Core ICON — avg FMV</h3>
                <div className="cdy-big">{usd(core.avg_fmv)}</div>
                <div className="cdy-par" style={{ marginTop: 4 }}>
                  {num(core.priced)}/{num(core.editions)} priced
                </div>
              </div>
              <div className="cdy-card">
                <h3>Rainbow parallel — avg FMV</h3>
                <div className="cdy-big">{usd(rainbow.avg_fmv)}</div>
                <div className="cdy-par" style={{ marginTop: 4 }}>
                  {num(rainbow.priced)}/{num(rainbow.editions)} priced
                  {rbMultiple ? <span className="mul"> · ~{rbMultiple.toFixed(1)}× premium</span> : null}
                </div>
              </div>
            </div>
          ) : null}
          <div className="cdy-blurb">
            <b>Per-player rollup.</b> The Rainbow premium is real but <b>thin</b> — only {num(rainbow?.priced)} of{" "}
            {num(rainbow?.editions)} Rainbows have a sale, so the multiple is an early signal, not a settled ratio.
          </div>
          <DataTable rows={players} cols={playerCols} defaultSort="top_fmv" empty="No players." />
        </>
      )}
    </div>
  );
}
