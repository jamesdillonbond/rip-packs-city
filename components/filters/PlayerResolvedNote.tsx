"use client"

// #207: when a player search matched nothing as typed, /api/market and
// /api/sniper-feed retry it with the single catalog name it matches accent-blind
// ("luka doncic" → "Luka Dončić") and report the swap. This says so on the page —
// never a silent subject swap — and offers the spelling for the search box.

export default function PlayerResolvedNote({ resolved, onUse }: { resolved: { from: string; to: string }; onUse: (n: string) => void }) {
  return (
    <div className="rpc-card" role="status" style={{ padding: "10px 16px", marginBottom: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <span className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
        No exact match for &ldquo;{resolved.from}&rdquo; — showing <strong style={{ color: "var(--rpc-text-primary)" }}>{resolved.to}</strong>.
      </span>
      <button type="button" className="rpc-chip" onClick={() => onUse(resolved.to)} style={{ fontSize: 11 }}>
        Use this spelling
      </button>
    </div>
  )
}
