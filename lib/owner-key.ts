// lib/owner-key.ts
// Shared utility for reading and writing the RPC profile key from localStorage.
// Used by wallet, sets, sniper, packs pages to auto-populate the signed-in user.

import { chainKindForDbChain, isValidAddressForChain } from "@/lib/address";

export const OWNER_KEY_STORAGE = "rpc_owner_key";

// ⚠ `rpc_owner_key` IS A SINGLE GLOBAL SLOT AND THAT IS A CROSS-CHAIN BUG the
// moment a second chain ships. Measured 2026-09-19, the day Candy MLB's
// Collection tab went live: the ONLY writer of this key is
// CollectionTabClient's post-search sync, and it was gated on
// `startsWith("0x")` — so a Candy wallet was never written at all, and
// `/candy-mlb/market`'s Owned/Locked column (which reads this key and was gated
// the same way) stayed empty no matter what the reader searched. ⛔ The naive
// fix — drop the `0x` gate — is WORSE than the bug: a Flow user who searches a
// Candy wallet would have their Flow key OVERWRITTEN with a base58 address, and
// every Flow surface that gates on `0x` (the sniper's owned-edition auto-load,
// Top Shot's own Owned column, the dashboard alerts key) would silently go
// blank. One global slot cannot hold two chains' identities.
//
// So the slot is CHAIN-SCOPED, and Flow keeps the historical key BYTE-FOR-BYTE:
// no migration, no re-login, and every existing reader of `getOwnerKey()` sees
// exactly what it saw before. Only a non-Cadence chain gets a new slot.
export function ownerKeyStorageFor(dbChain: string | null | undefined): string {
  const kind = chainKindForDbChain(dbChain);
  // Cadence — and any collection with no on-chain wallet concept — keeps the
  // original key. Keyed by ChainKind, not dbChain, so ethereum / polygon /
  // flow_evm share one slot: they are the same address space.
  return kind === null || kind === "cadence" ? OWNER_KEY_STORAGE : `${OWNER_KEY_STORAGE}_${kind}`;
}

// Is this stored key usable as a wallet for `dbChain`'s collections?
//
// ⛔ THE CADENCE ARM IS DELIBERATELY THE OLD, LOOSE `startsWith("0x")` AND THAT
// IS NOT AN OVERSIGHT. `isValidAddressForChain(key, "flow")` demands exactly 16
// hex digits — STRICTER than the test it would replace — so adopting it on the
// Flow path would silently stop serving owned-edition counts to any collector
// whose stored key is non-canonical, which is a FLOW REGRESSION smuggled in
// under a Solana fix. Measured 2026-09-19: three existing component tests fail
// on that tightening, which is the repo telling me the shapes differ. The new
// chains get the strict test because they have no legacy keys to protect.
//
// What this DOES add for every chain is the cross-chain refusal: a Cadence key
// can never be handed to a Solana collection's reads, or the reverse. That is
// the property that matters — a cross-chain wallet query does not error, it
// returns nothing, and nothing renders as a confident zero.
export function ownerKeyMatchesChain(key: string, dbChain: string | null | undefined): boolean {
  if (!key) return false;
  const kind = chainKindForDbChain(dbChain);
  if (kind === null || kind === "cadence") return key.startsWith("0x");
  return isValidAddressForChain(key, dbChain);
}

export function getOwnerKeyForChain(dbChain: string | null | undefined): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(ownerKeyStorageFor(dbChain)) ?? "";
  } catch {
    return "";
  }
}

export function setOwnerKeyForChain(dbChain: string | null | undefined, key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ownerKeyStorageFor(dbChain), key);
  } catch {}
}

export function onOwnerKeyChangeForChain(
  dbChain: string | null | undefined,
  callback: (key: string) => void,
): () => void {
  if (typeof window === "undefined") return function() {};
  const storageKey = ownerKeyStorageFor(dbChain);
  function handler(e: StorageEvent) {
    if (e.key === storageKey) callback(e.newValue ?? "");
  }
  window.addEventListener("storage", handler);
  return function() { window.removeEventListener("storage", handler); };
}

export function getOwnerKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(OWNER_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setOwnerKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OWNER_KEY_STORAGE, key);
  } catch {}
}

// ⚠ EVERY chain slot starts with this, so the sign-out and account-switch
// paths can sweep the whole family by PREFIX and never go stale when a third
// chain ships. Enumerating chains in those files is how a leak gets built.
export const OWNER_KEY_PREFIX = OWNER_KEY_STORAGE;

// Remove the owner key for EVERY chain. ⛔ The single-key removal below was
// correct only while one chain existed: after 2026-09-19 a browser can hold a
// Flow key AND a Solana key, and a sign-out that clears one leaves the other
// for the NEXT account on that device — the exact defect
// lib/auth/device-keys.ts was written for (measured 2026-09-02: a brand-new
// account preloaded 15,160 Moments belonging to the previous collector).
export function clearAllOwnerKeys(): void {
  if (typeof window === "undefined") return;
  try {
    const ls = window.localStorage;
    const doomed: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(OWNER_KEY_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => ls.removeItem(k));
  } catch {}
}

export function clearOwnerKey(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(OWNER_KEY_STORAGE);
  } catch {}
}

// Subscribe to changes from other tabs.
// Returns an unsubscribe function.
export function onOwnerKeyChange(callback: (key: string) => void): () => void {
  if (typeof window === "undefined") return function() {};
  function handler(e: StorageEvent) {
    if (e.key === OWNER_KEY_STORAGE) {
      callback(e.newValue ?? "");
    }
  }
  window.addEventListener("storage", handler);
  return function() { window.removeEventListener("storage", handler); };
}