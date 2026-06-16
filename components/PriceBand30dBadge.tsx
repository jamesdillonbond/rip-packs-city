// Compact, additive "30-day price range" badge for the collection grid / tiles.
//
// Renders nothing unless `data` is present — and the backing RPC only emits it
// for high-volume LOW/MEDIUM editions (>= 10 stored 30d sales, >= 5 surviving
// the dust + outlier clean), so this is already a tiny, high-signal subset. It
// is the cleaned 10th–90th percentile of the edition's last-30d sales (drop
// < $0.50 dust, drop > 5× survivor-median outliers) — REAL sales, not an
// estimate, which is why it carries a filled dot (vs the SerialFmvBadge's hollow
// ring). It exists to make a bare "LOW" tile read honestly: "typically $74–$130"
// instead of one stale single-sale number.
//
// Self-contained inline styles so it drops into any surface regardless of class
// system. Sits beside the edition FMV, never replaces it.

export type PriceBand30d = {
  low: number;
  high: number;
  n: number;
} | null | undefined;

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 100) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + n.toFixed(2);
}

export default function PriceBand30dBadge({ data }: { data: PriceBand30d }) {
  if (!data || !Number.isFinite(data.low) || !Number.isFinite(data.high)) return null;
  const title =
    `Typical recent range: the cleaned 10th–90th percentile of this edition's ` +
    `last-30-day sales (${data.n} sale${data.n === 1 ? "" : "s"} after dropping ` +
    `dust and outliers). Real sales, not an estimate.`;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs, 10px)",
        letterSpacing: "0.08em",
        color: "var(--rpc-text-muted)",
        whiteSpace: "nowrap",
      }}
    >
      {/* filled dot = real sales-backed range, not an estimate */}
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--rpc-text-muted)",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      {fmtUsd(data.low)}–{fmtUsd(data.high)} 30d
    </span>
  );
}
