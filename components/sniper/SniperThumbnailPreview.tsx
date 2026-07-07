"use client";
import { useState, useRef, type ReactNode } from "react";
import { proxyIpfsUrl } from "@/lib/ipfs-media";

// Hover-to-enlarge thumbnail wrapper for the sniper deal table/cards.
// Extracted verbatim in the Phase 1 refactor of the sniper page.
export function SniperThumbnailPreview({ thumbUrl, playerName, tierColor, backgroundColor, children }: { thumbUrl: string | null; playerName: string; tierColor: string; backgroundColor?: string; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const previewUrl = thumbUrl ? proxyIpfsUrl(thumbUrl.replace(/width=\d+/, "width=400")) : null;
  function onEnter() {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 240, r.right + 12);
    const y = Math.max(12, r.top - 40);
    setPos({ x, y });
    setHovered(true);
  }
  return (
    <div ref={ref} onMouseEnter={onEnter} onMouseLeave={() => setHovered(false)} style={{ display: "inline-block", backgroundColor, borderRadius: backgroundColor ? 4 : undefined }}>
      {children}
      {hovered && previewUrl && pos && (
        <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 500, pointerEvents: "none", background: "var(--rpc-surface)", border: `2px solid ${tierColor}`, borderRadius: 6, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
          <img src={previewUrl} alt={playerName} width={200} height={200} style={{ width: 200, height: 200, objectFit: "contain", display: "block" }} />
          <div style={{ color: "var(--rpc-text-primary)", fontSize: 11, marginTop: 4, textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{playerName}</div>
        </div>
      )}
    </div>
  );
}
