"use client";

import { useEffect } from "react";
import { getOwnerKey } from "@/lib/owner-key";

const TEN_MINUTES_MS = 10 * 60 * 1000;

type CachedOwned = { ids: string[]; editions: string[]; cachedAt: number };

export default function WalletPreloader() {
  useEffect(() => {
    (async () => {
      try {
        const ownerKey = getOwnerKey();
        if (!ownerKey) return;

        // Preloader only handles resolved 0x addresses. Username keys are
        // resolved to 0x by the collection page, which then writes the 0x
        // value back into rpc_owner_key.
        if (!ownerKey.startsWith("0x")) return;

        // Cache hit: skip the network call if the cache is fresh AND
        // contains the editions field (older shapes are treated as stale).
        const cachedRaw = localStorage.getItem(`rpc_owned_${ownerKey}`);
        if (cachedRaw) {
          try {
            const parsed = JSON.parse(cachedRaw) as Partial<CachedOwned>;
            if (
              parsed &&
              Array.isArray(parsed.editions) &&
              typeof parsed.cachedAt === "number" &&
              Date.now() - parsed.cachedAt < TEN_MINUTES_MS
            ) {
              return;
            }
          } catch {
            // fall through to fetch
          }
        }

        const res = await fetch(`/api/owned-flow-ids?wallet=${encodeURIComponent(ownerKey)}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          console.warn(`[preloader] /api/owned-flow-ids returned ${res.status}`);
          return;
        }

        const json = await res.json();
        const ids: string[] = Array.isArray(json?.ids) ? json.ids.map((x: unknown) => String(x)) : [];
        const editions: string[] = Array.isArray(json?.editions)
          ? json.editions.map((x: unknown) => String(x))
          : [];

        const payload: CachedOwned = { ids, editions, cachedAt: Date.now() };
        localStorage.setItem(`rpc_owned_${ownerKey}`, JSON.stringify(payload));

        console.log(`[preloader] loaded ${ids.length} owned moments / ${editions.length} editions for ${ownerKey}`);
      } catch (err) {
        console.warn("[preloader] failed:", err);
      }
    })();
  }, []);

  return null;
}
