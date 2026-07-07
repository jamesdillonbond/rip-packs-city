"use client";

// Presentational stats bar for the collection sniper page. Behavior-preserving
// verbatim extraction — renders the deal/hot/badge/special/avg-discount summary
// row. Pure display; all values are computed in the page and passed in.
import { fmt } from "@/lib/sniper/helpers";

export default function SniperStatsBar(props: {
  stats: { total: number; hot: number; badge: number; special: number; avgDiscount: number };
  isPinnacle: boolean;
  isAllDay: boolean;
  ownedCount: number;
  lastRefreshed: string | null | undefined;
}) {
  const { stats, isPinnacle, isAllDay, ownedCount, lastRefreshed } = props;
  return (
    <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface-raised)", padding: "8px 16px" }}>
      <div className="rpc-mono flex items-center gap-6 flex-wrap" style={{ maxWidth: "var(--max-width)", margin: "0 auto", color: "var(--rpc-text-muted)" }}>
        <span><span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{stats.total}</span> deals</span>
        <span><span style={{ color: "var(--rpc-danger)", fontWeight: 600 }}>{stats.hot}</span> hot (40%+)</span>
        {!isPinnacle && !isAllDay && stats.badge > 0 && (
          <span><span style={{ color: "var(--tier-legendary)", fontWeight: 600 }}>{stats.badge}</span> badged</span>
        )}
        {!isAllDay && stats.special > 0 && (
          <span><span style={{ color: "#c084fc", fontWeight: 600 }}>{stats.special}</span> special serials</span>
        )}
        <span>avg <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{fmt(stats.avgDiscount, 1)}%</span> off</span>
        {!isAllDay && ownedCount > 0 && (
          <span style={{ color: "var(--rpc-text-ghost)" }}>{ownedCount} owned editions tracked</span>
        )}
        {lastRefreshed && (
          <span className="ml-auto">
            updated {new Date(lastRefreshed).toLocaleTimeString([], {
              hour: "2-digit", minute: "2-digit", second: "2-digit",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
