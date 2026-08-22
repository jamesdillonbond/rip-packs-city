"use client";
import { useMemo, useState } from "react";
import { FreshnessStamp } from "@/components/insights/FreshnessStamp";
import DegradedDataNotice from "@/components/insights/DegradedDataNotice";
import type { DegradedSummary } from "@/lib/insights/board-status";

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
  last_sale_serial: number | null;
  median_sale_usd: number | null;
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
.cdy-trunc{margin:8px 2px 0;line-height:1.5}
.cdy-trunc b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
.cdy-rb{font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;color:#0c0c0e;background:linear-gradient(90deg,#f472b6,#a78bfa,#60a5fa);margin-left:5px}
.cdy-off{color:#e0a64b;font-weight:700}
.cdy-disc{color:#5fd6a0;font-weight:700}
.cdy-kind{font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:.03em}
.cdy-kind.first{color:#0c0c0e;background:#f2c879}
.cdy-kind.last{color:#ECEAE3;background:rgba(255,255,255,.14)}
.cdy-kind.low{color:#ECEAE3;background:rgba(96,165,250,.28)}
.cdy-kind.jersey{color:#0c0c0e;background:#7fd1a8}
.cdy-seal{font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;color:#9A968C;border:1px solid rgba(255,255,255,.14);margin-left:5px}
.cdy-note{color:var(--rpc-text-secondary,#9A968C);font-size:11.5px;margin:10px 2px 0}
.cdy-note b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
.cdy-par2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:0 0 16px}
.cdy-par2 .cdy-card .mul{font-size:11px;color:#5fd6a0;font-weight:700;margin-top:5px}
`;

// ── Generic sortable table for the non-Market sections ──────────────────────
// What packs ACTUALLY sell for, from candy_pack_sales via candy_pack_market.
type PackMarket = {
  pack_assets_indexed: number | null;
  collector_held: number | null;
  collector_wallets: number | null;
  active_asks: number | null;
  floor_ask_usd: number | null;
  sales_all: number | null;
  sales_7d: number | null;
  median_7d_usd: number | null;
  last_sale_usd: number | null;
  last_sale_at: string | null;
  retail_usd: number | null;
  median_vs_retail_x: number | null;
  median_vs_typical_pull_x: number | null;
  median_vs_actual_ev_x: number | null;
};

type Col = {
  k: string;
  label: string;
  n?: boolean;
  fmt?: (v: any, row: Dict) => React.ReactNode;
  sortable?: boolean;
  // Optional sort-value accessor. Use it whenever `fmt` DISPLAYS a figure that
  // is not simply `row[k]` - otherwise the header arrow claims an ordering the
  // visible column does not show. The displayed number is the source of truth.
  sv?: (row: Dict) => number | null;
  /** Hover text explaining the column's basis, for figures whose definition is
   *  not self-evident from the label (e.g. which leg a spread is measured against). */
  title?: string;
};
// D33 (2026-08-09). There used to be a `belowAskPct(r)` helper here computing
// (floor_usd - best_offer_usd) / floor_usd and clamping the result at 0%.
//
// It has been REMOVED, not repaired, because both of its inputs were valid but
// its SUBTRACTION was not: `floor_usd` is an EDITION-grain min ask while
// `best_offer_usd` is a MINT-grain max bid — a bid on one specific NFT. Measured
// live before the fix, only 2 of the 33 two-legged rows had the top offer on the
// same mint as the floor listing, so 94% of the figure priced one NFT against a
// different one, and 7 rows came out NEGATIVE (worst -91.9%) — which on a public
// board reads as "buy below the standing bid", i.e. free money that isn't there.
//
// ⚠ The clamp was the tell, and it is why this survived: an earlier pass saw the
// crossed rows, decided a bid above an ask was a rendering problem, and pinned
// the display at 0% instead of asking how a bid could exceed an ask at all. A
// clamp that makes an impossible number look possible HIDES the defect. When a
// figure needs clamping to stay plausible, doubt the figure, not the display.
//
// Comparing the SAME copy, zero books are crossed. So the spread is now computed
// in the view (`exec_spread_pct`) over the floor copy alone, and rendered below
// only where it genuinely exists.

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
    const svByKey = new Map(cols.filter((c) => c.sv).map((c) => [c.k, c.sv!]));
    const r = [...rows].sort((a, b) => {
      const sv = svByKey.get(sortK);
      let x: any = sv ? sv(a) : a[sortK],
        y: any = sv ? sv(b) : b[sortK];
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
  }, [rows, cols, sortK, asc, cap]);

  // ⚠ `cap` is a RANKED slice, so truncation is invisible by construction:
  // every row on screen is still correct, the board just silently stops. Each
  // call site was individually raised until it stopped biting at TODAY's row
  // counts, which is a data-dependent margin rather than a guarantee — Candy is
  // expecting further drops, and the scarcity cap sits at 130 against 125
  // editions. Disclose it here so a future overflow announces itself instead of
  // quietly shortening a ranking.
  const truncated = rows.length > cap;

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
              <th key={c.k} className={c.n ? "n" : ""} title={c.title} onClick={() => onTh(c.k, c.sortable !== false)}>
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
              // The old key was `pda_address || external_id || wallet_address ||
              // player_name || i` — first-truthy-wins. On the Serials tab that
              // resolves to external_id, and EVERY edition contributes up to four
              // rows (first_mint / last_mint / low_serial / jersey_match), so all
              // 500 rows rendered with duplicate keys. React's documented
              // behaviour there is to duplicate or omit children, and this table
              // re-sorts on every header click. Composite key instead: the
              // identity fields PLUS serial_number and kind, which is what
              // actually distinguishes two rows of the same edition.
              <tr
                key={
                  [r.pda_address, r.external_id, r.wallet_address, r.player_name, r.serial_number, r.kind]
                    .filter((x) => x !== null && x !== undefined && x !== "")
                    .join("|") || String(i)
                }
              >
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
      {truncated ? (
        <p className="cdy-par cdy-trunc" role="status">
          Showing the top <b>{num(cap)}</b> of <b>{num(rows.length)}</b> rows for this sort.
          <span> Re-sort to see a different slice — this list is capped, not complete.</span>
        </p>
      ) : null}
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

// ── Per-panel degraded copy (deep-audit R18) ────────────────────────────────
// The page-level banner already names which sections failed and tells the reader
// to "treat the affected sections as unknown rather than zero". Every panel then
// re-derived emptiness from a zero-length array and published "No offers or asks
// yet." — contradicting the banner ~200px above it on the same screen.
//
// The rows array cannot distinguish the three states on its own: a failed read
// and a genuinely empty section both arrive as []. `degraded` is the only thing
// that knows, so the panel has to consume it rather than guess.
//
// ⚠ Keyed on the SAME label strings the server builds its BoardStatus list from
// (lib/insights/candy-board.ts). If a label is renamed on one side only, this
// silently falls back to the healthy copy — which is why the labels are pinned
// by a test rather than trusted.
function sectionEmptyCopy(
  label: string,
  degraded: DegradedSummary | null | undefined,
  healthyCopy: string
): string {
  if (degraded?.failed?.includes(label)) {
    return "Couldn't load this section — treat it as unknown, not zero. Reload shortly."
  }
  if (degraded?.truncated?.includes(label)) {
    return "This section is showing an incomplete slice — some rows could not be read."
  }
  return healthyCopy
}

/** Row count for a tab badge, or null when the section did not load. */
// ⚠ A failed section previously rendered a badge of 0, which is the documented
// "?? 0 publishes a measured zero" shape one layer up: the badge is a COUNT, and
// 0 is a claim about the market. Absent is honest; zero is not.
function sectionBadge(
  label: string,
  degraded: DegradedSummary | null | undefined,
  rows: unknown[]
): number | null {
  if (degraded?.failed?.includes(label)) return null
  return rows.length
}

export default function CandyBoardClient({
  initialRows,
  packEv = null,
  packMarket = null,
  deals = [],
  spreads = [],
  serials = [],
  scarcity = [],
  holders = [],
  players = [],
  parallel = [],
  degraded = null,
  fetchedAt,
}: {
  initialRows: Row[];
  packEv?: PackEv | null;
  packMarket?: PackMarket | null;
  deals?: Dict[];
  spreads?: Dict[];
  serials?: Dict[];
  scarcity?: Dict[];
  holders?: Dict[];
  players?: Dict[];
  parallel?: Dict[];
  /** Non-null only when a backing query FAILED — see lib/insights/board-status.ts. */
  degraded?: DegradedSummary | null;
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
    { k: "discount_pct", label: "vs FMV", n: true, fmt: (v) => <span className="cdy-disc">{pct(v)}</span> },
    // The second opinion, and on a market this thin it is the honest one.
    // FMV is a fitted estimate off 1-11 sales, so one high print lifts it above
    // every other trade: on 2026-07-27 an ask of $4.58 on bobby-witt-jr showed
    // "44.9% off" against a $4.44 MEDIAN sale — no discount at all. The view now
    // refuses to publish a listing that does not also beat the median, and this
    // column shows the reader the number that guard is based on.
    {
      k: "discount_vs_median_pct",
      label: "vs median sale",
      n: true,
      fmt: (v, r) =>
        v == null ? (
          "—"
        ) : (
          <span title={`median of ${num(r.sales_count)} sale${Number(r.sales_count) === 1 ? "" : "s"}: ${usd(r.median_sale_usd)}`}>
            {pct(v)}
          </span>
        ),
    },
  ];
  const spreadCols: Col[] = [
    { k: "player_name", label: "Player", fmt: (_v, r) => playerCell(r) },
    { k: "edition_name", label: "Edition", fmt: (v) => <span className="cdy-par">{v || "—"}</span> },
    {
      k: "best_offer_usd",
      label: "Best offer",
      n: true,
      // Mark the grain inline. `same_copy` is false when the best bid is on a
      // DIFFERENT NFT than the floor listing (31 of 33 two-legged rows today),
      // which is exactly the fact that made the old spread column meaningless.
      // Undefined (an older cached snapshot) renders no chip rather than a
      // wrong one — the field is additive, so the page stays fail-soft.
      fmt: (v, r) => (
        <>
          <span className="cdy-off">{usd(v)}</span>
          {r.same_copy === false ? (
            <span className="cdy-par" title="This bid is on a different copy than the floor listing.">
              {" "}
              ≠ copy
            </span>
          ) : null}
        </>
      ),
    },
    { k: "distinct_bidders", label: "Bidders", n: true, fmt: (v) => num(v) },
    { k: "floor_usd", label: "Floor ask", n: true, fmt: (v) => usd(v) },
    // D33 (2026-08-09). This replaces the old "Spread" ($) and "Below ask" (%)
    // pair, both of which subtracted an edition-grain ask from a mint-grain bid
    // — see the note above `spreadCols`' helper block.
    //
    // The view now supplies `exec_spread_pct`: ask-denominated, and measured on
    // the FLOOR COPY ALONE (the cheapest listed NFT against the best standing
    // bid on that same NFT). That is the only spread here that is executable,
    // and it is bounded, so no clamp is needed or wanted.
    //
    // It is null on most rows — 3 of 125 populate today — and that emptiness is
    // the honest answer: with no bid on the cheapest copy there is no spread to
    // quote. Showing "—" is strictly better than showing a confident number
    // derived from two different NFTs. Sorting reads the same field it displays.
    {
      k: "exec_spread_pct",
      label: "Spread (same copy)",
      n: true,
      title:
        "(floor ask - best bid on that same copy) / floor ask. Blank when the cheapest listed copy carries no bid, which is most rows — a bid on a different copy is not a spread.",
      fmt: (v, r) =>
        v == null ? (
          <span title="No standing bid on the cheapest listed copy.">—</span>
        ) : (
          <span title={r.exec_spread_usd != null ? `${usd(r.exec_spread_usd)} on the floor copy` : undefined}>
            {pct(v)}
          </span>
        ),
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
        // jersey_match is the fourth kind (added 2026-07-27). It MUST be matched
        // explicitly: the old fallthrough labelled anything that was not
        // first/last as "Low", which would have mislabelled every jersey row as a
        // low serial the moment editions.jersey_number fills on the daily walk.
        const cls =
          v === "first_mint" ? "first" : v === "last_mint" ? "last" : v === "jersey_match" ? "jersey" : "low";
        const label =
          v === "first_mint" ? "#1 First" : v === "last_mint" ? "Last" : v === "jersey_match" ? "Jersey" : "Low";
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
        pack EV. Updated <FreshnessStamp iso={fetchedAt} />
      </div>

      <DegradedDataNotice summary={degraded} />

      <div className="cdy-cov">
        <b>Early read, not a census.</b> Candy&apos;s secondary market opened <b>~Jul 23</b> (Magic Eden). FMV is
        auto-computed off live sales.{" "}
        {priced >= initialRows.length ? (
          <>
            All <b>{num(initialRows.length)}</b>{" "}
            <span>editions have now traded, but most prices come off no more than a handful of sales.</span>
          </>
        ) : (
          <>
            Only <b>{num(priced)}</b> of <b>{num(initialRows.length)}</b>{" "}
            <span>editions have traded — and most of those prices come off no more than a handful of sales.</span>{" "}
            The remaining <b>{num(initialRows.length - priced)}</b>{" "}
            <span>show FMV &ldquo;—&rdquo; rather than a guess.</span>
          </>
        )}{" "}
        <b>Best offer</b> is an offer-derived floor and <b>ask/floor</b> is a listing-derived floor —
        <b> neither is FMV</b>. The book is thin and Drop 3 (Jul 29) added forward supply, so treat these as an
        indicative early signal.
      </div>

      <div className="cdy-tabs">
        {TABS.map((t) => {
          const count =
            t.k === "deals"
              ? sectionBadge("Deals", degraded, deals)
              : t.k === "spread"
                ? sectionBadge("Offer spread", degraded, spreads)
                : t.k === "holders"
                  ? sectionBadge("Holders", degraded, holders)
                  : null;
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
                {/* The model is only half the story. Candy packs trade on Magic
                    Eden and RPC indexes those sales, so the realised price sits
                    beside the estimate rather than leaving a reader to assume
                    the model IS the price. */}
                {packMarket && packMarket.median_7d_usd != null ? (
                  <div className="cdy-ev-sec">
                    <h3>Packs actually sell for</h3>
                    <div className="v">{usd(packMarket.median_7d_usd)}</div>
                  </div>
                ) : null}
              </div>
              <div className="cdy-ev-warn">
                <b>Read the Typical Pull, not the Actual EV.</b> A pack is {num(packEv.icon_slots)} ICONs + a{" "}
                {num(Number(packEv.rainbow_chance) * 100)}% Rainbow chance. &ldquo;Actual EV&rdquo; is a mean dragged
                up by the Rainbow leg, which is{" "}
                <b>largely unpriced ({num(packEv.rainbow_priced)}/{num(packEv.rainbow_total)})</b> — and you cannot
                liquidate {num(packEv.icon_slots)}{" "}
                ICONs at FMV on a market this thin. Drop 3 (Jul 29) added ~15,000 more commons, so the floor
                has moved since these prices were set.
                {packMarket && packMarket.median_7d_usd != null ? (
                  <>
                    {" "}
                    <b>
                      The market has an opinion: sealed packs have traded a median of{" "}
                      {usd(packMarket.median_7d_usd)}
                      {packMarket.median_vs_retail_x != null ? ` (${packMarket.median_vs_retail_x}× the ` : " (above "}
                      {usd(packMarket.retail_usd)} cost)
                      {packMarket.median_vs_typical_pull_x != null
                        ? `, i.e. ${packMarket.median_vs_typical_pull_x}× the typical pull`
                        : ""}
                      , across {num(packMarket.sales_all)} recorded sale
                      {Number(packMarket.sales_all) === 1 ? "" : "s"}.
                    </b>{" "}
                    Thin, but it is a real print rather than a model.
                  </>
                ) : null}
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
                  {th("median_sale_usd", "Median sale", true)}
                  {th("floor_ask_usd", "Floor ask", true)}
                  {th("best_offer_usd", "Best offer", true)}
                  {th("fmv_usd", "FMV", true)}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="cdy-par">
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
                      <td className="n">
                        {usd(r.last_sale_usd)}
                        {r.last_sale_serial != null ? (
                          <span className="cdy-par"> #{num(r.last_sale_serial)}</span>
                        ) : null}
                      </td>
                      {/* The median trade, beside the last print. On a market
                          this thin one high sale can sit 4-5x above everything
                          else (bobby-witt-jr last printed $20.04 against a
                          $4.44 median), and without this column that print
                          reads as the price. Same figure the Deals guard uses. */}
                      <td className="n">{usd(r.median_sale_usd)}</td>
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
                <b>{num(hiddenOutliers)}</b> outlier {hiddenOutliers === 1 ? "listing" : "listings"}{" "}
                priced &gt;10× the edition&apos;s (or its tier&apos;s) FMV are excluded from the floor as likely troll
                asks.
              </>
            ) : null}
          </div>
        </>
      )}

      {tab === "deals" && (
        <>
          <div className="cdy-blurb">
            <b>Underpriced listings</b> — active Magic Eden asks that sit below the auto-computed FMV{" "}
            <b>and</b> below what the edition actually trades at. FMV is fitted off a handful of sales, so a single
            high print can lift it above every other trade; a listing only appears here if it also beats the{" "}
            <b>median sale</b>, and both numbers are shown so you can judge which one to believe. The book is thin —
            treat these as <b>indicative, not arbitrage</b>.
          </div>
          <DataTable rows={deals} cols={dealCols} defaultSort="discount_vs_median_pct" empty={sectionEmptyCopy("Deals", degraded, "No underpriced listings yet — the ask feed is live and will populate when listings open.")} />
        </>
      )}

      {tab === "spread" && (
        <>
          <div className="cdy-blurb">
            <b>Bid and ask floors</b> — per edition, the best standing offer alongside the floor ask. Best offer is a
            bid-derived floor and floor ask a listing-derived floor; neither is <b>FMV</b>. The two are usually{" "}
            <b>quotes on different copies</b> — bids here name a specific serial, and the cheapest listed copy is
            normally not the one being bid on, so a row marked &ldquo;≠ copy&rdquo; has no spread between its two
            numbers. <b>Spread (same copy)</b> is filled in only where the cheapest listed copy carries a bid of its
            own, which is the only comparison you could actually trade against.
          </div>
          <DataTable rows={spreads} cols={spreadCols} defaultSort="best_offer_usd" empty={sectionEmptyCopy("Offer spread", degraded, "No offers or asks yet.")} />
        </>
      )}

      {tab === "serials" && (
        <>
          <div className="cdy-blurb">
            <b>Special serials</b> — every #1 (first mint), last mint, low serial (≤ #3) and{" "}
            <b>jersey match</b> (the serial equal to the number the player wears), with its current owner.{" "}
            <b>SEALED</b> = still held in Candy&apos;s treasury reserve (unsold). A serial that is both a low serial
            and the jersey number keeps its low-serial label, so each serial appears once.
          </div>
          {/* cap 550 -> 800: DataTable slices silently (r.slice(0, cap)) with no
              "showing N of M" indicator, and the jersey_match arm raises the
              theoretical max from 500 to 625. 800 keeps it un-truncated. */}
          <DataTable rows={serials} cols={serialCols} defaultSort="fmv_usd" empty={sectionEmptyCopy("Serials", degraded, "No special serials.")} cap={800} />
        </>
      )}

      {tab === "scarcity" && (
        <>
          <div className="cdy-blurb">
            <b>Scarcity — sealed vs circulating.</b> Candy&apos;s treasury holds most supply sealed; only{" "}
            <b>circulating</b> serials are in collector hands. Lowest <b>% Out</b> = most squeezed. Sorted most-squeezed
            first.
          </div>
          <DataTable rows={scarcity} cols={scarcityCols} defaultSort="circulating_pct" empty={sectionEmptyCopy("Scarcity", degraded, "No scarcity data.")} cap={130} />
          <div className="cdy-note">
            <b>Sealed</b> is the treasury/max-holder reserve; <b>circulating</b> excludes it. Drop 3 (Jul 29) added
            forward supply, so circulating % has moved since.
          </div>
        </>
      )}

      {tab === "holders" && (
        <>
          <div className="cdy-blurb">
            <b>Holder concentration.</b> Collector wallets only — the treasury/max-holder reserve is excluded.{" "}
            <b>Est. value</b> sums each held serial&apos;s edition FMV, which is as thin as every Candy price today.
          </div>
          {/* cap 250 -> 800: DataTable slices silently (r.slice(0, cap)) with no
              "showing N of M" indicator, but the tab badge shows holders.length
              (the full fetched count). Collector wallets already exceed 250
              (407 live 2026-08-02), so the badge said e.g. "Holders 407" while
              the table rendered only 250 — 157 holders silently dropped. 800
              keeps it un-truncated with headroom (mirrors the Serials cap and
              the fetch limit raised alongside it in page.tsx). */}
          <DataTable rows={holders} cols={holderCols} defaultSort="serials" empty={sectionEmptyCopy("Holders", degraded, "No holders.")} cap={800} />
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
          <DataTable rows={players} cols={playerCols} defaultSort="top_fmv" empty={sectionEmptyCopy("Players", degraded, "No players.")} />
        </>
      )}
    </div>
  );
}
