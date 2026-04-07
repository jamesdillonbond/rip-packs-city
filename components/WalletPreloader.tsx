"use client";

import { useEffect } from "react";
import { getOwnerKey } from "@/lib/owner-key";

const TEN_MINUTES_MS = 10 * 60 * 1000;

export default function WalletPreloader() {
  useEffect(() => {
    (async () => {
      try {
        const ownerKey = getOwnerKey();
        if (!ownerKey) return;

        // If we already have a fresh cache for this key, skip the fetch.
        const tsRaw = localStorage.getItem(`rpc_owned_ts_${ownerKey}`);
        const cached = localStorage.getItem(`rpc_owned_${ownerKey}`);
        if (cached && tsRaw) {
          const ts = Number(tsRaw);
          if (Number.isFinite(ts) && Date.now() - ts < TEN_MINUTES_MS) {
            return;
          }
        }

        const res = await fetch("/api/wallet-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: ownerKey }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return;

        const json = await res.json();
        const rows: Array<{ flowId?: string | null }> = Array.isArray(json?.rows) ? json.rows : [];
        const flowIds: string[] = rows
          .map((r) => (r.flowId != null ? String(r.flowId) : null))
          .filter((id): id is string => !!id);

        const resolvedAddress: string =
          typeof json?.walletAddress === "string" && json.walletAddress.length > 0
            ? json.walletAddress
            : ownerKey;

        localStorage.setItem(`rpc_owned_${resolvedAddress}`, JSON.stringify(flowIds));
        localStorage.setItem(`rpc_owned_ts_${resolvedAddress}`, String(Date.now()));

        console.log(`[preloader] loaded ${flowIds.length} owned IDs for ${resolvedAddress}`);
      } catch {
        // Never crash the page on preloader failure.
      }
    })();
  }, []);

  return null;
}
