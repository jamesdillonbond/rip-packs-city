import type { SniperDeal } from "@/lib/sniper/types";
import { resolveViewUrl, resolveDapperUrl, trackClick } from "@/lib/sniper/helpers";

// Outbound "View Listing" / "Dapper" action buttons for a sniper deal.
// Extracted verbatim in the Phase 1 refactor of the sniper page.
export function ActionCell({
  deal,
  accent,
  collectionSlug,
}: {
  deal: SniperDeal;
  accent: string;
  collectionSlug: string;
}) {
  const viewUrl = resolveViewUrl(deal, collectionSlug);
  const dapperUrl = resolveDapperUrl(deal, collectionSlug);
  if (!viewUrl && !dapperUrl) {
    return (
      <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
        —
      </span>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-end" }}>
      {viewUrl && (
        <a
          href={viewUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackClick(deal, null)}
          className="rpc-btn-ghost"
          style={{ padding: "4px 12px", textDecoration: "none", borderColor: `${accent}40`, color: accent }}
        >
          View Listing →
        </a>
      )}
      {dapperUrl && (
        <a
          href={dapperUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackClick(deal, null)}
          className="rpc-btn-ghost"
          style={{ padding: "4px 12px", textDecoration: "none", borderColor: `${accent}40`, color: accent }}
        >
          Dapper ↗
        </a>
      )}
    </div>
  );
}
