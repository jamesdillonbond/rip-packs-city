"use client";

import { useState, useEffect, useMemo } from "react";
import { monoFont, condensedFont, fmtDollars, fmtDate, PortfolioSnapshot } from "./_shared";

export default function PortfolioSparkline(props: { ownerKey: string; currentFmv: number; onChange?: (pct: number | null) => void; lineColor?: string }) {
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(function() {
    if (!props.ownerKey) return;
    setLoading(true);
    fetch("/api/profile/portfolio-history?ownerKey=" + encodeURIComponent(props.ownerKey) + "&days=30")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d?.snapshots) setSnapshots(d.snapshots); })
      .catch(function() {})
      .finally(function() { setLoading(false); });
  }, [props.ownerKey]);

  const points = useMemo(function() {
    const today = new Date().toISOString().split("T")[0];
    const historical = snapshots.filter(function(s) { return s.snapshot_date !== today; });
    const liveToday: PortfolioSnapshot = { snapshot_date: today, total_fmv: props.currentFmv, moment_count: 0, wallet_count: 0 };
    return [...historical, liveToday].filter(function(s) { return s.total_fmv > 0; });
  }, [snapshots, props.currentFmv]);

  const isEmpty = !loading && points.length < 2;
  const minVal = points.length ? Math.min(...points.map(function(p) { return p.total_fmv; })) : 0;
  const maxVal = points.length ? Math.max(...points.map(function(p) { return p.total_fmv; })) : 0;
  const range = maxVal - minVal || 1;
  const change = points.length >= 2 ? points[points.length - 1].total_fmv - points[0].total_fmv : 0;
  const changePct = points.length >= 2 && points[0].total_fmv > 0 ? (change / points[0].total_fmv) * 100 : 0;

  useEffect(function() {
    if (!props.onChange) return;
    if (points.length >= 2) props.onChange(changePct);
    else props.onChange(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changePct, points.length]);
  const changeColor = props.lineColor ?? (change >= 0 ? "var(--rpc-success)" : "var(--rpc-danger)");
  const changeSign = change >= 0 ? "+" : "";
  const W = 360; const H = 56; const PAD = 4;

  const svgPath = useMemo(function() {
    if (points.length < 2) return "";
    return "M " + points.map(function(p, i) {
      const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
      const y = PAD + ((maxVal - p.total_fmv) / range) * (H - PAD * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" L ");
  }, [points, maxVal, range]);

  const areaPath = svgPath ? svgPath + " L " + (W - PAD).toFixed(1) + "," + (H - PAD).toFixed(1) + " L " + PAD.toFixed(1) + "," + (H - PAD).toFixed(1) + " Z" : "";

  return (
    <section className="rpc-card" style={{ borderRadius: "var(--radius-lg)" as any, padding: "14px 18px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span className="rpc-label">◈ Portfolio Value · 30d</span>
        {points.length >= 2 && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>30D CHANGE</div>
            <div style={{ fontSize: 13, fontFamily: condensedFont, fontWeight: 800, color: changeColor }}>{changeSign + fmtDollars(Math.abs(change)) + " (" + changeSign + changePct.toFixed(1) + "%)"}</div>
          </div>
        )}
      </div>
      {loading ? (
        <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>Loading…</span>
        </div>
      ) : isEmpty ? (
        <div style={{ height: 60, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", lineHeight: 1.7 }}>
            Sparkline builds as you load wallets. Load any saved wallet to record today's data point.
          </div>
          <svg width={W} height={H} viewBox={"0 0 " + W + " " + H} style={{ opacity: 0.15, flexShrink: 0 }}>
            <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="#E03A2F" strokeWidth="1.5" strokeDasharray="4 4" />
          </svg>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: H, flexShrink: 0, paddingTop: PAD, paddingBottom: PAD }}>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "right" }}>{fmtDollars(maxVal)}</div>
            <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.25)", textAlign: "right" }}>{fmtDollars(minVal)}</div>
          </div>
          <div style={{ flex: 1, position: "relative" }}>
            <svg width="100%" viewBox={"0 0 " + W + " " + H} style={{ display: "block", overflow: "visible" }} preserveAspectRatio="none">
              <defs>
                <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={changeColor} stopOpacity="0.25" />
                  <stop offset="100%" stopColor={changeColor} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={areaPath} fill="url(#sparkGrad)" />
              <path d={svgPath} fill="none" stroke={changeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              {points.length > 0 && (function() {
                const last = points[points.length - 1];
                const x = PAD + ((points.length - 1) / (points.length - 1)) * (W - PAD * 2);
                const y = PAD + ((maxVal - last.total_fmv) / range) * (H - PAD * 2);
                return <circle cx={x} cy={y} r="3" fill={changeColor} />;
              })()}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>{fmtDate(points[0].snapshot_date)}</span>
              {points.length > 2 && <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>{fmtDate(points[Math.floor(points.length / 2)].snapshot_date)}</span>}
              <span style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)" }}>Today</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
