// Confidence + last-sale-staleness pill for a sniper deal. Extracted verbatim
// in the Phase 1 refactor of the sniper page.
export function ConfidenceDot({
  confidence,
  source,
  daysSinceSale,
}: {
  confidence: string;
  source?: string;
  daysSinceSale?: number | null;
}) {
  const isFallback = source === "ask_fallback" || !source;
  const isLivetoken = source === "livetoken";
  const level = isFallback
    ? "speculative"
    : confidence === "high"
    ? "verified"
    : confidence === "medium" || isLivetoken
    ? "estimated"
    : "speculative";

  const cfg = {
    verified:    { dot: "bg-emerald-400", label: "Verified",  tip: "FMV backed by real sales data" },
    estimated:   { dot: "bg-yellow-400",  label: "Est.",      tip: "FMV estimated from limited/LiveToken data" },
    speculative: { dot: "bg-red-400/70",  label: "Spec.",     tip: "No sales data — FMV = ask price fallback" },
  }[level];

  const staleLabel =
    daysSinceSale === null || daysSinceSale === undefined ? null
    : daysSinceSale === 0 ? "today"
    : daysSinceSale === 1 ? "1d ago"
    : `${daysSinceSale}d ago`;

  const staleColor =
    daysSinceSale === null || daysSinceSale === undefined ? "var(--rpc-text-ghost)"
    : daysSinceSale <= 3 ? "var(--rpc-success)"
    : daysSinceSale <= 14 ? "var(--rpc-warning)"
    : "var(--rpc-danger)";

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className="inline-flex items-center gap-1 cursor-help"
        style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", letterSpacing: "0.1em", color: "var(--rpc-text-muted)" }}
        title={cfg.tip}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        {cfg.label}
      </span>
      {staleLabel && (
        <span style={{ fontSize: "var(--text-xs)", color: staleColor }} title={`Last sale ${staleLabel}`}>
          {staleLabel}
        </span>
      )}
    </div>
  );
}
