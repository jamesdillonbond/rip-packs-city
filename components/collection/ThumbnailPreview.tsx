"use client"

import { useRef, useState } from "react"

// Hover-to-enlarge thumbnail wrapper for the wallet-collection table.
// Extracted verbatim from the collection page in the Phase 1 refactor.
export default function ThumbnailPreview({ thumbUrl, playerName, tierColor, children }: { thumbUrl: string | null; playerName: string; tierColor: string; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const previewUrl = thumbUrl ? thumbUrl.replace(/width=\d+/, "width=400") : null

  function onEnter() {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const x = Math.min(window.innerWidth - 240, r.right + 12)
    const y = Math.max(12, r.top - 40)
    setPos({ x, y })
    setHovered(true)
  }
  function onLeave() { setHovered(false) }

  return (
    <div ref={ref} onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ display: "inline-block" }}>
      {children}
      {hovered && previewUrl && pos && (
        <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 500, pointerEvents: "none", background: "var(--rpc-surface)", border: `2px solid ${tierColor}`, borderRadius: 6, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
          <img src={previewUrl} alt={playerName} width={200} height={200} style={{ width: 200, height: 200, objectFit: "contain", display: "block" }} />
          <div style={{ color: "var(--rpc-text-primary)", fontSize: 11, marginTop: 4, textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{playerName}</div>
        </div>
      )}
    </div>
  )
}
