"use client";

export default function EmptyState({
  icon = "⚡",
  title,
  subtitle,
}: {
  icon?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div
      style={{
        padding: "80px 0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        textAlign: "center",
      }}
    >
      <span style={{ fontSize: 40, opacity: 0.3 }}>{icon}</span>
      <p
        className="rpc-heading"
        style={{ fontSize: "var(--text-lg)" }}
      >
        {title}
      </p>
      {subtitle && (
        <p
          className="rpc-mono"
          style={{
            color: "var(--rpc-text-muted)",
            maxWidth: 400,
          }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}
