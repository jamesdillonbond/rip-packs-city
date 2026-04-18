"use client";

import { useEffect } from "react";

const HYDRATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Background wallet session hydration.
 *
 * Runs once on mount on collection pages. If the visitor has a saved
 * owner key + wallet address in localStorage and the last hydration
 * touch was > 30 minutes ago, fire a silent GET /api/wallet/profile
 * to keep their wallet session warm and bump last_active_at server-side.
 *
 * Returns null — no rendered output.
 */
export default function WalletHydrator() {
  useEffect(() => {
    let ownerKey: string | null = null;
    let walletAddress: string | null = null;
    let lastHydrated: string | null = null;

    try {
      ownerKey = localStorage.getItem("rpc_owner_key");
      walletAddress = localStorage.getItem("rpc_wallet_address");
      lastHydrated = localStorage.getItem("rpc_last_hydrated");
    } catch {
      return;
    }

    if (!ownerKey || !walletAddress) return;

    const now = Date.now();
    const last = lastHydrated ? Number(lastHydrated) : 0;
    if (last && now - last < HYDRATION_TTL_MS) return;

    fetch(`/api/wallet/profile?ownerKey=${encodeURIComponent(ownerKey)}`)
      .catch(() => { /* silent */ });

    try {
      localStorage.setItem("rpc_last_hydrated", now.toString());
    } catch { /* ignore */ }
  }, []);

  return null;
}
