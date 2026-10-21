"use client"

// One removable pill per active multi-select value ("Team: Portland Fire ×").
// A chip that reads "3 selected" hides WHICH three; this row shows them and
// removes one without re-opening the list. Renders nothing when nothing is picked.

export type PillGroup = {
  label: string
  values: string[]
  onRemove: (value: string) => void
  /** Display label for a value (the VALUE still round-trips). */
  format?: (v: string) => string
}

export default function ActiveFilterPills({ groups }: { groups: PillGroup[] }) {
  const pills = groups.flatMap(g => g.values.map(v => ({ g, v, text: g.format ? g.format(v) : v })))
  if (pills.length === 0) return null
  return (
    <ul aria-label="Active filters" style={{ display: "flex", flexWrap: "wrap", gap: 6, listStyle: "none", margin: 0, padding: 0 }}>
      {pills.map(({ g, v, text }) => (
        <li key={`${g.label}\u0000${v}`}>
          <button
            type="button"
            onClick={() => g.onRemove(v)}
            aria-label={`Remove ${g.label} filter: ${text}`}
            className="rpc-chip"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%",
              background: "var(--rpc-surface-hover)", color: "var(--rpc-text-primary)",
              fontSize: 11, minHeight: 32,
            }}
          >
            <span style={{ color: "var(--rpc-text-muted)" }}>{g.label}:</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
            <span aria-hidden style={{ color: "var(--rpc-text-muted)" }}>×</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
