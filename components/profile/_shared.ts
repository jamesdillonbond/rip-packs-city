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
  // Read UTC components: snapshot_date is a date-only "YYYY-MM-DD" string, which
  // Date parses as UTC midnight, so getMonth()/getDate() (local) render the day
  // BEFORE for any viewer west of UTC — every sparkline axis date was off by one.
  const d = new Date(iso);
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
}

// The old "siblings have no token" brand-exception was stale -- app/rpc-tokens.css
// carries a --tier-* token for every one of these. Migrated 2026-08-02; the sole
// consumer (TierBreakdownCard) uses them as plain background/color, no alpha
// composition. Ultimate was literally the BRAND RED, which made a tier read as
// a call-to-action.
export const TIER_COLORS: Record<string, string> = {
  Common: "var(--tier-common)",
  Fandom: "var(--tier-fandom)",
  Rare: "var(--tier-rare)",
  Legendary: "var(--tier-legendary)",
  Ultimate: "var(--tier-ultimate)",
};

// ─── Interfaces ──────────────────────────────────────────────
export interface TrophyMoment {
  id?: number;
  slot: number;
  moment_id: string;
  edition_id?: string | null;
  collection_id?: string | null;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  circulation_count: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  fmv: number | null;
  badges: string[] | null;
  note?: string | null;
  pinned_at?: string | null;
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
