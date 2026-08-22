"use client";
import { useMemo, useState } from "react";
import { FreshnessStamp } from "@/components/insights/FreshnessStamp";
import DegradedDataNotice from "@/components/insights/DegradedDataNotice";
import type { DegradedSummary } from "@/lib/insights/board-status";
import { fmvBasis } from "@/lib/fmv-basis";

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
  // Serial-level PRICE COVERAGE (serials carrying a last_sale_usd), not market activity.
  // Renamed from `real_sales` 2026-07-28 — the old name read as a sales count and
  // contradicted the neighbouring fmv_confidence, which comes from a different source.
  serials_with_recorded_price: number | null;
  // Per-(set, parallel) listing-bias band from panini_coverage_audit: banded on the share of
  // pulled copies CURRENTLY LISTED (>=90 listing_gated, >=25 heavily_biased, >=10 partial,
  // else broad). A high share means most of what we know about that parallel arrived through
  // listings, so the sample is bias-prone. It is NOT a measurement of checklist coverage.
  coverage_flag: string | null;
  // Only ever read through lib/fmv-basis.ts, which maps ASK_ONLY -> a plain-English
  // "from asks" marker and everything else -> null. The enum value itself must NOT
  // be rendered (standing no-confidence-UI policy); this column exists so an
  // ask-derived FMV -- 0.90 x one seller's ask on a card that never traded -- stops
  // looking identical to a sale-derived one.
  fmv_confidence: string | null;
};

export type Totals = {
  editions: number | null;
  sealed_fmv_exposure_usd: number | null;
  chases_lte_25: number | null;
  sealed_copies: number | null;
  // `_hc` = the lower-bias subset (coverage_flag broad + partial). These are the HEADLINE
  // figures; the un-suffixed ones above are the all-sets blend, shown as a labelled secondary.
  editions_hc: number | null;
  sealed_fmv_exposure_usd_hc: number | null;
  sealed_copies_hc: number | null;
  pct_sealed_usd_from_biased_sets: number | null;
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
  // Age in hours of the least / most recently refreshed parallel. The runner walks
  // families in rotation, not all at once, so the board is a MIX of refresh ages --
  // a single "updated N minutes ago" stamp on the page implies a uniform freshness
  // the data does not have. Measured 2026-08-02: newest 3.3h, oldest 383.9h (16 days).
  oldest_family_refresh_h: number | null;
  newest_family_refresh_h: number | null;
};

const usd = (x: number | null | undefined) =>
  x == null || isNaN(Number(x)) || Number(x) <= 0
    ? "—"
    : "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: Math.abs(Number(x)) < 100 ? 2 : 0 });
