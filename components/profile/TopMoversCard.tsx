"use client";

import { useState, useEffect } from "react";
import { monoFont, condensedFont, labelStyle, fmtDollars, MoverRow, TopMoversData } from "./_shared";

export default function TopMoversCard(props: { ownerKey: string }) {
  const [data, setData] = useState<TopMoversData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    fetch("/api/profile/top-movers?ownerKey=" + encodeURIComponent(props.ownerKey) + "&days=7")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d) setData({ gainers: d.gainers ?? [], losers: d.losers ?? [] }); })
      .catch(function() {})
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  const empty = !loading && (!data || (data.gainers.length === 0 && data.losers.length === 0));

  function MoverRowDisplay(props: { row: MoverRow; positive: boolean }) {
    const r = props.row;
    const color = props.positive ? "#34D399" : "#F87171";
    const sign = props.positive ? "+" : "−";
    const fmv = Number(r.current_fmv ?? 0);
    const delta = Math.abs(Number(r.delta ?? 0));
    const pct = r.pct_change != null ? Math.abs(Number(r.pct_change)).toFixed(1) : null;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.player_name ?? "Unknown"}</div>
          <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.set_name ?? ""}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, color: "#fff" }}>{fmtDollars(fmv)}</div>
          <div style={{ fontSize: 9, fontFamily: monoFont, color: color, fontWeight: 700 }}>
            {sign + fmtDollars(delta) + (pct != null ? " · " + sign + pct + "%" : "")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="rpc-card" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={labelStyle}>📊 Top Movers · 7d</span>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)" }}>FMV deltas across owned editions</span>
      </div>
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[90, 80, 70, 60].map(function(w, i) { return <div key={i} style={{ width: w + "%", height: 14, background: "rgba(255,255,255,0.04)", borderRadius: 4, animation: "pulse 1.6s ease-in-out infinite" }} />; })}
        </div>
      ) : empty ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", padding: "6px 0", lineHeight: 1.6 }}>FMV history building — check back in a few days.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div>
            <div style={{ fontSize: 9, fontFamily: monoFont, color: "#34D399", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 6, fontWeight: 700 }}>↑ Biggest Gainers</div>
            {data && data.gainers.length > 0 ? data.gainers.map(function(g) { return <MoverRowDisplay key={g.edition_id} row={g} positive={true} />; }) : (
              <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", padding: "8px 0" }}>No gainers in window.</div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 9, fontFamily: monoFont, color: "#F87171", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 6, fontWeight: 700 }}>↓ Biggest Losers</div>
            {data && data.losers.length > 0 ? data.losers.map(function(l) { return <MoverRowDisplay key={l.edition_id} row={l} positive={false} />; }) : (
              <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", padding: "8px 0" }}>No losers in window.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
