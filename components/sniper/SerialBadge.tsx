import type { SniperDeal } from "@/lib/sniper/types";

// Serial-multiplier / special-serial pill for a sniper deal. Extracted verbatim
// in the Phase 1 refactor of the sniper page.
export function SerialBadge({ deal }: { deal: SniperDeal }) {
  if (!deal.isSpecialSerial && deal.serialMult <= 1) return null;
  return (
    <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.15)", borderColor: "rgba(168,85,247,0.3)", color: "#c084fc" }}>
      {deal.serialSignal ?? `×${deal.serialMult.toFixed(1)}`}
    </span>
  );
}
