"use client";

// components/filters/LeagueFilter.tsx
//
// NBA / WNBA toggle for any surface that lists Top Shot moments. Three
// positions: All / NBA / WNBA. Reads `wallet_moments_cache.league` server-side
// to scope results.
//
// Visibility is controlled by the parent: pass `visible={false}` from
// non-Top-Shot collection pickers (NFL All Day / Disney Pinnacle / LaLiga
// Golazos / UFC Strike) where league is meaningless and the row would
// always be NULL.

import type { CSSProperties } from "react";

export type LeagueValue = "all" | "NBA" | "WNBA";

interface Props {
  value: LeagueValue;
  onChange: (next: LeagueValue) => void;
  visible?: boolean;
}

const OPTIONS: { key: LeagueValue; label: string }[] = [
  { key: "all", label: "All" },
  { key: "NBA", label: "NBA" },
  { key: "WNBA", label: "WNBA" },
];

const wrapStyle: CSSProperties = {
  display: "inline-flex",
  gap: 4,
  padding: 3,
  borderRadius: 6,
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
};

const baseBtnStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 4,
  padding: "5px 12px",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--rpc-text-secondary)",
  cursor: "pointer",
  transition: "background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease",
};

const activeBtnStyle: CSSProperties = {
  background: "var(--rpc-red-bg)",
  borderColor: "var(--rpc-red-border)",
  color: "var(--rpc-red)",
};

export default function LeagueFilter({ value, onChange, visible = true }: Props) {
  if (!visible) return null;
  return (
    <div role="radiogroup" aria-label="Filter by league" style={wrapStyle}>
      {OPTIONS.map((opt) => {
        const isActive = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => {
              if (!isActive) onChange(opt.key);
            }}
            style={isActive ? { ...baseBtnStyle, ...activeBtnStyle } : baseBtnStyle}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
