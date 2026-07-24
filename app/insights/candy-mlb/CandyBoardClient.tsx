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
  confidence: string | null;
  fmv_computed_at: string | null;
  sales_24h: number | null;
  sales_7d: number | null;
  sales_all: number | null;
  last_sale_at: string | null;
  last_sale_usd: number | null;
  best_offer_usd: number | null;
  offer_bidders: number | null;
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

const usd = (x: number | null | undefined) =>
  x == null || isNaN(Number(x)) || Number(x) <= 0
    ? "—"
    : "$" + Number(x).toLocaleString(undefined, { maximumFractionDigits: Math.abs(Number(x)) < 100 ? 2 : 0 });
const num = (x: number | null | undefined, d = 0) =>
  x == null || isNaN(Number(x)) ? "—" : Number(x).toLocaleString(undefined, { maximumFractionDigits: d });

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
.cdy-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 12px}
.cdy-controls input{background:var(--rpc-surface,#1b1b20);border:1px solid var(--rpc-border,rgba(255,255,255,.12));border-radius:8px;color:var(--rpc-text-primary,#ECEAE3);padding:7px 11px;font-size:12.5px;min-width:200px}
.cdy-seg{display:flex;border:1px solid var(--rpc-border,rgba(255,255,255,.12));border-radius:8px;overflow:hidden}
.cdy-seg button{background:transparent;border:0;color:var(--rpc-text-secondary,#9A968C);padding:7px 11px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;font-weight:700}
.cdy-seg button.on{background:var(--rpc-red,#E03A2F);color:#fff}
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
.cdy-conf{font-size:9px;font-weight:800;padding:1px 4px;border-radius:3px;color:#9A968C;border:1px solid rgba(255,255,255,.14);margin-left:5px}
.cdy-note{color:var(--rpc-text-secondary,#9A968C);font-size:11.5px;margin:10px 2px 0}
.cdy-note b{color:var(--rpc-text-primary,#ECEAE3);font-weight:700}
`;

const TIERS = [
  { k: "", label: "All" },
  { k: "COMMON", label: "ICONs" },
  { k: "LEGENDARY", label: "Rainbows" },
];

export default function CandyBoardClient({
  initialRows,
  packEv = null,
  fetchedAt,
}: {
  initialRows: Row[];
  packEv?: PackEv | null;
  fetchedAt: string;
}) {
  const [sortK, setSortK] = useState<keyof Row>("fmv_usd");
  const [asc, setAsc] = useState(false);
  const [tier, setTier] = useState("");
  const [q, setQ] = useState("");

  const RENDER_CAP = 300;
  const rows = useMemo(() => {
    let r = initialRows.filter((x) => {
      if (tier && (x.tier || "").toUpperCase() !== tier) return false;
      if (q && !((x.player_name || "") + " " + (x.edition_name || "")).toLowerCase().includes(q)) return false;
      return true;
    });
    r = [...r].sort((a, b) => {
      let x: any = a[sortK], y: any = b[sortK];
      if (sortK === "player_name" || sortK === "edition_name" || sortK === "tier") {
        x = (x || "").toLowerCase(); y = (y || "").toLowerCase();
        return asc ? (x < y ? -1 : x > y ? 1 : 0) : x < y ? 1 : x > y ? -1 : 0;
      }
      x = x == null ? (asc ? Infinity : -Infinity) : Number(x);
      y = y == null ? (asc ? Infinity : -Infinity) : Number(y);
      return asc ? x - y : y - x;
    });
    return r;
  }, [initialRows, sortK, asc, tier, q]);

  const matched = rows.length;
  const visible = rows.slice(0, RENDER_CAP);

  const priced = useMemo(() => initialRows.filter((r) => r.fmv_usd != null).length, [initialRows]);
  const sales24h = useMemo(() => initialRows.reduce((s, r) => s + (Number(r.sales_24h) || 0), 0), [initialRows]);
  const withOffer = useMemo(() => initialRows.filter((r) => r.best_offer_usd != null).length, [initialRows]);

  const th = (k: keyof Row, label: string, n = false) => (
    <th className={n ? "n" : ""} onClick={() => (k === sortK ? setAsc(!asc) : (setSortK(k), setAsc(false)))}>
      {label}{k === sortK ? (asc ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <div className="cdy-wrap">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <h1 className="cdy-h1">Candy · MLB ICONs</h1>
      <div className="cdy-sub">
        2026 MLB Base Series ICONs — Candy Digital on Solana. Live secondary FMV, best offers, and pack EV.{" "}
        <FreshnessStamp iso={fetchedAt} />
      </div>

      <div className="cdy-cov">
        <b>Early read, not a census.</b> Candy&apos;s secondary market opened <b>~Jul 23</b> (Magic Eden). FMV is
        auto-computed off live sales but <b>{num(priced)}</b> of <b>{num(initialRows.length)}</b> editions have
        traded — every price is <b>LOW-confidence</b> off 1–2 sales, and un-traded editions show FMV
        &ldquo;—&rdquo;. <b>Best offer</b> is an offer-derived floor, <b>never FMV</b>. The book is thin and Drop 3
        (Jul 29) adds forward supply, so treat these as an indicative early signal.
      </div>

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
            up by the Rainbow leg, which is <b>largely unpriced ({num(packEv.rainbow_priced)}/{num(packEv.rainbow_total)})</b>{" "}
            — and you cannot liquidate {num(packEv.icon_slots)} ICONs at FMV on a market this thin. These are FMV
            estimates off 1–2 sales each; Drop 3 adds ~15,000 more commons, so the floor will move.
          </div>
        </div>
      ) : null}

      <div className="cdy-kpis">
        <div className="cdy-card"><h3>Editions</h3><div className="cdy-big">{num(initialRows.length)}</div></div>
        <div className="cdy-card"><h3>Priced (traded)</h3><div className="cdy-big">{num(priced)}</div></div>
        <div className="cdy-card"><h3>Sales · 24h</h3><div className="cdy-big">{num(sales24h)}</div></div>
        <div className="cdy-card"><h3>With a best offer</h3><div className="cdy-big">{num(withOffer)}</div></div>
      </div>

      <div className="cdy-controls">
        <input placeholder="Filter player…" value={q} onChange={(e) => setQ(e.target.value.trim().toLowerCase())} />
        <div className="cdy-seg">
          {TIERS.map((t) => (
            <button key={t.k} className={tier === t.k ? "on" : ""} onClick={() => setTier(t.k)}>{t.label}</button>
          ))}
        </div>
      </div>

      <div className="cdy-scroll">
        <table className="cdy-tbl">
          <thead><tr>
            {th("player_name", "Player")}
            {th("edition_name", "Edition")}
            {th("circulation_count", "Mint", true)}
            {th("sales_24h", "24h", true)}
            {th("sales_all", "Sales", true)}
            {th("last_sale_usd", "Last sale", true)}
            {th("best_offer_usd", "Best offer", true)}
            {th("fmv_usd", "FMV", true)}
          </tr></thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={8} className="cdy-par">No editions match.</td></tr>
            ) : visible.map((r) => (
              <tr key={r.external_id || (r.edition_name || "")}>
                <td><span className="cdy-nm">{r.player_name || "—"}</span>{r.is_rainbow ? <span className="cdy-rb">RB</span> : null}</td>
                <td className="cdy-par">{r.edition_name || "—"}</td>
                <td className="n">/{num(r.circulation_count)}</td>
                <td className="n">{num(r.sales_24h)}</td>
                <td className="n">{num(r.sales_all)}</td>
                <td className="n">{usd(r.last_sale_usd)}</td>
                <td className="n cdy-off">{usd(r.best_offer_usd)}</td>
                <td className="n">
                  <b>{usd(r.fmv_usd)}</b>
                  {r.fmv_usd != null && r.confidence ? <span className="cdy-conf">{r.confidence}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="cdy-note">
        {matched > visible.length ? (
          <>Showing <b>{num(visible.length)}</b> of <b>{num(matched)}</b> matching editions.</>
        ) : (
          <>Showing all <b>{num(matched)}</b> matching editions.</>
        )}{" "}
        FMV auto-computes from live Magic Eden sales; the cold tail with no sales shows &ldquo;—&rdquo;. Best offer
        is a standing-bid floor, never FMV.
      </div>
    </div>
  );
}
