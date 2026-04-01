"use client";

export default function LoadingState({ lines = 5 }: { lines?: number }) {
  const widths = [100, 85, 70, 55, 40, 30, 60, 75, 50, 65];
  return (
    <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="rpc-skeleton"
          style={{
            width: `${widths[i % widths.length]}%`,
            maxWidth: 600,
            height: 14,
            opacity: 1 - i * (0.6 / lines),
          }}
        />
      ))}
      <p
        className="rpc-label"
        style={{ marginTop: 16, letterSpacing: "0.2em" }}
      >
        SCANNING THE MARKETPLACE&hellip;
      </p>
    </div>
  );
}
