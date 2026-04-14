"use client";

import { useState, useEffect } from "react";
import { monoFont } from "./_shared";

export default function StatTile(props: { label: string; value: string; sub: string; change: string; up: boolean; icon: string; color: string; delay: number }) {
  const [vis, setVis] = useState(false);
  useEffect(function() { const t = setTimeout(function() { setVis(true); }, props.delay); return function() { clearTimeout(t); }; }, [props.delay]);
  return (
    <div className="rpc-card" style={{ padding: "16px 18px", position: "relative", overflow: "hidden", opacity: vis ? 1 : 0, transform: vis ? "translateY(0)" : "translateY(10px)", transition: "opacity 0.35s, transform 0.35s" }}>
      <div className="rpc-tier-stripe" style={{ background: props.color }} />
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span className="rpc-label">{props.label}</span>
        <span style={{ fontSize: 16, opacity: 0.5 }}>{props.icon}</span>
      </div>
      <div className="rpc-heading" style={{ fontSize: "var(--text-2xl)" as any, marginBottom: 6 }}>{props.value}</div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 9, fontFamily: monoFont, color: "var(--rpc-text-muted)" }}>{props.sub}</span>
        <span style={{ fontSize: 10, fontFamily: monoFont, color: props.up ? "var(--rpc-success)" : "var(--rpc-danger)", fontWeight: 700 }}>{props.change}</span>
      </div>
    </div>
  );
}
