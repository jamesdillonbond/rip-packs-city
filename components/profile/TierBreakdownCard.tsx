"use client";

import { useState, useEffect } from "react";
import { monoFont, condensedFont, labelStyle, TIER_COLORS, TierBreakdown } from "./_shared";

export default function TierBreakdownCard(props: { ownerKey: string }) {
  const [data, setData] = useState<TierBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    fetch("/api/profile/tier-breakdown?ownerKey=" + encodeURIComponent(props.ownerKey))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d && Array.isArray(d.tiers)) setData(d); })
      .catch(function() {})
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  const tiers = data?.tiers ?? [];
  const total = data?.total ?? 0;

  return (
    <section className="rpc-card" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={labelStyle}>▣ Tier Breakdown</span>
        {total > 0 && <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)" }}>{total.toLocaleString() + " moments"}</span>}
      </div>
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ width: "100%", height: 14, background: "rgba(255,255,255,0.04)", borderRadius: 4, animation: "pulse 1.6s ease-in-out infinite" }} />
          {[60, 50, 40].map(function(w, i) { return <div key={i} style={{ width: w + "%", height: 12, background: "rgba(255,255,255,0.04)", borderRadius: 4, animation: "pulse 1.6s ease-in-out infinite" }} />; })}
        </div>
      ) : total === 0 ? (
        <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", padding: "6px 0", lineHeight: 1.6 }}>Load a saved wallet to see your tier mix.</div>
      ) : (
        <>
          <div style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", marginBottom: 12 }}>
            {tiers.map(function(t) {
              const pct = (t.count / total) * 100;
              const color = TIER_COLORS[t.tier] || "#6B7280";
              return <div key={t.tier} title={t.tier + " · " + t.count} style={{ width: pct + "%", background: color, transition: "width 0.6s ease" }} />;
            })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" }}>
            {tiers.map(function(t) {
              const color = TIER_COLORS[t.tier] || "#6B7280";
              const pct = ((t.count / total) * 100).toFixed(1);
              return (
                <div key={t.tier} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.55)", letterSpacing: "0.04em", flex: 1 }}>{t.tier}</span>
                  <span style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 12, color: "#fff" }}>{t.count.toLocaleString()}</span>
                  <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", minWidth: 36, textAlign: "right" }}>{pct + "%"}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
