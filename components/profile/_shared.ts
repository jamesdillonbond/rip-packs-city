// Shared style tokens, small helpers, and interfaces used by extracted profile components.
// Implementations copied verbatim from app/profile/page.tsx.
import type React from "react";

export const monoFont = "var(--font-mono)";
export const condensedFont = "var(--font-display)";

export const labelStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)" as any,
  fontFamily: monoFont,
  letterSpacing: "0.2em",
  color: "var(--rpc-text-muted)",
  textTransform: "uppercase",
};

export const btnBase: React.CSSProperties = {
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-sm)" as any,
  padding: "4px 10px",
  color: "var(--rpc-text-secondary)",
  fontFamily: condensedFont,
  fontWeight: 700,
  fontSize: 10,
  letterSpacing: "0.08em",
  cursor: "pointer",
  textTransform: "uppercase",
  transition: "all var(--transition-fast)",
};

export function fmtDollars(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return (d.getMonth() + 1) + "/" + d.getDate();
}

export const TIER_COLORS: Record<string, string> = {
  Common: "#9CA3AF",
  Fandom: "#60A5FA",
  Rare: "#3B82F6",
  Legendary: "#F59E0B",
  Ultimate: "#E03A2F",
};

// ─── Interfaces ──────────────────────────────────────────────
export interface TrophyMoment {
  id?: number;
  slot: number;
  moment_id: string;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  circulation_count: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  fmv: number | null;
  badges: string[] | null;
}

export interface PortfolioSnapshot {
  snapshot_date: string;
  total_fmv: number;
  moment_count: number;
  wallet_count: number;
}

export interface CostBasisSummary {
  totalSpent: number;
  totalPurchases: number;
  totalFmv: number;
  netPL: number;
  plPercent: number | null;
}

export interface TierBreakdown {
  tiers: { tier: string; count: number }[];
  total: number;
}

export interface MoverRow {
  edition_id: string;
  player_name: string | null;
  set_name: string | null;
  current_fmv: number | null;
  past_fmv: number | null;
  delta: number;
  pct_change: number | null;
}

export interface TopMoversData {
  gainers: MoverRow[];
  losers: MoverRow[];
}
