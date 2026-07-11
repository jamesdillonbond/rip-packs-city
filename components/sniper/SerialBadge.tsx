import type { SniperDeal } from "@/lib/sniper/types";
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph";

// Serial-multiplier / special-serial pill for a sniper deal. Extracted verbatim
// in the Phase 1 refactor of the sniper page.
// 2026-07-11: special-serial deals now lead with the RPC badge glyph
// (medal / jersey / bullseye) matching the edition/moment pages.

// Map the feed's serialSignal vocabulary ("#1", "Jersey #12", "Jersey Serial",
// "Last #499") onto the glyph categories.
function signalTag(signal: string | null): string | null {
  const s = (signal ?? "").toLowerCase();
  if (s.startsWith("#1")) return "#1";
  if (s.startsWith("jersey")) return "jersey";
  if (s.startsWith("last")) return "last_mint";
  return null;
}

export function SerialBadge({ deal }: { deal: SniperDeal }) {
  if (!deal.isSpecialSerial && deal.serialMult <= 1) return null;
  const tag = deal.isSpecialSerial ? signalTag(deal.serialSignal) : null;
  return (
    <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.15)", borderColor: "rgba(168,85,247,0.3)", color: "#c084fc", display: "inline-flex", alignItems: "center", gap: 4 }}>
      {tag ? <SpecialSerialGlyph tag={tag} size={11} /> : null}
      {deal.serialSignal ?? `×${deal.serialMult.toFixed(1)}`}
    </span>
  );
}
