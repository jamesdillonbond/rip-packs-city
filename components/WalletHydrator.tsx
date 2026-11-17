"use client";

import { useEffect } from "react";
import { signedInOnce } from "@/lib/auth/signed-in-client";

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

    if (!ownerKey) return;

    const now = Date.now();
    const last = lastHydrated ? Number(lastHydrated) : 0;
    // Only apply the TTL guard when we already have a wallet address cached.
    // Pre-rewrite users have rpc_owner_key but no rpc_wallet_address — they
    // need to hit /api/wallet/profile once to backfill the localStorage key.
    if (walletAddress && last && now - last < HYDRATION_TTL_MS) return;

    (async () => {
      try {
        // /api/wallet/profile is session-gated (owner-key-guard): for a signed-OUT
        // visitor it can only 401. Skip on a definite "signed out"; an unknown
        // identity read still tries (2026-10-18, lib/auth/signed-in-client.ts).
        if ((await signedInOnce()) === false) return;
        const res = await fetch(
          `/api/wallet/profile?ownerKey=${encodeURIComponent(ownerKey!)}`
        );
        if (res.ok) {
          const data = await res.json().catch(() => null);
          const serverWallet = data?.wallet_address;
          if (typeof serverWallet === "string" && serverWallet) {
            try {
              localStorage.setItem("rpc_wallet_address", serverWallet);
            } catch { /* ignore */ }
          }
        }
      } catch { /* silent */ }
    })();

    try {
      localStorage.setItem("rpc_last_hydrated", now.toString());
    } catch { /* ignore */ }
  }, []);

  return null;
}
