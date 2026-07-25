import type { SniperDeal } from "@/lib/sniper/types";
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph";
import {
  serialSignalTag,
  shouldRenderSerialBadge,
  serialBadgeLabel,
} from "@/lib/sniper-serial-badge";

// Serial-multiplier / special-serial pill for a sniper deal. Extracted verbatim
// in the Phase 1 refactor of the sniper page.
// 2026-07-11: special-serial deals now lead with the RPC badge glyph
// (medal / jersey / bullseye) matching the edition/moment pages.
// 2026-07-25: pure visibility/tag/label logic lifted to lib/sniper-serial-badge
// so it lands under the vitest coverage include (components/** is not measured).

export function SerialBadge({ deal, collection = null }: { deal: SniperDeal; collection?: string | null }) {
  if (!shouldRenderSerialBadge(deal)) return null;
  const tag = deal.isSpecialSerial ? serialSignalTag(deal.serialSignal) : null;
  return (
    <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.15)", borderColor: "rgba(168,85,247,0.3)", color: "#c084fc", display: "inline-flex", alignItems: "center", gap: 4 }}>
      {tag ? <SpecialSerialGlyph tag={tag} size={12} collection={collection} /> : null}
      {serialBadgeLabel(deal)}
    </span>
  );
}
