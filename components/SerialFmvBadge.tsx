// Compact, additive "estimated #1 / perfect-mint premium" badge.
//
// Renders nothing unless `data` is present — and the backing RPCs only emit it
// for #1 / perfect-mint serials on a HIGH/MEDIUM-base edition, so this is
// already a tiny, high-signal subset. It is a GUIDE (median abs error ~45% on
// #1s), never a quote, and is floored at the edition FMV server-side. It must
// always sit BESIDE the edition FMV, never replace or sit above it.
//
// Self-contained inline styles so it drops into any surface (collection grid,
// trophy picker, sniper deals) regardless of that surface's class system.

export type SerialFmvData = {
  estimate_usd: number;
  multiplier: number;
  serial_bucket: "first" | "perfect";
  label?: string;
  basis?: string;
  sample_size?: number;
} | null | undefined;

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}

export default function SerialFmvBadge({ data }: { data: SerialFmvData }) {
  if (!data || !Number.isFinite(data.estimate_usd)) return null;
  const tag = data.serial_bucket === "first" ? "#1 est" : "perfect est";
  const mult = Number.isFinite(data.multiplier) ? data.multiplier : null;
  const title =
    (data.label ?? "estimated serial premium") +
    (mult != null ? ` — ${mult}× the edition FMV` : "") +
    ". Estimate, not a quote.";
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
      {/* hollow ring = estimate/guide, not a sales-backed quote */}
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          border: "1px solid var(--rpc-text-muted)",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      ≈ {fmtUsd(data.estimate_usd)} {tag}
    </span>
  );
}