const num = (x: number | null | undefined, d = 0) =>
  x == null || isNaN(Number(x)) ? "—" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d });

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
.psq-alt{color:var(--rpc-text-secondary,#9A968C);font-size:10.5px;margin-top:5px;line-height:1.4}
.psq-alt b{color:var(--rpc-text-primary,#ECEAE3);font-weight:600;font-family:var(--font-mono,ui-monospace),monospace}
.psq-band{font-size:9px;font-weight:800;letter-spacing:.03em;padding:2px 5px;border-radius:3px;text-transform:uppercase;white-space:nowrap}
.psq-band-broad{background:rgba(95,214,160,.16);color:#5fd6a0}
.psq-band-partial{background:rgba(224,166,75,.16);color:#e0a64b}
.psq-band-biased{background:rgba(224,58,47,.18);color:#f2705f}
.psq-band-listed{background:rgba(255,255,255,.08);color:var(--rpc-text-secondary,#9A968C)}
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
/* Ask-derived FMV marker. Deliberately quiet -- it sits beside the value, not on top of it,
   because it qualifies the number rather than replacing it. */
.psq-basis{display:block;font-size:9px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#e0a64b;margin-top:2px;cursor:help}
`;

// Ask-derived FMV marker for one row. Returns null for every sale-derived price, so the
// common case stays unmarked -- marking everything would drown the row that matters.
function basisFor(r: Row) {
  if (r.fmv_usd == null) return null;
  const b = fmvBasis(r.fmv_confidence);
  return b ? <span className="psq-basis" title={b.title}>{b.label}</span> : null;
}

// Listing-bias bands. Wording is deliberate: these describe how BROAD the sample is for a
// parallel, not how complete our checklist is. "Coverage" would overclaim — the band knows
// nothing about the cards we have never seen.
const BANDS: Record<string, { label: string; cls: string; hint: string }> = {
  broad: { label: "Broad", cls: "psq-band-broad", hint: "Under 10% of pulled copies are listed — the sample is not listing-driven." },
  partial: { label: "Partial", cls: "psq-band-partial", hint: "10–25% of pulled copies are listed — moderate listing bias." },
  heavily_biased: { label: "High bias", cls: "psq-band-biased", hint: "Over 25% of pulled copies are listed — most of what we see arrived via listings. Excluded from the headline." },
  listing_gated: { label: "Listed only", cls: "psq-band-listed", hint: "Over 90% of pulled copies are listed — visible to us essentially only while listed. Excluded from the headline." },
};

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
  degraded = null,
}: {
  initialRows: Row[];
  /** Age of the ROWS (MV refresh time), not when the page rendered. null = unknown -> "—". */
  fetchedAt: string | null;
  coverage?: Coverage | null;
  totals?: Totals | null;
  /** Non-null only when the backing query FAILED — see lib/insights/board-status.ts. */
  degraded?: DegradedSummary | null;
}) {
  const [sortK, setSortK] = useState<keyof Row>("fmv_usd");
  const [asc, setAsc] = useState(false);
  const [cap, setCap] = useState(0);
  const [rookie, setRookie] = useState(false);
  const [q, setQ] = useState("");

  // Filter/sort over the FULL fetched board, then render a bounded slice. Keeps filters
  // complete without putting ~1.8k rows in the DOM.
  const RENDER_CAP = 300;
  const rows = useMemo(() => {
    let r = initialRows.filter((x) => {
      if (cap === 1 ? Number(x.mint_cap) !== 1 : cap > 0 && Number(x.mint_cap) > cap) return false;
      if (rookie && !x.is_rookie) return false;
      if (q && !((x.player_name || "") + " " + (x.set_name || "")).toLowerCase().includes(q)) return false;
      return true;
    });
    r = [...r].sort((a, b) => {
      let x: any = a[sortK], y: any = b[sortK];
      if (sortK === "player_name" || sortK === "set_name" || sortK === "tier" || sortK === "coverage_flag") {
        x = (x || "").toLowerCase(); y = (y || "").toLowerCase();
        return asc ? (x < y ? -1 : x > y ? 1 : 0) : x < y ? 1 : x > y ? -1 : 0;
      }
      x = x == null ? (asc ? Infinity : -Infinity) : Number(x);
      y = y == null ? (asc ? Infinity : -Infinity) : Number(y);
      return asc ? x - y : y - x;
    });
    return r;
  }, [initialRows, sortK, asc, cap, rookie, q]);

  const matched = rows.length;                 // how many editions actually match the filters
  const visible = rows.slice(0, RENDER_CAP);   // what we put in the DOM

  // Slice-derived fallbacks — used only if the whole-board totals query fails (fail-soft).
  const sealedTotal = useMemo(() => initialRows.reduce((s, r) => s + (Number(r.sealed_fmv_exposure_usd) || 0), 0), [initialRows]);
  const chases = useMemo(() => initialRows.filter((r) => Number(r.mint_cap) <= 25).length, [initialRows]);
  const sealedCopies = useMemo(() => initialRows.reduce((s, r) => s + (Number(r.still_in_packs) || 0), 0), [initialRows]);

  // Only lead with the honest split when the view actually served it. If the `_hc` columns are
  // missing (older view, or a degraded totals fetch), fall back to the blended figures WITHOUT
  // the lower-bias labelling — mislabelling a blended number is worse than showing a blend.
  const hc = totals != null && totals.sealed_fmv_exposure_usd_hc != null && totals.editions_hc != null;

  // Self-measuring, like the coverage banner: counted off the rows we actually fetched, so the
  // disclosure can never go stale the way a hardcoded figure would. These are the editions whose
  // FMV is 0.90 x a single seller's ask because nothing has ever traded.
  const askDerived = useMemo(
    () => initialRows.reduce((n, r) => n + (r.fmv_usd != null && fmvBasis(r.fmv_confidence) ? 1 : 0), 0),
    [initialRows]
  );

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
        2026 Prizm World Cup Soccer — which cards are still sealed in packs. Updated{" "}
        <FreshnessStamp iso={fetchedAt} />
      </div>

      <DegradedDataNotice summary={degraded} />

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
          ) : null}
          {coverage.oldest_family_refresh_h != null && Number(coverage.oldest_family_refresh_h) >= 48 ? (
            <>
              {" "}Parallels are refreshed in rotation, not all at once, so rows differ in age: the
              most recently refreshed parallel is{" "}
              <b>{num(coverage.newest_family_refresh_h, 0)}h</b> old and the least recent is{" "}
              <b>{Math.round(Number(coverage.oldest_family_refresh_h) / 24)} days</b> old.
            </>
          ) : null}{" "}
          Treat this board as a <b>floor, not a census</b>.
        </div>
      ) : null}

      <div className="psq-kpis">
        <div className="psq-card">
          <h3>Editions{hc ? " · lower-bias" : ""}</h3>
          <div className="psq-big">{num(hc ? totals!.editions_hc : (totals?.editions ?? initialRows.length))}</div>
          {hc ? <div className="psq-alt">of <b>{num(totals!.editions)}</b> across all sets</div> : null}
        </div>
        <div className="psq-card">
          <h3>Value sealed in packs{hc ? " · lower-bias" : ""}</h3>
          <div className="psq-big">{usd(hc ? totals!.sealed_fmv_exposure_usd_hc : (totals?.sealed_fmv_exposure_usd ?? sealedTotal))}</div>
          {hc ? <div className="psq-alt"><b>{usd(totals!.sealed_fmv_exposure_usd)}</b> incl. high-bias sets</div> : null}
        </div>
        <div className="psq-card">
          <h3>Chases ≤ /25 · all sets</h3>
          <div className="psq-big">{num(totals?.chases_lte_25 ?? chases)}</div>
          {hc ? <div className="psq-alt">not split by sample breadth</div> : null}
        </div>
        <div className="psq-card">
          <h3>Sealed copies{hc ? " · lower-bias" : ""}</h3>
          <div className="psq-big">{num(hc ? totals!.sealed_copies_hc : (totals?.sealed_copies ?? sealedCopies))}</div>
          {hc ? <div className="psq-alt">of <b>{num(totals!.sealed_copies)}</b> across all sets</div> : null}
        </div>
      </div>

      {/* The methodology line is load-bearing, not decoration: without it the two figures in
          each card look like a rounding difference rather than two different populations. */}
      {hc ? (
        <div className="psq-note">
          <b>Basis:</b>{" "}
          {totals!.pct_sealed_usd_from_biased_sets != null ? (
            <>
              <b>{num(totals!.pct_sealed_usd_from_biased_sets, 1)}%</b> of all-sets sealed value comes from sets whose
              discovery is listing-biased, so the headline excludes them and shows the all-sets blend underneath.
            </>
          ) : (
            <>
              The headline excludes sets whose discovery is listing-biased and shows the all-sets blend underneath.
            </>
          )}{" "}
          A set&rsquo;s band comes from the share of its pulled copies currently listed — a <b>bias-risk indicator</b>,
          not a measurement of how much of the checklist we hold.
        </div>
      ) : null}

      {/* ASK-DERIVED FMV disclosure (2026-08-01). This board's single largest FMV was 90% of one
          $500,010 ask on a card that has never traded, rendered identically to a sale-derived
          price. The per-row "from asks" marker is the fix; this line tells a reader the marker
          exists and how much of the board it covers. Count is measured, never hardcoded. */}
      {askDerived > 0 ? (
        <div className="psq-note">
          <b>Prices:</b> <b>{num(askDerived)}</b> of the priced editions below have never traded — their FMV is
          the lowest listed ask, discounted, and is marked <span className="psq-basis" style={{ display: "inline" }}>from asks</span>{" "}
          in the FMV column. An asking price is not a market price; treat those rows as one seller&rsquo;s opinion.
        </div>
      ) : null}

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
            {th("coverage_flag", "Sample")}
            {th("tier", "Tier")}
            {th("mint_cap", "Mint", true)}
            {th("still_in_packs", "In packs", true)}
            {th("rip_pct", "Rip %", true)}
            {th("sealed_fmv_exposure_usd", "Sealed $", true)}
            {th("serial_low_ask_usd", "Ask", true)}
            {th("fmv_usd", "FMV", true)}
          </tr></thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={10} className="psq-par">No editions match.</td></tr>
            ) : visible.map((r) => (
              <tr key={(r.player_name || "") + (r.set_name || "") + r.mint_cap}>
                <td><span className="psq-nm">{r.player_name || "—"}</span>{r.is_rookie ? <span className="psq-rc">RC</span> : null}</td>
                <td className="psq-par">{r.set_name || "—"}</td>
                <td>
                  {r.coverage_flag && BANDS[r.coverage_flag] ? (
                    <span className={"psq-band " + BANDS[r.coverage_flag].cls} title={BANDS[r.coverage_flag].hint}>
                      {BANDS[r.coverage_flag].label}
                    </span>
                  ) : (
                    <span className="psq-par">—</span>
                  )}
                </td>
                <td><span className="psq-tier">{(r.tier || "—").toUpperCase()}</span></td>
                <td className="n">/{num(r.mint_cap)}</td>
                <td className={"n" + (Number(r.still_in_packs) > 0 ? " psq-seal" : "")}>{num(r.still_in_packs)}</td>
                <td className="n">{num(r.rip_pct, 1)}%</td>
                <td className="n psq-exp">{usd(r.sealed_fmv_exposure_usd)}</td>
                <td className="n">{usd(r.serial_low_ask_usd)}</td>
                {/* FMV + basis. 727 editions on this board are priced at 0.90 x a single
                    seller's ask because the card has never traded -- the top row by FMV was
                    one of them. Rendering that in the same typeface as a sale-derived price
                    is the overclaim this marker removes. Plain words only, never the
                    confidence enum. (2026-08-01) */}
                <td className="n">
                  <b>{usd(r.fmv_usd)}</b>
                  {basisFor(r)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* KPIs above are whole-board totals; this table is the top slice. Without saying so,
          a reader sees "Editions 1,833" over 300 rows and reasonably assumes the table is
          the whole set. */}
      <div className="psq-note">
        {matched > visible.length ? (
          <>
            Showing <b>{num(visible.length)}</b> of <b>{num(matched)}</b> matching editions
            {" "}(highest {sortK === "fmv_usd" && !asc ? "FMV" : "sort value"} first).
          </>
        ) : (
          <>
            Showing all <b>{num(matched)}</b> matching editions.
          </>
        )}
        {totals?.editions == null ? null : hc ? (
          // The KPIs are no longer whole-board once the honest split is live — saying they are
          // would be the exact overclaim this change exists to remove.
          <>
            {" "}Filters and this table run across all <b>{num(totals.editions)}</b> indexed editions; the headline
            totals above cover the <b>{num(totals.editions_hc)}</b> in lower-bias sets.
          </>
        ) : (
          <> Filters and the totals above run across all <b>{num(totals.editions)}</b> indexed editions.</>
        )}
      </div>
    </div>
  );
}
