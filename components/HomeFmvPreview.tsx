"use client";

import { useEffect, useState } from "react";

// Live FMV preview card for the marketing home's depth fold. Fetches the
// PUBLIC /api/fmv/demo endpoint (real recent snapshots, 1h CDN cache, no auth)
// and renders a genuine sample — FMV, confidence, and the serial-premium
// examples the demo computes. Replaces the old hardcoded $148 / "↑12.4% 7D" /
// fabricated p10·p50·p90 mock, which claimed "LIVE" while showing invented
// numbers. Falls back to a clearly-labelled SAMPLE card if the fetch fails or
// the pipeline has no data yet — never blocks render. (2026-05-31, handoff B3.)

interface DemoSample {
  edition: string;
  fmv: number;
  confidence: string;
  exampleAdjustments?: {
    serial1?: { adjustedFmv: number };
    serial23?: { adjustedFmv: number };
  };
}

function confColor(c: string): string {
  const v = c.toLowerCase();
  if (v === "high") return "var(--rpc-success)";
  if (v === "medium" || v === "med") return "#E0A82F";
  return "var(--rpc-text-muted)";
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function HomeFmvPreview() {
  const [sample, setSample] = useState<DemoSample | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/fmv/demo");
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const first = Array.isArray(data?.samples) ? data.samples[0] : null;
        if (!first || typeof first.fmv !== "number") throw new Error("no sample");
        if (alive) setSample(first as DemoSample);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const live = sample !== null;
  const edition = sample?.edition ?? "84:2892";
  const fmv = sample?.fmv ?? 148.0;
  const confidence = (sample?.confidence ?? "medium").toUpperCase();
  const s1 = sample?.exampleAdjustments?.serial1?.adjustedFmv ?? fmv * 12;
  const s23 = sample?.exampleAdjustments?.serial23?.adjustedFmv ?? fmv * 2.8;

  return (
    <div
      style={{
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
        borderRadius: "var(--radius-md)",
        padding: "20px 18px",
        minHeight: 360,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.18em",
          color: "var(--rpc-text-muted)",
          textTransform: "uppercase",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: live ? "var(--rpc-success)" : "var(--rpc-text-ghost)",
            boxShadow: live ? "0 0 8px var(--rpc-success)" : "none",
          }}
        />
        {live ? "LIVE FMV PREVIEW" : failed ? "SAMPLE FMV CARD" : "LOADING FMV…"}
      </div>
      <div
        style={{
          flex: 1,
          borderRadius: "var(--radius-sm)",
          background:
            "repeating-linear-gradient(0deg,transparent 0,transparent 23px,rgba(255,255,255,0.04) 23px,rgba(255,255,255,0.04) 24px),repeating-linear-gradient(90deg,transparent 0,transparent 23px,rgba(255,255,255,0.04) 23px,rgba(255,255,255,0.04) 24px)",
          border: "1px solid var(--rpc-border)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 12,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--rpc-text-muted)",
        }}
      >
        <div>
          <div style={{ color: "var(--rpc-text-secondary)" }}>EDITION {edition}</div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 28,
              fontWeight: 800,
              color: "var(--rpc-text-primary)",
              lineHeight: 1.1,
            }}
          >
            {money(fmv)}
          </div>
          <div style={{ color: confColor(confidence), letterSpacing: "0.06em" }}>
            {confidence} confidence
          </div>
        </div>
        {/* Serial-premium examples — the demo computes these from the real FMV. */}
        <div>
          <div style={{ color: "var(--rpc-text-ghost)", fontSize: 9, letterSpacing: "0.14em", marginBottom: 6 }}>
            SERIAL-ADJUSTED FMV
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            <div>
              <div style={{ color: "var(--rpc-text-ghost)" }}>BASE</div>
              <div style={{ color: "var(--rpc-text-secondary)" }}>{money(fmv)}</div>
            </div>
            <div>
              <div style={{ color: "var(--rpc-text-ghost)" }}>#1 · 12×</div>
              <div style={{ color: "var(--rpc-text-secondary)" }}>{money(s1)}</div>
            </div>
            <div>
              <div style={{ color: "var(--rpc-text-ghost)" }}>#23 · 2.8×</div>
              <div style={{ color: "var(--rpc-text-secondary)" }}>{money(s23)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
