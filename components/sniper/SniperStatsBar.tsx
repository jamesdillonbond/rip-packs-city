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
  /**
   * 2026-10-15: whether a feed read has ARRIVED. Before the first read lands the
   * page computes `stats` from an empty list, so this bar read "0 deals · avg 0.0%
   * off" for the ~30 s the Top Shot feed takes — a conclusion drawn from a read
   * that had not happened. `loading` / `failed` render no counts at all.
   * Defaults to `ok` so a caller that always has data is unchanged.
   */
  feedState?: "loading" | "failed" | "ok";
}) {
  const { stats, isPinnacle, isAllDay, ownedCount, lastRefreshed, feedState = "ok" } = props;
  if (feedState !== "ok") {
    return (
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface-raised)", padding: "8px 16px" }}>
        <div className="rpc-mono flex items-center gap-6 flex-wrap" style={{ maxWidth: "var(--max-width)", margin: "0 auto", color: "var(--rpc-text-muted)" }}>
          <span role="status">
            {feedState === "loading" ? "Loading deals…" : "Deal feed unavailable — no count to show"}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface-raised)", padding: "8px 16px" }}>
      <div className="rpc-mono flex items-center gap-6 flex-wrap" style={{ maxWidth: "var(--max-width)", margin: "0 auto", color: "var(--rpc-text-muted)" }}>
        <span><span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{stats.total}</span> deals</span>
        <span><span style={{ color: "var(--rpc-danger-text)", fontWeight: 600 }}>{stats.hot}</span> hot (40%+)</span>
        {!isPinnacle && !isAllDay && stats.badge > 0 && (
          <span><span style={{ color: "var(--tier-legendary-text)", fontWeight: 600 }}>{stats.badge}</span> badged</span>
        )}
        {!isAllDay && stats.special > 0 && (
          <span><span style={{ color: "#c084fc", fontWeight: 600 }}>{stats.special}</span> special serials</span>
        )}
        <span>avg <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{fmt(stats.avgDiscount, 1)}%</span> off</span>
        {!isAllDay && ownedCount > 0 && (
          <span style={{ color: "var(--rpc-text-muted)" }}>{ownedCount} owned editions tracked</span>
        )}
        {lastRefreshed && (
          <span className="ml-auto">
            {/* hydration-safe: `lastRefreshed` comes from SniperClient's
                useWarmCache `data?.lastRefreshed`, null at SSR, and the span is
                gated on it — nothing server-renders. Deliberately unpinned:
                a refresh clock belongs in the VIEWER's timezone. */}
            updated {new Date(lastRefreshed).toLocaleTimeString([], {
              hour: "2-digit", minute: "2-digit", second: "2-digit",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
