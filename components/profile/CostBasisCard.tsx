"use client";

import { useState, useEffect } from "react";
import { monoFont, condensedFont, labelStyle, fmtDollars, CostBasisSummary } from "./_shared";

export default function CostBasisCard(props: { ownerKey: string }) {
  const [data, setData] = useState<CostBasisSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    setErrored(false);
    fetch("/api/profile/cost-basis-summary?ownerKey=" + encodeURIComponent(props.ownerKey))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d && typeof d.totalSpent === "number") setData(d); else setErrored(true); })
      .catch(function() { setErrored(true); })
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  const plPositive = (data?.netPL ?? 0) >= 0;
  const plColor = plPositive ? "#34D399" : "#F87171";
  const plSign = plPositive ? "+" : "−";

  return (
    <section className="rpc-card" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={labelStyle}>◈ Cost Basis · P/L</span>
        {data && data.totalPurchases > 0 && (
          <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)" }}>{data.totalPurchases + " purchases"}</span>
        )}
      </div>
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[80, 60, 70].map(function(w, i) { return <div key={i} style={{ width: w + "%", height: 18, background: "rgba(255,255,255,0.04)", borderRadius: 4, animation: "pulse 1.6s ease-in-out infinite" }} />; })}
        </div>
      ) : errored || !data ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", padding: "6px 0" }}>Cost basis unavailable.</div>
      ) : data.totalSpent === 0 ? (
        <div>
          <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 18, color: "#fff", marginBottom: 6 }}>No purchase data yet</div>
          <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", lineHeight: 1.6 }}>Cost basis builds as you use the collection page — load any wallet to start tracking your buys.</div>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 4 }}>Total Spent</div>
              <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, color: "#fff", lineHeight: 1.1 }}>{fmtDollars(data.totalSpent)}</div>
            </div>
            <div>
              <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 4 }}>Current FMV</div>
              <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, color: "#fff", lineHeight: 1.1 }}>{fmtDollars(data.totalFmv)}</div>
            </div>
          </div>
          <div style={{ paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 4 }}>Net P/L</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 22, color: plColor, lineHeight: 1.1 }}>{plSign + fmtDollars(Math.abs(data.netPL))}</div>
              {data.plPercent != null && (
                <div style={{ fontSize: 12, fontFamily: monoFont, color: plColor, fontWeight: 700 }}>{plSign + Math.abs(data.plPercent).toFixed(1) + "%"}</div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
