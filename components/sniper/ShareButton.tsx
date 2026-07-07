"use client";
import { useState } from "react";
import type { SniperDeal } from "@/lib/sniper/types";

// Copy-deal-link button for a sniper deal. Extracted verbatim in the Phase 1
// refactor of the sniper page.
export function ShareButton({ deal }: { deal: SniperDeal }) {
  const [copied, setCopied] = useState(false);

  function handleShare() {
    const url = window.location.origin + window.location.pathname + "?highlight=" + deal.flowId;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <button
      onClick={handleShare}
      className="rpc-chip"
      style={{ padding: "3px 8px" }}
      title="Copy deal link"
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}
